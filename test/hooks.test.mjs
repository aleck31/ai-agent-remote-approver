/**
 * Test module for src/hooks.mjs
 *
 * Coverage:
 * - runInit: generates topic, saves config, returns result (no hook registration)
 * - registerHook: creates settings.json, preserves existing settings/hooks,
 *   sets correct PermissionRequest hook structure
 * - getHookCommand: returns valid command string containing cli.mjs hook
 *
 * All tests should PASS against the current implementation.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInit, registerHook, getHookCommand, unregisterHook, isGloballyInstalled } from "../src/hooks.mjs";

// ===========================================================================
// runInit
// ===========================================================================

describe("runInit", () => {
  let tmpDir;
  let tmpConfigPath;
  let tmpSettingsPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cra-init-test-"));
    tmpConfigPath = path.join(tmpDir, ".remote-approver.json");
    tmpSettingsPath = path.join(tmpDir, "settings.json");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be a function", () => {
    assert.equal(typeof runInit, "function");
  });

  it("should generate a topic via the injected generateTopic", async () => {
    const generatedTopic = "cra-test1234abcd";
    let saveConfigCalledWith = null;

    const result = await runInit({
      configPath: tmpConfigPath,
      settingsPath: tmpSettingsPath,
      generateTopic: () => generatedTopic,
      saveConfig: (config, configPath) => {
        saveConfigCalledWith = { config, configPath };
      },
      loadConfig: () => ({ topic: "", ntfyServer: "https://ntfy.sh", timeout: 120, autoApprove: [], autoDeny: [] }),
    });

    assert.equal(result.topic, generatedTopic);
  });

  it("should save config with the new topic via the injected saveConfig", async () => {
    const generatedTopic = "cra-savetest1234";
    let savedConfig = null;
    let savedPath = null;

    await runInit({
      configPath: tmpConfigPath,
      settingsPath: tmpSettingsPath,
      generateTopic: () => generatedTopic,
      saveConfig: (config, configPath) => {
        savedConfig = config;
        savedPath = configPath;
      },
      loadConfig: () => ({ topic: "", ntfyServer: "https://ntfy.sh", timeout: 120, autoApprove: [], autoDeny: [] }),
    });

    assert.ok(savedConfig !== null, "saveConfig should have been called");
    assert.equal(savedConfig.topic, generatedTopic);
    assert.equal(savedPath, tmpConfigPath);
  });

  it("should NOT register any hook (that is enable's job)", async () => {
    if (fs.existsSync(tmpSettingsPath)) fs.unlinkSync(tmpSettingsPath);

    await runInit({
      configPath: tmpConfigPath,
      generateTopic: () => "cra-nohookreg1",
      saveConfig: () => {},
      loadConfig: () => ({ topic: "", ntfyServer: "https://ntfy.sh", timeout: 120, autoApprove: [], autoDeny: [] }),
    });

    // runInit only writes config; it must not touch settings.json.
    assert.ok(!fs.existsSync(tmpSettingsPath), "runInit must not create/register hooks in settings.json");
  });

  it("should return an object with topic and configPath (no hook registration)", async () => {
    const generatedTopic = "cra-returntest12";

    const result = await runInit({
      configPath: tmpConfigPath,
      generateTopic: () => generatedTopic,
      saveConfig: () => {},
      loadConfig: () => ({ topic: "", ntfyServer: "https://ntfy.sh", timeout: 120, autoApprove: [], autoDeny: [] }),
    });

    assert.equal(typeof result, "object");
    assert.equal(result.topic, generatedTopic);
    assert.equal(result.configPath, tmpConfigPath);
  });

  it("should return ntfyServer from the loaded config", async () => {
    const result = await runInit({
      configPath: tmpConfigPath,
      settingsPath: tmpSettingsPath,
      generateTopic: () => "cra-ntfyservertest",
      saveConfig: () => {},
      loadConfig: () => ({ topic: "", ntfyServer: "https://ntfy.example.com", timeout: 120, autoApprove: [], autoDeny: [] }),
    });

    assert.equal(result.ntfyServer, "https://ntfy.example.com");
  });

  // =========================================================================
  // Auth prompt during init (TDD Red phase — runInit doesn't accept prompt yet)
  // =========================================================================

  it("should prompt for auth and save credentials when user answers 'y'", async () => {
    let savedConfig = null;
    const promptResponses = ["y", "myuser", "mypass"];
    let promptIdx = 0;

    const result = await runInit({
      configPath: tmpConfigPath,
      settingsPath: tmpSettingsPath,
      generateTopic: () => "cra-authtest1",
      saveConfig: (config, path) => { savedConfig = config; },
      loadConfig: () => ({ topic: "", ntfyServer: "https://ntfy.sh", timeout: 120, ntfyUsername: "", ntfyPassword: "", autoApprove: [], autoDeny: [] }),
      prompt: async (question) => promptResponses[promptIdx++],
      promptSecret: async (question) => promptResponses[promptIdx++],
    });

    assert.equal(savedConfig.ntfyUsername, "myuser");
    assert.equal(savedConfig.ntfyPassword, "mypass");
  });

  it("should skip auth when user answers 'n'", async () => {
    let savedConfig = null;

    const result = await runInit({
      configPath: tmpConfigPath,
      settingsPath: tmpSettingsPath,
      generateTopic: () => "cra-authtest2",
      saveConfig: (config, path) => { savedConfig = config; },
      loadConfig: () => ({ topic: "", ntfyServer: "https://ntfy.sh", timeout: 120, ntfyUsername: "", ntfyPassword: "", autoApprove: [], autoDeny: [] }),
      prompt: async () => "n",
    });

    // ntfyUsername/ntfyPassword should remain unchanged (empty)
    assert.equal(savedConfig.ntfyUsername, "");
    assert.equal(savedConfig.ntfyPassword, "");
  });

  it("should skip auth when user presses Enter (empty response)", async () => {
    let savedConfig = null;

    const result = await runInit({
      configPath: tmpConfigPath,
      settingsPath: tmpSettingsPath,
      generateTopic: () => "cra-authtest3",
      saveConfig: (config, path) => { savedConfig = config; },
      loadConfig: () => ({ topic: "", ntfyServer: "https://ntfy.sh", timeout: 120, ntfyUsername: "", ntfyPassword: "", autoApprove: [], autoDeny: [] }),
      prompt: async () => "",
    });

    assert.equal(savedConfig.ntfyUsername, "");
    assert.equal(savedConfig.ntfyPassword, "");
  });
});

// ===========================================================================
// registerHook
// ===========================================================================

describe("registerHook", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cra-hook-test-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be a function", () => {
    assert.equal(typeof registerHook, "function");
  });

  it("should create settings.json if it does not exist", () => {
    const settingsPath = path.join(tmpDir, "create-test-settings.json");

    registerHook(settingsPath, "node /path/to/hook.mjs");

    assert.ok(
      fs.existsSync(settingsPath),
      "settings.json should have been created"
    );

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.ok(settings.hooks, "should have hooks property");
    assert.ok(
      Array.isArray(settings.hooks.PermissionRequest),
      "should have PermissionRequest array"
    );
  });

  it("should preserve existing settings when adding hook", () => {
    const settingsPath = path.join(tmpDir, "preserve-settings.json");
    const existingSettings = {
      autoUpdaterStatus: "disabled",
      permissions: { allow: ["Read"] },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));

    registerHook(settingsPath, "node /path/to/hook.mjs");

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(
      settings.autoUpdaterStatus,
      "disabled",
      "should preserve autoUpdaterStatus"
    );
    assert.deepEqual(
      settings.permissions,
      { allow: ["Read"] },
      "should preserve permissions"
    );
    assert.ok(settings.hooks, "should have added hooks");
  });

  it("should preserve other hooks (e.g., PreToolUse) when setting PermissionRequest", () => {
    const settingsPath = path.join(tmpDir, "preserve-hooks.json");
    const existingSettings = {
      hooks: {
        PreToolUse: [
          { type: "command", command: "echo pre-tool" },
        ],
        PostToolUse: [
          { type: "command", command: "echo post-tool" },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));

    registerHook(settingsPath, "node /path/to/hook.mjs");

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.deepEqual(
      settings.hooks.PreToolUse,
      [{ type: "command", command: "echo pre-tool" }],
      "should preserve PreToolUse hooks"
    );
    assert.deepEqual(
      settings.hooks.PostToolUse,
      [{ type: "command", command: "echo post-tool" }],
      "should preserve PostToolUse hooks"
    );
    assert.ok(
      settings.hooks.PermissionRequest,
      "should have added PermissionRequest hook"
    );
  });

  it("should set PermissionRequest to the correct hook structure", () => {
    const settingsPath = path.join(tmpDir, "structure-test.json");
    const hookCommand = "node /usr/local/lib/node_modules/remote-approver/src/hook.mjs";

    registerHook(settingsPath, hookCommand);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const permHook = settings.hooks.PermissionRequest;

    assert.ok(Array.isArray(permHook), "PermissionRequest should be an array");
    assert.equal(permHook.length, 1, "should have exactly one hook entry");
    assert.deepEqual(permHook[0], {
      hooks: [{ type: "command", command: hookCommand }],
    });
  });

  it("should update existing remote-approver hook in place", () => {
    const settingsPath = path.join(tmpDir, "overwrite-test.json");
    const existingSettings = {
      hooks: {
        PermissionRequest: [
          { hooks: [{ type: "command", command: "echo other-hook" }] },
          { hooks: [{ type: "command", command: "node /old/path/remote-approver/src/hook.mjs" }] },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));

    const newCommand = "node /new/path/remote-approver/src/hook.mjs";
    registerHook(settingsPath, newCommand);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(settings.hooks.PermissionRequest.length, 2, "should still have 2 entries");
    assert.deepEqual(
      settings.hooks.PermissionRequest[0].hooks[0].command,
      "echo other-hook",
      "non-remote-approver entry should be preserved"
    );
    assert.deepEqual(
      settings.hooks.PermissionRequest[1],
      { hooks: [{ type: "command", command: newCommand }] },
      "remote-approver entry should be updated in place"
    );
  });

  it("should preserve existing non-remote-approver PermissionRequest hooks", () => {
    const settingsPath = path.join(tmpDir, "preserve-perm-hooks.json");
    const existingSettings = {
      hooks: {
        PermissionRequest: [
          { hooks: [{ type: "command", command: "echo first-hook" }] },
          { hooks: [{ type: "command", command: "echo second-hook" }] },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));

    const newCommand = "node /path/to/remote-approver/src/hook.mjs";
    registerHook(settingsPath, newCommand);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(settings.hooks.PermissionRequest.length, 3, "should have 3 entries (2 existing + 1 new)");
    assert.equal(
      settings.hooks.PermissionRequest[0].hooks[0].command,
      "echo first-hook",
      "first existing hook should be preserved"
    );
    assert.equal(
      settings.hooks.PermissionRequest[1].hooks[0].command,
      "echo second-hook",
      "second existing hook should be preserved"
    );
    assert.deepEqual(
      settings.hooks.PermissionRequest[2],
      { hooks: [{ type: "command", command: newCommand }] },
      "new remote-approver hook should be appended"
    );
  });

  it("should upgrade legacy flat format to nested format", () => {
    const settingsPath = path.join(tmpDir, "upgrade-flat-test.json");
    const existingSettings = {
      hooks: {
        PermissionRequest: [
          { type: "command", command: "node /old/remote-approver/src/hook.mjs" },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));

    const newCommand = "node /new/remote-approver/src/hook.mjs";
    registerHook(settingsPath, newCommand);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(settings.hooks.PermissionRequest.length, 1, "should still have 1 entry");
    assert.deepEqual(
      settings.hooks.PermissionRequest[0],
      { hooks: [{ type: "command", command: newCommand }] },
      "legacy flat entry should be upgraded to nested format"
    );
  });
});

// ===========================================================================
// getHookCommand
// ===========================================================================

describe("isGloballyInstalled", () => {
  it("returns true when an remote-approver bin exists on the injected PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arp-path-"));
    try {
      fs.writeFileSync(path.join(dir, "remote-approver"), "#!/bin/sh\n", { mode: 0o755 });
      assert.equal(isGloballyInstalled({ PATH: dir }), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when no such bin is on PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arp-path-"));
    try {
      assert.equal(isGloballyInstalled({ PATH: dir }), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false for empty/absent PATH", () => {
    assert.equal(isGloballyInstalled({ PATH: "" }), false);
    assert.equal(isGloballyInstalled({}), false);
  });
});

describe("getHookCommand", () => {
  it("should be a function", () => {
    assert.equal(typeof getHookCommand, "function");
  });

  it("should end with 'hook' subcommand argument (either form)", () => {
    assert.ok(getHookCommand({ globallyInstalled: true }).endsWith(" hook"));
    assert.ok(getHookCommand({ globallyInstalled: false }).endsWith(" hook"));
  });

  // ---- Global install: stable command name (survives repo moves) ----

  describe("when installed globally on $PATH", () => {
    it("uses the stable 'remote-approver hook' command (no absolute path)", () => {
      const cmd = getHookCommand({ globallyInstalled: true });
      assert.equal(cmd, "remote-approver hook");
    });

    it("does not embed an absolute source path (so a repo move can't break it)", () => {
      const cmd = getHookCommand({ globallyInstalled: true });
      assert.ok(!cmd.includes("/"), `should not contain a path, got: "${cmd}"`);
      assert.ok(!cmd.includes("cli.mjs"), `should not reference cli.mjs, got: "${cmd}"`);
    });
  });

  // ---- Fallback: not installed globally, use absolute path to this checkout ----

  describe("when NOT installed globally (dev checkout)", () => {
    it("falls back to 'node \"<abs>/bin/cli.mjs\" hook'", () => {
      const cmd = getHookCommand({ globallyInstalled: false });
      assert.ok(cmd.startsWith("node "), `got: "${cmd}"`);
      assert.ok(cmd.endsWith(" hook"), `got: "${cmd}"`);
    });

    it("wraps an absolute bin/cli.mjs path in double quotes", () => {
      const cmd = getHookCommand({ globallyInstalled: false });
      const hookPath = cmd.replace(/^node\s+/, "").replace(/ hook$/, "").replace(/^"|"$/g, "");
      assert.ok(path.isAbsolute(hookPath), `should be absolute, got: "${hookPath}"`);
      assert.ok(hookPath.endsWith(path.join("bin", "cli.mjs")), `should end with bin/cli.mjs, got: "${hookPath}"`);
      const quoted = cmd.slice("node ".length).replace(/ hook$/, "");
      assert.ok(quoted.startsWith('"') && quoted.endsWith('"'), `path should be quoted, got: "${quoted}"`);
    });
  });

  // ---- Default (no arg): picks form based on real $PATH ----

  it("defaults to a form ending in ' hook' based on the actual environment", () => {
    const cmd = getHookCommand();
    assert.equal(typeof cmd, "string");
    assert.ok(cmd.endsWith(" hook"));
  });
});

// ===========================================================================
// unregisterHook
// ===========================================================================

describe("unregisterHook", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cra-unhook-test-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be a function", () => {
    assert.equal(typeof unregisterHook, "function");
  });

  it("should do nothing when settings file does not exist", () => {
    const settingsPath = path.join(tmpDir, "nonexistent-settings.json");

    // Should not throw
    assert.doesNotThrow(() => {
      unregisterHook(settingsPath);
    });

    // File should still not exist
    assert.equal(
      fs.existsSync(settingsPath),
      false,
      "settings file should not have been created"
    );
  });

  it("should do nothing when settings has no hooks", () => {
    const settingsPath = path.join(tmpDir, "no-hooks-settings.json");
    const original = { autoUpdaterStatus: "disabled" };
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    unregisterHook(settingsPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.deepEqual(
      settings,
      original,
      "settings should remain unchanged when no hooks exist"
    );
  });

  it("should do nothing when settings has no PermissionRequest", () => {
    const settingsPath = path.join(tmpDir, "no-perm-request-settings.json");
    const original = {
      hooks: {
        PreToolUse: [{ type: "command", command: "echo pre" }],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    unregisterHook(settingsPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.deepEqual(
      settings,
      original,
      "settings should remain unchanged when no PermissionRequest exists"
    );
  });

  it("should remove only remote-approver entries from PermissionRequest", () => {
    const settingsPath = path.join(tmpDir, "remove-cra-settings.json");
    const original = {
      hooks: {
        PermissionRequest: [
          { hooks: [{ type: "command", command: "echo other-hook" }] },
          { hooks: [{ type: "command", command: "node /path/remote-approver/src/hook.mjs" }] },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    unregisterHook(settingsPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(
      settings.hooks.PermissionRequest.length,
      1,
      "should have only 1 entry remaining"
    );
    assert.equal(
      settings.hooks.PermissionRequest[0].hooks[0].command,
      "echo other-hook",
      "non-remote-approver entry should remain"
    );
  });

  it("should preserve other hook types when removing PermissionRequest entries", () => {
    const settingsPath = path.join(tmpDir, "preserve-other-hooks-settings.json");
    const original = {
      hooks: {
        PreToolUse: [{ type: "command", command: "echo pre-tool" }],
        PermissionRequest: [
          { hooks: [{ type: "command", command: "echo other-hook" }] },
          { hooks: [{ type: "command", command: "node /path/remote-approver/src/hook.mjs" }] },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    unregisterHook(settingsPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.deepEqual(
      settings.hooks.PreToolUse,
      [{ type: "command", command: "echo pre-tool" }],
      "PreToolUse hooks should remain intact"
    );
    assert.equal(
      settings.hooks.PermissionRequest.length,
      1,
      "should have only non-remote-approver entry in PermissionRequest"
    );
    assert.equal(
      settings.hooks.PermissionRequest[0].hooks[0].command,
      "echo other-hook",
      "non-remote-approver entry should remain"
    );
  });

  it("should delete PermissionRequest key when array becomes empty", () => {
    const settingsPath = path.join(tmpDir, "delete-perm-key-settings.json");
    const original = {
      hooks: {
        PreToolUse: [{ type: "command", command: "echo pre-tool" }],
        PermissionRequest: [
          { hooks: [{ type: "command", command: "node /path/remote-approver/src/hook.mjs" }] },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    unregisterHook(settingsPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(
      settings.hooks.PermissionRequest,
      undefined,
      "PermissionRequest key should not exist when array becomes empty"
    );
    assert.deepEqual(
      settings.hooks.PreToolUse,
      [{ type: "command", command: "echo pre-tool" }],
      "PreToolUse hooks should remain"
    );
  });

  it("should delete hooks key when it becomes empty", () => {
    const settingsPath = path.join(tmpDir, "delete-hooks-key-settings.json");
    const original = {
      autoUpdaterStatus: "disabled",
      hooks: {
        PermissionRequest: [
          { hooks: [{ type: "command", command: "node /path/remote-approver/src/hook.mjs" }] },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    unregisterHook(settingsPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(
      settings.hooks,
      undefined,
      "hooks key should not exist when it becomes empty"
    );
    assert.equal(
      settings.autoUpdaterStatus,
      "disabled",
      "other top-level settings should remain"
    );
  });

  it("should remove legacy flat format entries", () => {
    const settingsPath = path.join(tmpDir, "remove-legacy-flat-settings.json");
    const original = {
      hooks: {
        PermissionRequest: [
          { type: "command", command: "node /path/remote-approver/src/hook.mjs" },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    unregisterHook(settingsPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(settings.hooks, undefined, "hooks key should be removed after clearing legacy flat entry");
  });
});
