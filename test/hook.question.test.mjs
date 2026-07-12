/**
 * Test suite for src/adapters/claude-code.mjs — processAskUserQuestion
 *
 * Coverage:
 * - processAskUserQuestion
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { processAskUserQuestion, _internal } from "../src/adapters/claude-code.mjs";

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
// processAskUserQuestion
// ---------------------------------------------------------------------------

describe("processAskUserQuestion", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof processAskUserQuestion, "function");
  });

  it("should return allow with answers for a single question with answer", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async ({ onReady } = {}) => { if (onReady) await onReady(); return { answer: "A" }; }),
    };

    const result = await processAskUserQuestion(input, deps);

    assert.equal(result.hookSpecificOutput.decision.behavior, "allow");
    assert.ok(result.hookSpecificOutput.decision.updatedInput);
    assert.deepEqual(result.hookSpecificOutput.decision.updatedInput.answers, { "Which?": "A" });
  });

  it("should return ask when sendNotification fails after retries", async () => {
    const originalDelay = _internal.delay;
    _internal.delay = () => Promise.resolve();
    try {
      const input = {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{
            question: "Which?",
            header: "Q",
            options: [{ label: "A", description: "a" }],
            multiSelect: false,
          }],
        },
      };
      const deps = {
        loadConfig: mock.fn(() => ({
          topic: "test-topic",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
        })),
        sendNotification: mock.fn(async () => { throw new Error("fail"); }),
        waitForResponse: mock.fn(async ({ onReady } = {}) => { if (onReady) await onReady(); return { answer: "A" }; }),
      };
      const result = await processAskUserQuestion(input, deps);

      assert.equal(result.hookSpecificOutput.decision.behavior, "ask");
    } finally {
      _internal.delay = originalDelay;
    }
  });

  it("should return ask when waitForResponse returns timeout", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async ({ onReady } = {}) => { if (onReady) await onReady(); return { timeout: true }; }),
    };

    const result = await processAskUserQuestion(input, deps);

    assert.equal(result.hookSpecificOutput.decision.behavior, "ask");
  });

  it("should split 4 options into 2 notifications", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Pick one",
          header: "Q",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
            { label: "C", description: "c" },
            { label: "D", description: "d" },
          ],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async ({ onReady } = {}) => { if (onReady) await onReady(); return { answer: "C" }; }),
    };

    const result = await processAskUserQuestion(input, deps);

    assert.equal(deps.sendNotification.mock.callCount(), 2, "Should send 2 notifications for 4 options");
    assert.equal(result.hookSpecificOutput.decision.behavior, "allow");
    assert.deepEqual(result.hookSpecificOutput.decision.updatedInput.answers, { "Pick one": "C" });
  });

  it("resolves the already-sent batch when a later batch fails, then falls back to ASK", async () => {
    const originalDelay = _internal.delay;
    _internal.delay = () => Promise.resolve();
    try {
      const input = {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{
            question: "Pick one",
            header: "Q",
            options: [
              { label: "A", description: "a" },
              { label: "B", description: "b" },
              { label: "C", description: "c" },
              { label: "D", description: "d" }, // forces a 2nd batch (3+1)
            ],
            multiSelect: false,
          }],
        },
      };
      // Batch 1 publishes fine; batch 2 fails every retry.
      let batchStarts = 0;
      const deps = {
        loadConfig: mock.fn(() => ({ topic: "test-topic", ntfyServer: "https://ntfy.sh", timeout: 120 })),
        sendNotification: mock.fn(async () => {
          batchStarts += 1;
          if (batchStarts === 1) return { ok: true };
          throw new Error("second batch fails");
        }),
        updateNotification: mock.fn(async () => ({ ok: true })),
        waitForResponse: mock.fn(async ({ onReady } = {}) => { if (onReady) await onReady(); return { answer: "A" }; }),
      };

      const result = await processAskUserQuestion(input, deps);

      assert.equal(result.hookSpecificOutput.decision.behavior, "ask", "should fall back to CLI");
      assert.equal(deps.updateNotification.mock.callCount(), 1, "should resolve the lingering pending card exactly once");
      const u = deps.updateNotification.mock.calls[0].arguments[0];
      assert.deepEqual(u.actions, [], "resolved card is button-less");
      assert.ok(u.title.startsWith("⏱️"), `resolved as timeout, got: ${u.title}`);
    } finally {
      _internal.delay = originalDelay;
    }
  });

  it("does NOT resolve anything when the very first batch fails (nothing reached the phone)", async () => {
    const originalDelay = _internal.delay;
    _internal.delay = () => Promise.resolve();
    try {
      const input = {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{
            question: "Pick one",
            header: "Q",
            options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
            multiSelect: false,
          }],
        },
      };
      const deps = {
        loadConfig: mock.fn(() => ({ topic: "test-topic", ntfyServer: "https://ntfy.sh", timeout: 120 })),
        sendNotification: mock.fn(async () => { throw new Error("first batch fails"); }),
        updateNotification: mock.fn(async () => ({ ok: true })),
        waitForResponse: mock.fn(async ({ onReady } = {}) => { if (onReady) await onReady(); return { answer: "A" }; }),
      };

      const result = await processAskUserQuestion(input, deps);

      assert.equal(result.hookSpecificOutput.decision.behavior, "ask");
      assert.equal(deps.updateNotification.mock.callCount(), 0, "nothing was shown, so nothing to resolve");
    } finally {
      _internal.delay = originalDelay;
    }
  });

  it("should split 5 options into 2 notifications (3+2)", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Pick one of five",
          header: "Q",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
            { label: "C", description: "c" },
            { label: "D", description: "d" },
            { label: "E", description: "e" },
          ],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async ({ onReady } = {}) => { if (onReady) await onReady(); return { answer: "D" }; }),
    };

    const result = await processAskUserQuestion(input, deps);

    assert.equal(deps.sendNotification.mock.callCount(), 2, "Should send 2 notifications for 5 options (3+2)");
    assert.equal(result.hookSpecificOutput.decision.behavior, "allow");
    assert.deepEqual(result.hookSpecificOutput.decision.updatedInput.answers, { "Pick one of five": "D" });
  });

  it("should handle multiple questions", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Q1?",
            header: "H1",
            options: [{ label: "A1", description: "a1" }, { label: "B1", description: "b1" }],
            multiSelect: false,
          },
          {
            question: "Q2?",
            header: "H2",
            options: [{ label: "A2", description: "a2" }, { label: "B2", description: "b2" }],
            multiSelect: false,
          },
        ],
      },
    };
    let waitCallCount = 0;
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async () => {
        waitCallCount++;
        return { answer: waitCallCount === 1 ? "A1" : "B2" };
      }),
    };

    const result = await processAskUserQuestion(input, deps);

    assert.equal(result.hookSpecificOutput.decision.behavior, "allow");
    assert.deepEqual(result.hookSpecificOutput.decision.updatedInput.answers, { "Q1?": "A1", "Q2?": "B2" });
  });

  it("should log stderr message when waitForResponse throws", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async () => { throw new Error("connection lost"); }),
    };
    const errorSpy = mock.method(console, "error", () => {});

    try {
      await processAskUserQuestion(input, deps);
      assert.equal(errorSpy.mock.callCount(), 1);
      const args = errorSpy.mock.calls[0].arguments;
      assert.ok(
        args[0].includes("[remote-approver]") && args[0].includes("Response listener failed:"),
        `should have prefix and message, got: ${args[0]}`
      );
      assert.equal(args[1], "connection lost", "should include err.message");
    } finally {
      errorSpy.mock.restore();
    }
  });

  it("should log stderr message when no answer received (timeout/error)", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async ({ onReady } = {}) => { if (onReady) await onReady(); return { timeout: true }; }),
    };
    const errorSpy = mock.method(console, "error", () => {});

    try {
      await processAskUserQuestion(input, deps);
      assert.equal(errorSpy.mock.callCount(), 1);
      const args = errorSpy.mock.calls[0].arguments;
      assert.ok(
        args[0].includes("[remote-approver]") && args[0].includes("No answer received"),
        `should log no answer message with prefix, got: ${args[0]}`
      );
    } finally {
      errorSpy.mock.restore();
    }
  });

  it("should log stderr message when sendNotification fails after retries", async () => {
    const originalDelay = _internal.delay;
    _internal.delay = () => Promise.resolve();
    const errorSpy = mock.method(console, "error", () => {});
    try {
      const input = {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{
            question: "Which?",
            header: "Q",
            options: [{ label: "A", description: "a" }],
            multiSelect: false,
          }],
        },
      };
      const deps = {
        loadConfig: mock.fn(() => ({
          topic: "test-topic",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
        })),
        sendNotification: mock.fn(async () => { throw new Error("rate limited"); }),
        waitForResponse: mock.fn(async ({ onReady } = {}) => { if (onReady) await onReady(); return { answer: "A" }; }),
      };
      await processAskUserQuestion(input, deps);

      assert.equal(errorSpy.mock.callCount(), 1);
      const args = errorSpy.mock.calls[0].arguments;
      assert.ok(
        args[0].includes("[remote-approver]") && args[0].includes("Notification failed after 3 attempts:"),
        `should have prefix and notification failed message, got: ${args[0]}`
      );
      assert.equal(args[1], "rate limited", "should include err.message");
    } finally {
      errorSpy.mock.restore();
      _internal.delay = originalDelay;
    }
  });

  // ==================== Auth threading (Basic Auth) ====================

  it("should pass auth to sendNotification when resolveAuth returns credentials", async () => {
    const auth = { username: "myuser", password: "mypass" };
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async ({ onReady } = {}) => { if (onReady) await onReady(); return { answer: "A" }; }),
      resolveAuth: mock.fn(() => auth),
    };

    await processAskUserQuestion(input, deps);

    assert.equal(deps.sendNotification.mock.callCount(), 1);
    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.deepEqual(callArgs.auth, auth, "sendNotification should receive auth in params");
  });

  it("should pass auth to waitForResponse when resolveAuth returns credentials", async () => {
    const auth = { username: "myuser", password: "mypass" };
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async ({ onReady } = {}) => { if (onReady) await onReady(); return { answer: "A" }; }),
      resolveAuth: mock.fn(() => auth),
    };

    await processAskUserQuestion(input, deps);

    assert.equal(deps.waitForResponse.mock.callCount(), 1);
    const callArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.deepEqual(callArgs.auth, auth, "waitForResponse should receive auth in params");
  });

  it("should pass auth to buildQuestionActions so actions have Authorization headers", async () => {
    const auth = { username: "myuser", password: "mypass" };
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async ({ onReady } = {}) => { if (onReady) await onReady(); return { answer: "A" }; }),
      resolveAuth: mock.fn(() => auth),
    };

    await processAskUserQuestion(input, deps);

    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    const buildAuthHeaderFn = await getBuildAuthHeader();
    assert.ok(buildAuthHeaderFn, "buildAuthHeader must be exported from ntfy.mjs");
    const expectedHeaders = buildAuthHeaderFn(auth);
    for (const action of callArgs.actions) {
      assert.deepEqual(action.headers, expectedHeaders, "each question action should have Authorization headers");
    }
  });
});
