/**
 * Test module for src/setup.mjs
 *
 * Coverage:
 * - runSetup: generates topic, saves config, registers hook, returns result
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
import { runSetup, registerHook, getHookCommand, unregisterHook } from "../src/setup.mjs";

// ===========================================================================
// runSetup
// ===========================================================================

describe("runSetup", () => {
  let tmpDir;
  let tmpConfigPath;
  let tmpSettingsPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cra-setup-test-"));
    tmpConfigPath = path.join(tmpDir, ".agent-remote-approver.json");
    tmpSettingsPath = path.join(tmpDir, "settings.json");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be a function", () => {
    assert.equal(typeof runSetup, "function");
  });

  it("should generate a topic via the injected generateTopic", async () => {
    const generatedTopic = "cra-test1234abcd";
    let saveConfigCalledWith = null;

    const result = await runSetup({
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

    await runSetup({
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

  it("should register the hook in settings.json at settingsPath", async () => {
    // Clean up settings file before test
    if (fs.existsSync(tmpSettingsPath)) {
      fs.unlinkSync(tmpSettingsPath);
    }

    await runSetup({
      configPath: tmpConfigPath,
      settingsPath: tmpSettingsPath,
      generateTopic: () => "cra-hookregtest1",
      saveConfig: () => {},
      loadConfig: () => ({ topic: "", ntfyServer: "https://ntfy.sh", timeout: 120, autoApprove: [], autoDeny: [] }),
    });

    // settings.json should exist after setup
    assert.ok(fs.existsSync(tmpSettingsPath), "settings.json should have been created");

    const settings = JSON.parse(fs.readFileSync(tmpSettingsPath, "utf-8"));
    assert.ok(settings.hooks, "settings should have a hooks property");
    assert.ok(
      settings.hooks.PermissionRequest,
      "hooks should have a PermissionRequest property"
    );
    assert.ok(
      Array.isArray(settings.hooks.PermissionRequest),
      "PermissionRequest should be an array"
    );
    assert.equal(settings.hooks.PermissionRequest.length, 1);
    assert.ok(
      Array.isArray(settings.hooks.PermissionRequest[0].hooks),
      "entry should have a hooks array"
    );
    assert.equal(settings.hooks.PermissionRequest[0].hooks[0].type, "command");
    assert.ok(
      settings.hooks.PermissionRequest[0].hooks[0].command.includes("cli.mjs"),
      `hook command should include "cli.mjs", got: "${settings.hooks.PermissionRequest[0].hooks[0].command}"`
    );

    // Stop hook is registered too (behavior gated by config.notifyOnStop)
    assert.ok(Array.isArray(settings.hooks.Stop), "hooks should have a Stop array");
    assert.equal(settings.hooks.Stop.length, 1);
    assert.ok(
      settings.hooks.Stop[0].hooks[0].command.includes("cli.mjs"),
      `Stop hook command should include "cli.mjs", got: "${settings.hooks.Stop[0].hooks[0].command}"`
    );
  });

  it("should return an object with topic, configPath, and settingsPath", async () => {
    const generatedTopic = "cra-returntest12";

    const result = await runSetup({
      configPath: tmpConfigPath,
      settingsPath: tmpSettingsPath,
      generateTopic: () => generatedTopic,
      saveConfig: () => {},
      loadConfig: () => ({ topic: "", ntfyServer: "https://ntfy.sh", timeout: 120, autoApprove: [], autoDeny: [] }),
    });

    assert.equal(typeof result, "object");
    assert.equal(result.topic, generatedTopic);
    assert.equal(result.configPath, tmpConfigPath);
    assert.equal(result.settingsPath, tmpSettingsPath);
  });

  it("should return ntfyServer from the loaded config", async () => {
    const result = await runSetup({
      configPath: tmpConfigPath,
      settingsPath: tmpSettingsPath,
      generateTopic: () => "cra-ntfyservertest",
      saveConfig: () => {},
      loadConfig: () => ({ topic: "", ntfyServer: "https://ntfy.example.com", timeout: 120, autoApprove: [], autoDeny: [] }),
    });

    assert.equal(result.ntfyServer, "https://ntfy.example.com");
  });

  // =========================================================================
  // Auth prompt during setup (TDD Red phase — runSetup doesn't accept prompt yet)
  // =========================================================================

  it("should prompt for auth and save credentials when user answers 'y'", async () => {
    let savedConfig = null;
    const promptResponses = ["y", "myuser", "mypass"];
    let promptIdx = 0;

    const result = await runSetup({
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

    const result = await runSetup({
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

    const result = await runSetup({
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
    const hookCommand = "node /usr/local/lib/node_modules/agent-remote-approver/src/hook.mjs";

    registerHook(settingsPath, hookCommand);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const permHook = settings.hooks.PermissionRequest;

    assert.ok(Array.isArray(permHook), "PermissionRequest should be an array");
    assert.equal(permHook.length, 1, "should have exactly one hook entry");
    assert.deepEqual(permHook[0], {
      hooks: [{ type: "command", command: hookCommand }],
    });
  });

  it("should update existing agent-remote-approver hook in place", () => {
    const settingsPath = path.join(tmpDir, "overwrite-test.json");
    const existingSettings = {
      hooks: {
        PermissionRequest: [
          { hooks: [{ type: "command", command: "echo other-hook" }] },
          { hooks: [{ type: "command", command: "node /old/path/agent-remote-approver/src/hook.mjs" }] },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));

    const newCommand = "node /new/path/agent-remote-approver/src/hook.mjs";
    registerHook(settingsPath, newCommand);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(settings.hooks.PermissionRequest.length, 2, "should still have 2 entries");
    assert.deepEqual(
      settings.hooks.PermissionRequest[0].hooks[0].command,
      "echo other-hook",
      "non-agent-remote-approver entry should be preserved"
    );
    assert.deepEqual(
      settings.hooks.PermissionRequest[1],
      { hooks: [{ type: "command", command: newCommand }] },
      "agent-remote-approver entry should be updated in place"
    );
  });

  it("should preserve existing non-agent-remote-approver PermissionRequest hooks", () => {
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

    const newCommand = "node /path/to/agent-remote-approver/src/hook.mjs";
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
      "new agent-remote-approver hook should be appended"
    );
  });

  it("should upgrade legacy flat format to nested format", () => {
    const settingsPath = path.join(tmpDir, "upgrade-flat-test.json");
    const existingSettings = {
      hooks: {
        PermissionRequest: [
          { type: "command", command: "node /old/agent-remote-approver/src/hook.mjs" },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));

    const newCommand = "node /new/agent-remote-approver/src/hook.mjs";
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

describe("getHookCommand", () => {
  it("should be a function", () => {
    assert.equal(typeof getHookCommand, "function");
  });

  it("should return a string", () => {
    const cmd = getHookCommand();
    assert.equal(typeof cmd, "string");
  });

  it("should start with 'node '", () => {
    const cmd = getHookCommand();
    assert.ok(
      cmd.startsWith("node "),
      `Command should start with "node ", got: "${cmd}"`
    );
  });

  it("should contain cli.mjs in the path", () => {
    const cmd = getHookCommand();
    assert.ok(
      cmd.includes("cli.mjs"),
      `Command should include "cli.mjs", got: "${cmd}"`
    );
  });

  it("should end with 'hook' subcommand argument", () => {
    const cmd = getHookCommand();
    assert.ok(
      cmd.endsWith(" hook"),
      `Command should end with " hook", got: "${cmd}"`
    );
  });

  it("should wrap the path in double quotes", () => {
    const cmd = getHookCommand();
    // After "node ", strip the trailing " hook" to isolate the quoted path
    const quotedPath = cmd.slice("node ".length).replace(/ hook$/, "");
    assert.ok(
      quotedPath.startsWith('"') && quotedPath.endsWith('"'),
      `Path should be wrapped in double quotes, got: "${quotedPath}"`
    );
  });

  it("should contain an absolute path (starts with /)", () => {
    const cmd = getHookCommand();
    // Extract the path: strip "node ", trailing " hook", and surrounding quotes
    const hookPath = cmd.replace(/^node\s+/, "").replace(/ hook$/, "").replace(/^"|"$/g, "");
    assert.ok(
      path.isAbsolute(hookPath),
      `Hook path should be absolute, got: "${hookPath}"`
    );
  });

  it("should point to bin/cli.mjs relative to the package root", () => {
    const cmd = getHookCommand();
    const hookPath = cmd.replace(/^node\s+/, "").replace(/ hook$/, "").replace(/^"|"$/g, "");
    assert.ok(
      hookPath.endsWith(path.join("bin", "cli.mjs")),
      `Hook path should end with "bin/cli.mjs", got: "${hookPath}"`
    );
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

  it("should remove only agent-remote-approver entries from PermissionRequest", () => {
    const settingsPath = path.join(tmpDir, "remove-cra-settings.json");
    const original = {
      hooks: {
        PermissionRequest: [
          { hooks: [{ type: "command", command: "echo other-hook" }] },
          { hooks: [{ type: "command", command: "node /path/agent-remote-approver/src/hook.mjs" }] },
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
      "non-agent-remote-approver entry should remain"
    );
  });

  it("should preserve other hook types when removing PermissionRequest entries", () => {
    const settingsPath = path.join(tmpDir, "preserve-other-hooks-settings.json");
    const original = {
      hooks: {
        PreToolUse: [{ type: "command", command: "echo pre-tool" }],
        PermissionRequest: [
          { hooks: [{ type: "command", command: "echo other-hook" }] },
          { hooks: [{ type: "command", command: "node /path/agent-remote-approver/src/hook.mjs" }] },
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
      "should have only non-agent-remote-approver entry in PermissionRequest"
    );
    assert.equal(
      settings.hooks.PermissionRequest[0].hooks[0].command,
      "echo other-hook",
      "non-agent-remote-approver entry should remain"
    );
  });

  it("should delete PermissionRequest key when array becomes empty", () => {
    const settingsPath = path.join(tmpDir, "delete-perm-key-settings.json");
    const original = {
      hooks: {
        PreToolUse: [{ type: "command", command: "echo pre-tool" }],
        PermissionRequest: [
          { hooks: [{ type: "command", command: "node /path/agent-remote-approver/src/hook.mjs" }] },
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
          { hooks: [{ type: "command", command: "node /path/agent-remote-approver/src/hook.mjs" }] },
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
          { type: "command", command: "node /path/agent-remote-approver/src/hook.mjs" },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    unregisterHook(settingsPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(settings.hooks, undefined, "hooks key should be removed after clearing legacy flat entry");
  });
});
