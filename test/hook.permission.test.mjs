/**
 * Test suite for src/adapters/claude-code.mjs — processHook permission flow
 *
 * Coverage:
 * - processHook (main describe)
 * - processHook Stop routing
 * - processHook resolved-notification update
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { processHook, _internal } from "../src/adapters/claude-code.mjs";
import { createDeps, sampleInput } from "./helpers.mjs";

// Dynamic import helper — buildAuthHeader does not exist yet (TDD Red phase).
// Using a lazy getter avoids a static import error that would prevent ALL tests from loading.
let _buildAuthHeader;
async function getBuildAuthHeader() {
  if (_buildAuthHeader !== undefined) return _buildAuthHeader;
  try {
    const mod = await import("../src/ntfy.mjs");
    if (typeof mod.buildAuthHeader !== "function") {
      throw new Error("buildAuthHeader is not exported from ntfy.mjs");
    }
    _buildAuthHeader = mod.buildAuthHeader;
  } catch {
    _buildAuthHeader = null;
  }
  return _buildAuthHeader;
}

// ---------------------------------------------------------------------------
// processHook
// ---------------------------------------------------------------------------

describe("processHook", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof processHook, "function");
  });

  // ==================== Happy Path: Approve ====================

  it("should return allow decision when waitForResponse returns approved:true", async () => {
    const deps = createDeps({ waitResult: { approved: true } });

    const result = await processHook(sampleInput, deps);

    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  // ==================== Happy Path: Deny ====================

  it("should return deny decision when waitForResponse returns approved:false", async () => {
    const deps = createDeps({ waitResult: { approved: false } });

    const result = await processHook(sampleInput, deps);

    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny" },
      },
    });
  });

  // ==================== No Topic Configured ====================

  it("should return ask when config has no topic set", async () => {
    const noTopicConfig = {
      topic: "",
      ntfyServer: "https://ntfy.sh",
      timeout: 120,
      autoApprove: [],
      autoDeny: [],
    };
    const deps = createDeps({ config: noTopicConfig });

    const result = await processHook(sampleInput, deps);

    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "ask" },
      },
    });
  });

  // ==================== Master switch: notify=false ====================

  it("should return ask WITHOUT notifying when config.notify is false", async () => {
    const deps = createDeps({
      config: { topic: "t", ntfyServer: "https://ntfy.sh", timeout: 15, notify: false },
    });

    const result = await processHook(sampleInput, deps);

    assert.equal(result.hookSpecificOutput.decision.behavior, "ask", "should keep the prompt in the terminal");
    assert.equal(deps.sendNotification.mock.callCount(), 0, "must NOT publish to the phone when notify is off");
    assert.equal(deps.waitForResponse.mock.callCount(), 0, "must NOT wait on the phone when notify is off");
  });

  it("should notify normally when config.notify is true (default)", async () => {
    const deps = createDeps({
      config: { topic: "t", ntfyServer: "https://ntfy.sh", timeout: 15, notify: true },
      waitResult: { approved: true },
    });

    const result = await processHook(sampleInput, deps);

    assert.equal(result.hookSpecificOutput.decision.behavior, "allow");
    assert.equal(deps.waitForResponse.mock.callCount(), 1, "should wait on the phone when notify is on");
  });

  it("should not call sendNotification when config has no topic", async () => {
    const noTopicConfig = {
      topic: "",
      ntfyServer: "https://ntfy.sh",
      timeout: 120,
      autoApprove: [],
      autoDeny: [],
    };
    const deps = createDeps({ config: noTopicConfig });

    await processHook(sampleInput, deps);

    assert.equal(
      deps.sendNotification.mock.callCount(),
      0,
      "sendNotification should not be called when topic is empty"
    );
  });

  // ==================== sendNotification parameters ====================

  it("should call sendNotification with correct topic from config", async () => {
    const deps = createDeps();

    await processHook(sampleInput, deps);

    assert.equal(deps.sendNotification.mock.callCount(), 1);
    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.equal(callArgs.topic, "test-topic");
  });

  it("should call sendNotification with title and message from formatToolInfo", async () => {
    const deps = createDeps({
      toolInfo: { title: "Claude Code: Read", message: "/path/to/file.ts" },
    });

    await processHook(sampleInput, deps);

    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    // Pending publish prepends the ⏳ state emoji to the (emoji-free) tool title.
    assert.equal(callArgs.title, "⏳ Claude Code: Read");
    assert.equal(callArgs.message, "/path/to/file.ts");
  });

  it("should call sendNotification with actions array containing 2 actions", async () => {
    const deps = createDeps();

    await processHook(sampleInput, deps);

    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.ok(Array.isArray(callArgs.actions), "actions should be an array");
    assert.equal(callArgs.actions.length, 2);
  });

  it("should call sendNotification with server from config", async () => {
    const deps = createDeps();

    await processHook(sampleInput, deps);

    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.equal(callArgs.server, "https://ntfy.sh");
  });

  // ==================== waitForResponse parameters ====================

  it("should call waitForResponse with response topic ({topic}-response)", async () => {
    const deps = createDeps();

    await processHook(sampleInput, deps);

    assert.equal(deps.waitForResponse.mock.callCount(), 1);
    const callArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(
      callArgs.topic,
      "test-topic",
      `waitForResponse should receive the topic, got: ${callArgs.topic}`
    );
  });

  it("should call waitForResponse with timeout from config", async () => {
    const customConfig = {
      topic: "test-topic",
      ntfyServer: "https://ntfy.sh",
      timeout: 300,
      planTimeout: 300,
      autoApprove: [],
      autoDeny: [],
    };
    const deps = createDeps({ config: customConfig });

    await processHook(sampleInput, deps);

    const callArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(
      callArgs.timeout,
      300 * 1000,
      `timeout should be config.timeout * 1000 (300000), got: ${callArgs.timeout}`
    );
  });

  it("should call waitForResponse with server from config", async () => {
    const customConfig = {
      topic: "test-topic",
      ntfyServer: "https://custom.ntfy.example.com",
      timeout: 120,
      planTimeout: 300,
      autoApprove: [],
      autoDeny: [],
    };
    const deps = createDeps({ config: customConfig });

    await processHook(sampleInput, deps);

    const callArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(callArgs.server, "https://custom.ntfy.example.com");
  });

  // ==================== Error handling ====================

  it("should return ask when all sendNotification retries fail", async () => {
    const originalDelay = _internal.delay;
    _internal.delay = () => Promise.resolve();
    try {
      const deps = createDeps();
      deps.sendNotification = mock.fn(async () => {
        throw new Error("network error");
      });
      const result = await processHook(sampleInput, deps);

      assert.equal(deps.sendNotification.mock.callCount(), 3, "sendNotification should be called 3 times (retry logic)");
      assert.deepEqual(result, {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "ask" },
        },
      });
    } finally {
      _internal.delay = originalDelay;
    }
  });

  it("should return ask when waitForResponse throws", async () => {
    const deps = createDeps();
    deps.waitForResponse = mock.fn(async () => {
      throw new Error("timeout exceeded");
    });

    const result = await processHook(sampleInput, deps);

    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "ask" },
      },
    });
  });

  it("should log error to console.error when sendNotification throws", async () => {
    const originalDelay = _internal.delay;
    _internal.delay = () => Promise.resolve();
    const errorSpy = mock.method(console, "error", () => {});
    try {
      const deps = createDeps();
      deps.sendNotification = mock.fn(async () => {
        throw new Error("network error");
      });
      await processHook(sampleInput, deps);

      assert.equal(errorSpy.mock.callCount(), 1);
      const args = errorSpy.mock.calls[0].arguments;
      assert.ok(
        args[0].includes("[remote-approver]") && args[0].includes("Notification failed after 3 attempts:"),
        `console.error first arg should have prefix and message, got: ${args[0]}`
      );
      assert.equal(args[1], "network error", "should include err.message");
      assert.ok(
        args[2].includes("Falling back to CLI"),
        `should mention fallback, got: ${args[2]}`
      );
    } finally {
      errorSpy.mock.restore();
      _internal.delay = originalDelay;
    }
  });

  it("should log error to console.error when waitForResponse throws", async () => {
    const deps = createDeps();
    deps.waitForResponse = mock.fn(async () => {
      throw new Error("timeout exceeded");
    });
    const errorSpy = mock.method(console, "error", () => {});

    try {
      await processHook(sampleInput, deps);
      assert.equal(errorSpy.mock.callCount(), 1);
      const args = errorSpy.mock.calls[0].arguments;
      assert.ok(
        args[0].includes("[remote-approver]") && args[0].includes("Response listener failed:"),
        `console.error first arg should have prefix and message, got: ${args[0]}`
      );
      assert.equal(args[1], "timeout exceeded", "should include err.message");
      assert.ok(
        args[2].includes("Falling back to CLI"),
        `should mention fallback, got: ${args[2]}`
      );
    } finally {
      errorSpy.mock.restore();
    }
  });

  // ==================== ExitPlanMode timeout ====================

  it("should use planTimeout for ExitPlanMode tool", async () => {
    const customConfig = {
      topic: "test-topic",
      ntfyServer: "https://ntfy.sh",
      timeout: 120,
      planTimeout: 300,
      autoApprove: [],
      autoDeny: [],
    };
    const deps = createDeps({ config: customConfig });
    const exitPlanInput = {
      hook_event_name: "PreToolUse",
      tool_name: "ExitPlanMode",
      tool_input: {},
    };

    await processHook(exitPlanInput, deps);

    const callArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(
      callArgs.timeout,
      300 * 1000,
      `ExitPlanMode timeout should be planTimeout * 1000 (300000), got: ${callArgs.timeout}`
    );
  });

  it("should use regular timeout for non-ExitPlanMode tools", async () => {
    const customConfig = {
      topic: "test-topic",
      ntfyServer: "https://ntfy.sh",
      timeout: 120,
      planTimeout: 300,
      autoApprove: [],
      autoDeny: [],
    };
    const deps = createDeps({ config: customConfig });

    await processHook(sampleInput, deps);

    const callArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(
      callArgs.timeout,
      120 * 1000,
      `Regular tool timeout should be timeout * 1000 (120000), got: ${callArgs.timeout}`
    );
  });

  it("should fall back to 300s when planTimeout is not set in config for ExitPlanMode", async () => {
    const configWithoutPlanTimeout = {
      topic: "test-topic",
      ntfyServer: "https://ntfy.sh",
      timeout: 120,
      autoApprove: [],
      autoDeny: [],
    };
    const deps = createDeps({ config: configWithoutPlanTimeout });
    const exitPlanInput = {
      hook_event_name: "PreToolUse",
      tool_name: "ExitPlanMode",
      tool_input: {},
    };

    await processHook(exitPlanInput, deps);

    const callArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(
      callArgs.timeout,
      300 * 1000,
      `ExitPlanMode should fall back to 300s (300000), got: ${callArgs.timeout}`
    );
  });

  // ==================== formatToolInfo ====================

  it("should call formatToolInfo with the input", async () => {
    const deps = createDeps();

    await processHook(sampleInput, deps);

    assert.equal(deps.formatToolInfo.mock.callCount(), 1);
    const callArgs = deps.formatToolInfo.mock.calls[0].arguments[0];
    assert.equal(callArgs.tool_name, "Bash");
    assert.deepEqual(callArgs.tool_input, { command: "echo hello" });
  });

  // ==================== loadConfig ====================

  it("should call loadConfig exactly once", async () => {
    const deps = createDeps();

    await processHook(sampleInput, deps);

    assert.equal(deps.loadConfig.mock.callCount(), 1);
  });

  // ==================== waitForResponse edge cases ====================

  it("should return ask when waitForResponse returns { timeout: true }", async () => {
    const deps = createDeps();
    deps.waitForResponse = mock.fn(async () => ({ timeout: true }));

    const result = await processHook(sampleInput, deps);

    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "ask" },
      },
    });
  });

  it("should return ask when waitForResponse returns { error: Error }", async () => {
    const deps = createDeps();
    deps.waitForResponse = mock.fn(async () => ({ error: new Error("SSE failure") }));

    const result = await processHook(sampleInput, deps);

    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "ask" },
      },
    });
  });

  it("should log timeout message to stderr when waitForResponse returns { timeout: true }", async () => {
    const deps = createDeps();
    deps.waitForResponse = mock.fn(async () => ({ timeout: true }));
    const errorSpy = mock.method(console, "error", () => {});

    try {
      await processHook(sampleInput, deps);
      assert.equal(errorSpy.mock.callCount(), 1);
      const args = errorSpy.mock.calls[0].arguments;
      assert.ok(
        args[0].includes("[remote-approver]") && args[0].includes("Timed out waiting for response"),
        `should log timeout message with prefix, got: ${args[0]}`
      );
    } finally {
      errorSpy.mock.restore();
    }
  });

  it("should log error message to stderr when waitForResponse returns { error: Error }", async () => {
    const deps = createDeps();
    deps.waitForResponse = mock.fn(async () => ({ error: new Error("SSE failure") }));
    const errorSpy = mock.method(console, "error", () => {});

    try {
      await processHook(sampleInput, deps);
      assert.equal(errorSpy.mock.callCount(), 1);
      const args = errorSpy.mock.calls[0].arguments;
      assert.ok(
        args[0].includes("[remote-approver]") && args[0].includes("Response error:"),
        `should log error message with prefix, got: ${args[0]}`
      );
      assert.equal(args[1], "SSE failure", "should include error message");
      assert.ok(
        args[2].includes("Falling back to CLI"),
        `should mention fallback, got: ${args[2]}`
      );
    } finally {
      errorSpy.mock.restore();
    }
  });

  // ==================== sendWithRetry via processHook ====================

  it("should succeed on second retry when sendNotification fails once then succeeds", async () => {
    const originalDelay = _internal.delay;
    _internal.delay = () => Promise.resolve();
    try {
      const deps = createDeps();
      let callCount = 0;
      deps.sendNotification = mock.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error("first attempt fails");
        return { ok: true, status: 200 };
      });
      const result = await processHook(sampleInput, deps);

      assert.equal(deps.sendNotification.mock.callCount(), 2, "sendNotification should be called twice");
      assert.deepEqual(result, {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      });
    } finally {
      _internal.delay = originalDelay;
    }
  });

  it("should route AskUserQuestion to processAskUserQuestion", async () => {
    const askInput = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which option?",
          header: "Choice",
          options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
          multiSelect: false,
        }],
      },
    };
    const deps = createDeps();
    deps.waitForResponse = mock.fn(async () => ({ answer: "A" }));

    const result = await processHook(askInput, deps);

    assert.equal(result.hookSpecificOutput.decision.behavior, "allow");
    assert.ok(result.hookSpecificOutput.decision.updatedInput, "Should have updatedInput from processAskUserQuestion");
    assert.deepEqual(result.hookSpecificOutput.decision.updatedInput.answers, { "Which option?": "A" });
  });

  // ==================== Always Approve integration ====================

  it("should pass permission_suggestions to buildActions when present in input", async () => {
    const inputWithSuggestions = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      permission_suggestions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
    };
    const deps = createDeps();
    await processHook(inputWithSuggestions, deps);
    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.equal(callArgs.actions.length, 3, "Should have 3 actions (Approve, Always Approve, Deny)");
    assert.equal(callArgs.actions[1].label, "Always Approve");
  });

  it("should return updatedPermissions when alwaysAllow is true and permission_suggestions exist", async () => {
    const inputWithSuggestions = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      permission_suggestions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
    };
    const deps = createDeps({ waitResult: { approved: true, alwaysAllow: true } });
    const result = await processHook(inputWithSuggestions, deps);
    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedPermissions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
        },
      },
    });
  });

  it("should NOT include updatedPermissions when alwaysAllow is false", async () => {
    const inputWithSuggestions = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      permission_suggestions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
    };
    const deps = createDeps({ waitResult: { approved: true, alwaysAllow: false } });
    const result = await processHook(inputWithSuggestions, deps);
    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("should NOT include updatedPermissions when alwaysAllow is true but permission_suggestions is absent", async () => {
    const deps = createDeps({ waitResult: { approved: true, alwaysAllow: true } });
    // sampleInput does NOT have permission_suggestions
    const result = await processHook(sampleInput, deps);
    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("should return 2 actions when permissionSuggestions is null in input", async () => {
    const inputWithNull = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      permission_suggestions: null,
    };
    const deps = createDeps();
    await processHook(inputWithNull, deps);
    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.equal(callArgs.actions.length, 2, "Should have 2 actions when permissionSuggestions is null");
  });

  it("should return deny when approved is false even if alwaysAllow is true", async () => {
    const inputWithSuggestions = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      permission_suggestions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
    };
    const deps = createDeps({ waitResult: { approved: false, alwaysAllow: true } });
    const result = await processHook(inputWithSuggestions, deps);
    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny" },
      },
    });
  });

  // ==================== Auth threading (Basic Auth) ====================

  it("should pass auth to sendNotification when resolveAuth returns credentials", async () => {
    const auth = { username: "myuser", password: "mypass" };
    const deps = createDeps();
    deps.resolveAuth = mock.fn(() => auth);

    await processHook(sampleInput, deps);

    assert.equal(deps.sendNotification.mock.callCount(), 1);
    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.deepEqual(callArgs.auth, auth, "sendNotification should receive auth in params");
  });

  it("should pass auth to waitForResponse when resolveAuth returns credentials", async () => {
    const auth = { username: "myuser", password: "mypass" };
    const deps = createDeps();
    deps.resolveAuth = mock.fn(() => auth);

    await processHook(sampleInput, deps);

    assert.equal(deps.waitForResponse.mock.callCount(), 1);
    const callArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.deepEqual(callArgs.auth, auth, "waitForResponse should receive auth in params");
  });

  it("should pass auth to buildActions so actions have Authorization headers", async () => {
    const buildAuthHeaderFn = await getBuildAuthHeader();
    assert.ok(buildAuthHeaderFn, "buildAuthHeader must be exported from ntfy.mjs");
    const auth = { username: "myuser", password: "mypass" };
    const deps = createDeps();
    deps.resolveAuth = mock.fn(() => auth);

    await processHook(sampleInput, deps);

    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    const expectedHeaders = buildAuthHeaderFn(auth);
    for (const action of callArgs.actions) {
      assert.deepEqual(action.headers, expectedHeaders, "each action should have Authorization headers");
    }
  });

  it("should work without auth when resolveAuth returns null", async () => {
    const deps = createDeps();
    deps.resolveAuth = mock.fn(() => null);

    const result = await processHook(sampleInput, deps);

    // Existing behavior preserved: allow decision
    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    // sendNotification should NOT have auth
    const sendArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.equal(sendArgs.auth, undefined, "sendNotification should not have auth when resolveAuth returns null");
    // waitForResponse should NOT have auth
    const waitArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(waitArgs.auth, undefined, "waitForResponse should not have auth when resolveAuth returns null");
    // Actions should NOT have headers
    for (const action of sendArgs.actions) {
      assert.equal(action.headers, undefined, "actions should not have headers when auth is null");
    }
  });
});

// ---------------------------------------------------------------------------
// processHook Stop routing
// ---------------------------------------------------------------------------

describe("processHook Stop routing", () => {
  it("routes Stop events to processStop (no waitForResponse, returns {})", async () => {
    const sendNotification = mock.fn(async () => ({ ok: true }));
    const waitForResponse = mock.fn(async () => ({ approved: true }));
    const loadConfig = () => ({ topic: "t", ntfyServer: "https://ntfy.sh", notifyOnStop: true });

    const result = await processHook(
      { hook_event_name: "Stop", cwd: "/x/proj", last_assistant_message: "ok" },
      { loadConfig, sendNotification, waitForResponse, formatToolInfo: () => ({}), resolveAuth: () => null }
    );

    assert.deepEqual(result, {});
    assert.equal(waitForResponse.mock.callCount(), 0);
    assert.equal(sendNotification.mock.callCount(), 1);
  });
});

// ---------------------------------------------------------------------------
// Resolved-notification update (sequence_id) — active -> resolved
// ---------------------------------------------------------------------------

describe("processHook resolved-notification update", () => {
  const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hi" } };

  function depsWith(waitResult) {
    return {
      loadConfig: mock.fn(() => ({ topic: "t", ntfyServer: "https://ntfy.sh", timeout: 120, planTimeout: 300 })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      updateNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async ({ onReady } = {}) => { if (onReady) await onReady(); return waitResult; }),
      formatToolInfo: mock.fn(() => ({ title: "Claude Code: Bash", message: "echo hi", priority: 4, tags: ["computer"], markdown: true })),
      resolveAuth: () => null,
    };
  }

  it("initial send carries sequenceId equal to the requestId", async () => {
    const deps = depsWith({ approved: true });
    await processHook(input, deps);
    const args = deps.sendNotification.mock.calls[0].arguments[0];
    assert.ok(args.sequenceId, "sequenceId should be set");
    assert.equal(args.sequenceId, args.requestId);
  });

  it("updates to ✅ state (no actions) on allow", async () => {
    const deps = depsWith({ approved: true });
    await processHook(input, deps);
    assert.equal(deps.updateNotification.mock.callCount(), 1);
    const u = deps.updateNotification.mock.calls[0].arguments[0];
    assert.ok(u.title.startsWith("✅ "), `got: ${u.title}`);
    assert.deepEqual(u.actions, []);
    assert.equal(u.sequenceId, deps.sendNotification.mock.calls[0].arguments[0].requestId);
  });

  it("updates to ❌ state on deny", async () => {
    const deps = depsWith({ approved: false });
    await processHook(input, deps);
    assert.equal(deps.updateNotification.mock.callCount(), 1);
    assert.ok(deps.updateNotification.mock.calls[0].arguments[0].title.startsWith("❌ "));
  });

  it("updates to ⏱️ state on timeout", async () => {
    const deps = depsWith({ timeout: true });
    await processHook(input, deps);
    assert.equal(deps.updateNotification.mock.callCount(), 1);
    assert.ok(deps.updateNotification.mock.calls[0].arguments[0].title.startsWith("⏱️ "));
  });

  it("no update call when updateNotification is not injected (back-compat)", async () => {
    const deps = depsWith({ approved: true });
    delete deps.updateNotification;
    const result = await processHook(input, deps);
    assert.equal(result.hookSpecificOutput.decision.behavior, "allow");
  });
});

describe("processHook — subscribe before publish (no lost-tap race)", () => {
  const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hi" } };

  function baseDeps() {
    return {
      loadConfig: mock.fn(() => ({ topic: "t", ntfyServer: "https://ntfy.sh", timeout: 120, planTimeout: 300 })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      updateNotification: mock.fn(async () => ({ ok: true })),
      formatToolInfo: mock.fn(() => ({ title: "Claude Code: Bash", message: "echo hi", priority: 4, tags: ["computer"], markdown: true })),
      resolveAuth: () => null,
    };
  }

  it("publishes only via onReady, i.e. after the subscription is established", async () => {
    const deps = baseDeps();
    let publishedBeforeReady = false;
    // waitForResponse simulates: connect first, THEN the caller publishes via onReady.
    deps.waitForResponse = mock.fn(async ({ onReady }) => {
      // At this point the subscription is "live" but nothing has been published yet.
      if (deps.sendNotification.mock.callCount() > 0) publishedBeforeReady = true;
      await onReady();
      return { approved: true };
    });

    await processHook(input, deps);

    assert.equal(publishedBeforeReady, false, "must NOT publish before the subscription is live");
    assert.equal(deps.sendNotification.mock.callCount(), 1, "publish happens exactly once, via onReady");
  });

  it("falls back to ASK when the onReady publish fails after retries", async () => {
    const originalDelay = _internal.delay;
    _internal.delay = () => Promise.resolve();
    try {
      const deps = baseDeps();
      deps.sendNotification = mock.fn(async () => { throw new Error("send fail"); });
      // Real waitForResponse propagates an onReady throw; the mock mirrors that.
      deps.waitForResponse = mock.fn(async ({ onReady }) => { await onReady(); return { approved: true }; });

      const result = await processHook(input, deps);

      assert.equal(result.hookSpecificOutput.decision.behavior, "ask");
    } finally {
      _internal.delay = originalDelay;
    }
  });
});
