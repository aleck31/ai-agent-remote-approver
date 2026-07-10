/**
 * Test suite for bin/cli.mjs
 *
 * Coverage:
 * - main(['setup'], deps) — calls runSetup with correct params
 * - main(['test'], deps) — loads config, sends test notification
 * - main(['test'], deps) — reports error when no topic configured
 * - main(['status'], deps) — loads config, writes settings to stdout
 * - main(['hook'], deps) — reads JSON from stdin, calls processHook, writes result to stdout
 * - main([], deps) / unknown command — writes help/usage to stderr
 * - main(['hook'], deps) — outputs valid JSON for allow decision
 * - main(['hook'], deps) — outputs valid JSON for deny decision
 * - main(['uninstall'], deps) — unregisters hook, deletes config, handles ENOENT
 * - main(['disable'], deps) — unregisters hook WITHOUT deleting config
 * - main(['enable'], deps) — loads config, registers hook when topic exists
 * - main(['test'], deps) — passes auth from resolveAuth to sendNotification
 * - main(['test'], deps) — does not include auth when resolveAuth returns null
 * - main(['status'], deps) — displays auth status (username visible, password hidden)
 * - main(['status'], deps) — displays "not configured" when auth is null
 *
 * TDD Red phase — auth-related tests must FAIL because main doesn't use resolveAuth yet.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { main } from "../bin/cli.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock stdout/stderr object that collects written strings.
 */
function createMockWriter() {
  const chunks = [];
  return {
    write(str) {
      chunks.push(str);
    },
    /** Returns all written output concatenated. */
    output() {
      return chunks.join("");
    },
    chunks,
  };
}

/**
 * Creates a full set of injected dependencies with sensible defaults.
 * Override individual entries as needed per test.
 */
function createDeps(overrides = {}) {
  const defaultConfig = {
    topic: "test-topic-abc",
    ntfyServer: "https://ntfy.sh",
    timeout: 120,
    autoApprove: [],
    autoDeny: [],
  };

  return {
    loadConfig: mock.fn(() => overrides.config ?? defaultConfig),
    saveConfig: mock.fn(() => {}),
    generateTopic: mock.fn(() => "cra-generated123"),
    sendNotification: mock.fn(async () => ({ ok: true, status: 200 })),
    resolveAuth: overrides.resolveAuth ?? mock.fn(() => null),
    randomUUID: overrides.randomUUID ?? mock.fn(() => "test-req-id"),
    buildAuthHeader: overrides.buildAuthHeader ?? mock.fn((a) => ({ Authorization: `Basic ${a.username}` })),
    // Mirror real waitForResponse: subscription is live, caller publishes via onReady.
    waitForResponse: mock.fn(
      async ({ onReady } = {}) => {
        if (onReady) await onReady();
        return overrides.waitResult ?? { approved: true };
      },
    ),
    formatToolInfo: mock.fn(
      () =>
        overrides.toolInfo ?? {
          title: "Claude Code: Bash",
          message: "echo hello",
        },
    ),
    processHook: mock.fn(
      async () =>
        overrides.hookResult ?? {
          hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
        },
    ),
    runSetup: mock.fn(
      async () =>
        overrides.setupResult ?? {
          topic: "cra-generated123",
          ntfyServer: "https://ntfy.sh",
          configPath: "/home/user/.agent-remote-approver.json",
          settingsPath: "/home/user/.claude/settings.json",
        },
    ),
    version: overrides.version ?? pkg.version,
    generateQR: overrides.generateQR ?? mock.fn((text, opts, cb) => cb("")),
    stdout: overrides.stdout ?? createMockWriter(),
    stderr: overrides.stderr ?? createMockWriter(),
    stdin: overrides.stdin ?? "",
    exit: mock.fn(() => {}),
    ...overrides,
  };
}

// ===========================================================================
// main — type check
// ===========================================================================

describe("main", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof main, "function");
  });

  // =========================================================================
  // setup subcommand
  // =========================================================================

  describe("setup subcommand", () => {
    it("should call runSetup when args is ['setup']", async () => {
      const deps = createDeps();

      await main(["setup"], deps);

      assert.equal(
        deps.runSetup.mock.callCount(),
        1,
        "runSetup should be called exactly once",
      );
    });

    it("should write the generated topic to stdout after setup", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout });

      await main(["setup"], deps);

      const output = stdout.output();
      assert.ok(
        output.includes("cra-generated123"),
        `stdout should contain the topic, got: ${output}`,
      );
    });

    it("should call generateQR with ntfy:// URL containing the topic", async () => {
      const deps = createDeps();
      await main(["setup"], deps);

      assert.equal(deps.generateQR.mock.callCount(), 1, "generateQR should be called exactly once");
      const [text] = deps.generateQR.mock.calls[0].arguments;
      assert.equal(text, "ntfy://ntfy.sh/cra-generated123", `QR text should be ntfy:// URL, got: ${text}`);
    });

    it("should write QR output from generateQR callback to stdout", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        generateQR: mock.fn((text, opts, cb) => cb("FAKE_QR_OUTPUT")),
      });
      await main(["setup"], deps);

      const output = stdout.output();
      assert.ok(output.includes("FAKE_QR_OUTPUT"), `stdout should contain QR output, got: ${output}`);
    });

    it("should write https:// subscribe URL to stdout", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout });
      await main(["setup"], deps);

      const output = stdout.output();
      assert.ok(
        output.includes("https://ntfy.sh/cra-generated123"),
        `stdout should contain https subscribe URL, got: ${output}`,
      );
    });

    it("should use custom ntfyServer host in QR URL when server is not ntfy.sh", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        setupResult: {
          topic: "cra-custom123",
          ntfyServer: "https://ntfy.example.com",
          configPath: "/home/user/.agent-remote-approver.json",
          settingsPath: "/home/user/.claude/settings.json",
        },
      });
      await main(["setup"], deps);

      assert.equal(deps.generateQR.mock.callCount(), 1);
      const [text] = deps.generateQR.mock.calls[0].arguments;
      assert.equal(text, "ntfy://ntfy.example.com/cra-custom123", `QR text should use custom host, got: ${text}`);

      const output = stdout.output();
      assert.ok(
        output.includes("https://ntfy.example.com/cra-custom123"),
        `stdout should contain custom https URL, got: ${output}`,
      );
    });

    it("should use ntfy:// URL with secure=false in QR code when ntfyServer is HTTP", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        setupResult: {
          topic: "cra-selfhost123",
          ntfyServer: "http://192.168.1.100:8080",
          configPath: "/home/user/.agent-remote-approver.json",
          settingsPath: "/home/user/.claude/settings.json",
        },
      });
      await main(["setup"], deps);

      assert.equal(deps.generateQR.mock.callCount(), 1);
      const [text] = deps.generateQR.mock.calls[0].arguments;
      assert.equal(text, "ntfy://192.168.1.100:8080/cra-selfhost123?secure=false", `QR text should use ntfy:// with secure=false for HTTP server, got: ${text}`);

      const output = stdout.output();
      assert.ok(
        output.includes("http://192.168.1.100:8080/cra-selfhost123"),
        `stdout should contain http subscribe URL, got: ${output}`,
      );
    });

    it("should handle invalid ntfyServer URL gracefully without crashing", async () => {
      const stdout = createMockWriter();
      const stderr = createMockWriter();
      const deps = createDeps({
        stdout,
        stderr,
        setupResult: {
          topic: "cra-invalidurl123",
          ntfyServer: "not-a-valid-url",
          configPath: "/home/user/.agent-remote-approver.json",
          settingsPath: "/home/user/.claude/settings.json",
        },
      });

      // Should not throw
      await assert.doesNotReject(async () => {
        await main(["setup"], deps);
      });

      const errOutput = stderr.output();
      assert.ok(
        errOutput.includes("Warning") && errOutput.includes("not-a-valid-url"),
        `stderr should contain a warning about the invalid URL, got: ${errOutput}`,
      );

      const output = stdout.output();
      assert.ok(output.includes("cra-invalidurl123"), `stdout should still contain the topic, got: ${output}`);
    });
  });

  // =========================================================================
  // test subcommand
  // =========================================================================

  describe("test subcommand", () => {
    it("should load config and call sendNotification with a test message", async () => {
      const deps = createDeps();

      await main(["test"], deps);

      assert.equal(
        deps.loadConfig.mock.callCount(),
        1,
        "loadConfig should be called once",
      );
      assert.equal(
        deps.sendNotification.mock.callCount(),
        1,
        "sendNotification should be called once",
      );

      const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
      assert.equal(callArgs.topic, "test-topic-abc");
      assert.equal(callArgs.server, "https://ntfy.sh");
    });

    it("should write error to stderr when sendNotification throws", async () => {
      const stdout = createMockWriter();
      const stderr = createMockWriter();
      const deps = createDeps({
        stdout,
        stderr,
        sendNotification: mock.fn(async () => {
          throw new Error("network timeout");
        }),
      });

      await main(["test"], deps);

      const errOutput = stderr.output();
      assert.ok(
        errOutput.includes("Failed to send notification"),
        `stderr should contain failure message, got: ${errOutput}`,
      );
      assert.ok(
        errOutput.includes("network timeout"),
        `stderr should contain the error message, got: ${errOutput}`,
      );
      assert.equal(
        stdout.output().includes("sent successfully"),
        false,
        "stdout should NOT contain success message when notification fails",
      );
    });

    it("should report error to stderr when config has no topic", async () => {
      const stderr = createMockWriter();
      const noTopicConfig = {
        topic: "",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
        autoApprove: [],
        autoDeny: [],
      };
      const deps = createDeps({ config: noTopicConfig, stderr });

      await main(["test"], deps);

      const output = stderr.output();
      assert.ok(
        output.length > 0,
        "stderr should contain an error message when topic is empty",
      );
      assert.equal(
        deps.sendNotification.mock.callCount(),
        0,
        "sendNotification should NOT be called when topic is empty",
      );
    });

    it("should pass auth to sendNotification when resolveAuth returns credentials", async () => {
      const auth = { username: "testuser", password: "testpass" };
      const deps = createDeps({
        resolveAuth: mock.fn(() => auth),
      });

      await main(["test"], deps);

      const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
      assert.deepEqual(callArgs.auth, auth);
    });

    it("should not include auth in sendNotification when resolveAuth returns null", async () => {
      const deps = createDeps({
        resolveAuth: mock.fn(() => null),
      });

      await main(["test"], deps);

      const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
      assert.equal(callArgs.auth, null);
    });

    it("plain test hints at --wait for round-trip verification", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout });

      await main(["test"], deps);

      assert.ok(stdout.output().includes("--wait"), `should hint at --wait, got: ${stdout.output()}`);
      assert.equal(deps.waitForResponse.mock.callCount(), 0, "plain test should not wait for a response");
    });
  });

  // =========================================================================
  // test --wait subcommand (round-trip verification)
  // =========================================================================

  describe("test --wait subcommand", () => {
    it("publishes via onReady (subscribe-first) and reports OK on Ack", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout, waitResult: { answer: "ack" } });

      await main(["test", "--wait"], deps);

      assert.equal(deps.waitForResponse.mock.callCount(), 1, "should wait for the round trip");
      assert.equal(deps.sendNotification.mock.callCount(), 1, "should publish exactly once (via onReady)");
      // The Ack notification carries the Ack action and the same requestId used to wait.
      const sent = deps.sendNotification.mock.calls[0].arguments[0];
      assert.equal(sent.actions.length, 1);
      assert.equal(sent.actions[0].label, "Ack");
      assert.equal(sent.requestId, deps.waitForResponse.mock.calls[0].arguments[0].requestId);
      assert.ok(stdout.output().includes("Round-trip OK"), `should report success, got: ${stdout.output()}`);
    });

    it("reports failure (no crash) on timeout", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout, waitResult: { timeout: true } });

      await main(["test", "--wait"], deps);

      const out = stdout.output();
      assert.ok(out.includes("No Ack received") && out.includes("timed out"), `should report timeout, got: ${out}`);
    });

    it("uses config.timeout (in ms) for the wait", async () => {
      const deps = createDeps({
        config: { topic: "t", ntfyServer: "https://ntfy.sh", timeout: 90 },
        waitResult: { answer: "ack" },
      });

      await main(["test", "--wait"], deps);

      assert.equal(deps.waitForResponse.mock.calls[0].arguments[0].timeout, 90000);
    });

    it("attaches auth headers to the Ack action when resolveAuth returns credentials", async () => {
      const deps = createDeps({
        resolveAuth: mock.fn(() => ({ username: "u", password: "p" })),
        waitResult: { answer: "ack" },
      });

      await main(["test", "--wait"], deps);

      const sent = deps.sendNotification.mock.calls[0].arguments[0];
      assert.ok(sent.actions[0].headers, "Ack action should carry auth headers");
      assert.deepEqual(sent.actions[0].headers, { Authorization: "Basic u" });
      // and the wait itself is authenticated
      assert.deepEqual(deps.waitForResponse.mock.calls[0].arguments[0].auth, { username: "u", password: "p" });
    });

    it("reports error to stderr when waitForResponse rejects", async () => {
      const stdout = createMockWriter();
      const stderr = createMockWriter();
      const deps = createDeps({
        stdout,
        stderr,
        waitForResponse: mock.fn(async () => { throw new Error("SSE connect failed"); }),
      });

      await main(["test", "--wait"], deps);

      assert.ok(stderr.output().includes("Round-trip test failed"), `got: ${stderr.output()}`);
      assert.ok(stderr.output().includes("SSE connect failed"), `got: ${stderr.output()}`);
    });

    it("errors when no topic is configured (no wait attempted)", async () => {
      const stderr = createMockWriter();
      const deps = createDeps({
        config: { topic: "", ntfyServer: "https://ntfy.sh", timeout: 120 },
        stderr,
      });

      await main(["test", "--wait"], deps);

      assert.equal(deps.waitForResponse.mock.callCount(), 0);
      assert.ok(stderr.output().length > 0);
    });
  });

  // =========================================================================
  // status subcommand
  // =========================================================================

  describe("status subcommand", () => {
    it("should load config and write settings to stdout", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout });

      await main(["status"], deps);

      assert.equal(
        deps.loadConfig.mock.callCount(),
        1,
        "loadConfig should be called once",
      );

      const output = stdout.output();
      assert.ok(
        output.includes("test-topic-abc"),
        `stdout should contain the topic, got: ${output}`,
      );
      assert.ok(
        output.includes("https://ntfy.sh"),
        `stdout should contain the server URL, got: ${output}`,
      );
    });

    it("should display auth status when auth is configured", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        resolveAuth: mock.fn(() => ({ username: "myuser", password: "secret" })),
      });

      await main(["status"], deps);

      const output = stdout.output();
      assert.ok(output.includes("Auth:"), `Should show Auth line, got: ${output}`);
      assert.ok(output.includes("myuser"), `Should show username, got: ${output}`);
      assert.ok(!output.includes("secret"), `Should NOT show password, got: ${output}`);
    });

    it("should display 'not configured' when auth is not configured", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        resolveAuth: mock.fn(() => null),
      });

      await main(["status"], deps);

      const output = stdout.output();
      assert.ok(output.includes("not configured"), `Should show not configured, got: ${output}`);
    });
  });

  // =========================================================================
  // hook subcommand
  // =========================================================================

  describe("hook subcommand", () => {
    it("should read JSON from stdin, call processHook, and write result to stdout", async () => {
      const hookInput = {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
      };
      const stdout = createMockWriter();
      const deps = createDeps({
        stdin: JSON.stringify(hookInput),
        stdout,
      });

      await main(["hook"], deps);

      assert.equal(
        deps.processHook.mock.callCount(),
        1,
        "processHook should be called exactly once",
      );

      // Verify the input passed to processHook
      const callArgs = deps.processHook.mock.calls[0].arguments[0];
      assert.equal(callArgs.tool_name, "Bash");
      assert.deepEqual(callArgs.tool_input, { command: "ls -la" });
    });

    it("should output valid JSON for allow decision", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdin: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "echo allowed" },
        }),
        stdout,
        hookResult: {
          hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
        },
      });

      await main(["hook"], deps);

      const output = stdout.output();
      assert.ok(output.endsWith("\n"), "hook output should end with a newline");
      const parsed = JSON.parse(output);
      assert.equal(parsed.hookSpecificOutput.decision.behavior, "allow");
    });

    it("should output valid JSON for deny decision", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdin: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "rm -rf /" },
        }),
        stdout,
        hookResult: {
          hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny" } },
        },
      });

      await main(["hook"], deps);

      const output = stdout.output();
      assert.ok(output.endsWith("\n"), "hook output should end with a newline");
      const parsed = JSON.parse(output);
      assert.equal(parsed.hookSpecificOutput.decision.behavior, "deny");
    });

    it("should output ask JSON when stdin contains malformed JSON", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdin: "this is not valid json{{{",
        stdout,
      });

      await main(["hook"], deps);

      const output = stdout.output();
      assert.ok(output.endsWith("\n"), "hook output should end with a newline");
      const parsed = JSON.parse(output);
      assert.equal(parsed.hookSpecificOutput.decision.behavior, "ask");
      assert.equal(parsed.hookSpecificOutput.hookEventName, "PermissionRequest");
      assert.equal(
        deps.processHook.mock.callCount(),
        0,
        "processHook should NOT be called when JSON parsing fails",
      );
    });

    it("should output ask JSON when processHook throws an error", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdin: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "ls" },
        }),
        stdout,
        processHook: mock.fn(async () => {
          throw new Error("processHook failed");
        }),
      });

      await main(["hook"], deps);

      const output = stdout.output();
      assert.ok(output.endsWith("\n"), "hook output should end with a newline");
      const parsed = JSON.parse(output);
      assert.equal(parsed.hookSpecificOutput.decision.behavior, "ask");
      assert.equal(parsed.hookSpecificOutput.hookEventName, "PermissionRequest");
    });

    it("should write fallback message to stderr when stdin contains malformed JSON", async () => {
      const stdout = createMockWriter();
      const stderr = createMockWriter();
      const deps = createDeps({
        stdin: "this is not valid json{{{",
        stdout,
        stderr,
      });

      await main(["hook"], deps);

      const errOutput = stderr.output();
      assert.ok(
        errOutput.includes("[agent-remote-approver]") && errOutput.includes("Invalid hook input"),
        `stderr should contain prefixed fallback message, got: ${errOutput}`,
      );
    });

    it("should write fallback message to stderr when processHook throws an error", async () => {
      const stdout = createMockWriter();
      const stderr = createMockWriter();
      const deps = createDeps({
        stdin: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "ls" },
        }),
        stdout,
        stderr,
        processHook: mock.fn(async () => {
          throw new Error("processHook failed");
        }),
      });

      await main(["hook"], deps);

      const errOutput = stderr.output();
      assert.ok(
        errOutput.includes("[agent-remote-approver]") && errOutput.includes("Hook processing failed"),
        `stderr should contain prefixed fallback message, got: ${errOutput}`,
      );
    });
  });

  // =========================================================================
  // uninstall subcommand
  // =========================================================================

  describe("uninstall subcommand", () => {
    it("should call unregisterHook with settingsPath", async () => {
      const deps = createDeps({
        unregisterHook: mock.fn(() => {}),
        settingsPath: "/fake/settings.json",
        unlinkSync: mock.fn(() => {}),
        configPath: "/fake/config.json",
      });

      await main(["uninstall"], deps);

      assert.equal(
        deps.unregisterHook.mock.callCount(),
        1,
        "unregisterHook should be called exactly once",
      );
      assert.equal(
        deps.unregisterHook.mock.calls[0].arguments[0],
        "/fake/settings.json",
        "unregisterHook should be called with settingsPath",
      );
    });

    it("should delete config file via unlinkSync", async () => {
      const deps = createDeps({
        unregisterHook: mock.fn(() => {}),
        settingsPath: "/fake/settings.json",
        unlinkSync: mock.fn(() => {}),
        configPath: "/fake/config.json",
      });

      await main(["uninstall"], deps);

      assert.equal(
        deps.unlinkSync.mock.callCount(),
        1,
        "unlinkSync should be called exactly once",
      );
      assert.equal(
        deps.unlinkSync.mock.calls[0].arguments[0],
        "/fake/config.json",
        "unlinkSync should be called with configPath",
      );
    });

    it("should ignore ENOENT when config file does not exist", async () => {
      const deps = createDeps({
        unregisterHook: mock.fn(() => {}),
        settingsPath: "/fake/settings.json",
        unlinkSync: mock.fn(() => {
          const err = new Error("ENOENT");
          err.code = "ENOENT";
          throw err;
        }),
        configPath: "/fake/config.json",
      });

      // Should not throw
      await assert.doesNotReject(async () => {
        await main(["uninstall"], deps);
      });
    });

    it("should write completion message to stdout", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        unregisterHook: mock.fn(() => {}),
        settingsPath: "/fake/settings.json",
        unlinkSync: mock.fn(() => {}),
        configPath: "/fake/config.json",
      });

      await main(["uninstall"], deps);

      const output = stdout.output();
      assert.ok(
        output.length > 0,
        "stdout should contain a completion message",
      );
      assert.ok(
        !output.toLowerCase().includes("error"),
        `stdout should not contain error messages, got: ${output}`,
      );
    });
  });

  // =========================================================================
  // disable subcommand
  // =========================================================================

  describe("disable subcommand", () => {
    it("should call unregisterHook with settingsPath", async () => {
      const deps = createDeps({
        unregisterHook: mock.fn(() => {}),
        settingsPath: "/fake/settings.json",
        unlinkSync: mock.fn(() => {}),
        configPath: "/fake/config.json",
      });

      await main(["disable"], deps);

      assert.equal(
        deps.unregisterHook.mock.callCount(),
        1,
        "unregisterHook should be called exactly once",
      );
      assert.equal(
        deps.unregisterHook.mock.calls[0].arguments[0],
        "/fake/settings.json",
        "unregisterHook should be called with settingsPath",
      );
    });

    it("should NOT delete config file", async () => {
      const deps = createDeps({
        unregisterHook: mock.fn(() => {}),
        settingsPath: "/fake/settings.json",
        unlinkSync: mock.fn(() => {}),
        configPath: "/fake/config.json",
      });

      await main(["disable"], deps);

      assert.equal(
        deps.unlinkSync.mock.callCount(),
        0,
        "unlinkSync should NOT be called for disable (config is preserved)",
      );
    });

    it("should write completion message to stdout mentioning enable", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        unregisterHook: mock.fn(() => {}),
        settingsPath: "/fake/settings.json",
        unlinkSync: mock.fn(() => {}),
        configPath: "/fake/config.json",
      });

      await main(["disable"], deps);

      const output = stdout.output().toLowerCase();
      assert.ok(
        output.includes("enable"),
        `stdout should mention 'enable' as a hint for re-enabling, got: ${stdout.output()}`,
      );
    });
  });

  // =========================================================================
  // enable subcommand
  // =========================================================================

  describe("enable subcommand", () => {
    it("should call loadConfig and registerHook when topic is configured", async () => {
      const deps = createDeps({
        loadConfig: mock.fn(() => ({
          topic: "cra-abc123",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
        })),
        registerHook: mock.fn(() => {}),
        getHookCommand: mock.fn(() => "node /path/hook.mjs"),
        settingsPath: "/fake/settings.json",
      });

      await main(["enable"], deps);

      assert.equal(
        deps.registerHook.mock.callCount(),
        1,
        "registerHook should be called exactly once",
      );
      assert.equal(
        deps.registerHook.mock.calls[0].arguments[0],
        "/fake/settings.json",
        "registerHook first arg should be settingsPath",
      );
      assert.equal(
        deps.registerHook.mock.calls[0].arguments[1],
        "node /path/hook.mjs",
        "registerHook second arg should be the hook command",
      );
    });

    it("should write error to stderr when no topic is configured", async () => {
      const stdout = createMockWriter();
      const stderr = createMockWriter();
      const deps = createDeps({
        stdout,
        stderr,
        loadConfig: mock.fn(() => ({
          topic: "",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
        })),
        registerHook: mock.fn(() => {}),
        getHookCommand: mock.fn(() => "node /path/hook.mjs"),
        settingsPath: "/fake/settings.json",
      });

      await main(["enable"], deps);

      assert.equal(
        deps.registerHook.mock.callCount(),
        0,
        "registerHook should NOT be called when topic is empty",
      );

      const errOutput = stderr.output();
      assert.ok(
        errOutput.length > 0,
        `stderr should contain an error message when topic is empty, got: ${errOutput}`,
      );
    });

    it("should write completion message to stdout on success", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        loadConfig: mock.fn(() => ({
          topic: "cra-abc123",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
        })),
        registerHook: mock.fn(() => {}),
        getHookCommand: mock.fn(() => "node /path/hook.mjs"),
        settingsPath: "/fake/settings.json",
      });

      await main(["enable"], deps);

      const output = stdout.output();
      assert.ok(
        output.length > 0,
        `stdout should contain a completion message, got: ${output}`,
      );
    });
  });

  // =========================================================================
  // --help and --version flags
  // =========================================================================

  describe("--help and --version flags", () => {
    it("should output usage to stdout when --help is passed", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout });

      await main(["--help"], deps);

      const output = stdout.output();
      assert.ok(
        output.includes("Usage:"),
        `stdout should contain usage text, got: ${output}`,
      );
      assert.ok(
        output.includes("setup"),
        `stdout should mention setup command, got: ${output}`,
      );
      assert.equal(
        deps.exit.mock.callCount(),
        0,
        "exit should NOT be called for --help",
      );
    });

    it("should output usage to stdout when -h is passed", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout });

      await main(["-h"], deps);

      const output = stdout.output();
      assert.ok(
        output.includes("Usage:"),
        `stdout should contain usage text for -h, got: ${output}`,
      );
    });

    it("should output version to stdout when --version is passed", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout });

      await main(["--version"], deps);

      const output = stdout.output().trim();
      assert.ok(/^\d+\.\d+\.\d+$/.test(output), `should output a semver version, got: ${output}`);
    });

    it("should output version to stdout when -v is passed", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout });

      await main(["-v"], deps);

      const output = stdout.output().trim();
      assert.ok(/^\d+\.\d+\.\d+$/.test(output), `should output a semver version, got: ${output}`);
    });

    it("should output version that matches package.json", async () => {
      const { readFileSync } = await import("node:fs");
      const { resolve, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

      const stdout = createMockWriter();
      const deps = createDeps({ stdout });
      await main(["--version"], deps);

      const output = stdout.output().trim();
      assert.equal(output, pkg.version, `CLI version should match package.json version, got: ${output}`);
    });

    it("should include enable, disable, and uninstall in help text", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout });

      await main(["--help"], deps);

      const output = stdout.output();
      assert.ok(
        output.includes("enable"),
        `help text should mention 'enable', got: ${output}`,
      );
      assert.ok(
        output.includes("disable"),
        `help text should mention 'disable', got: ${output}`,
      );
      assert.ok(
        output.includes("uninstall"),
        `help text should mention 'uninstall', got: ${output}`,
      );
    });
  });

  // =========================================================================
  // no args / unknown command
  // =========================================================================

  describe("no args or unknown command", () => {
    it("should write usage/help to stderr when called with no args", async () => {
      const stderr = createMockWriter();
      const deps = createDeps({ stderr });

      await main([], deps);

      const output = stderr.output();
      assert.ok(
        output.length > 0,
        "stderr should contain usage information when no args given",
      );
    });

    it("should write usage/help to stderr when called with unknown command", async () => {
      const stderr = createMockWriter();
      const deps = createDeps({ stderr });

      await main(["foobar"], deps);

      const output = stderr.output();
      assert.ok(
        output.length > 0,
        "stderr should contain usage information for unknown command",
      );
    });

    it("should call exit with non-zero code for unknown command", async () => {
      const deps = createDeps();

      await main(["unknown-cmd"], deps);

      assert.equal(
        deps.exit.mock.callCount(),
        1,
        "exit should be called once for unknown command",
      );
      assert.equal(
        deps.exit.mock.calls[0].arguments[0],
        1,
        "exit code should be 1",
      );
    });
  });
});
