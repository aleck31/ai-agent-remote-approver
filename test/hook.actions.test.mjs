/**
 * Test suite for src/hook.mjs — action builders and utilities
 *
 * Coverage:
 * - buildActions
 * - sendWithRetry
 * - isAskUserQuestion
 * - buildQuestionActions
 * - buildQuestionMessage
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { buildActions, sendWithRetry, RETRY_DELAY_MS, _internal, isAskUserQuestion, buildQuestionActions, buildQuestionMessage } from "../src/hook.mjs";

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
// buildActions
// ---------------------------------------------------------------------------

describe("buildActions", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof buildActions, "function");
  });

  it("should return an array with exactly 2 actions", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-001");

    assert.ok(Array.isArray(actions), "should return an array");
    assert.equal(actions.length, 2, "should have exactly 2 actions");
  });

  it("should have Approve as the first action and Deny as the second", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-002");

    assert.equal(actions[0].label, "Approve");
    assert.equal(actions[1].label, "Deny");
  });

  it("should set action type to 'http' for both actions", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-003");

    assert.equal(actions[0].action, "http");
    assert.equal(actions[1].action, "http");
  });

  it("should use response topic URLs ({topic}-response)", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-004");

    assert.equal(
      actions[0].url,
      "https://ntfy.sh/my-topic-response",
      `Approve URL should use response topic, got: ${actions[0].url}`
    );
    assert.equal(
      actions[1].url,
      "https://ntfy.sh/my-topic-response",
      `Deny URL should use response topic, got: ${actions[1].url}`
    );
  });

  it("should use POST method for both actions", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-005");

    assert.equal(actions[0].method, "POST");
    assert.equal(actions[1].method, "POST");
  });

  it("should not include Content-Type header to avoid ntfy JSON publishing mode", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-006");

    assert.equal(actions[0].headers, undefined);
    assert.equal(actions[1].headers, undefined);
  });

  it("should include requestId and approved:true in Approve body", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-007");

    const body = JSON.parse(actions[0].body);
    assert.equal(body.requestId, "req-007");
    assert.equal(body.approved, true);
  });

  it("should include requestId and approved:false in Deny body", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-008");

    const body = JSON.parse(actions[1].body);
    assert.equal(body.requestId, "req-008");
    assert.equal(body.approved, false);
  });

  it("should handle custom server URLs correctly", () => {
    const actions = buildActions(
      "https://custom.ntfy.example.com",
      "cra-abc123",
      "req-009"
    );

    assert.equal(
      actions[0].url,
      "https://custom.ntfy.example.com/cra-abc123-response"
    );
    assert.equal(
      actions[1].url,
      "https://custom.ntfy.example.com/cra-abc123-response"
    );
  });

  // ==================== Always Approve ====================

  it("should return 3 actions when permissionSuggestions is provided", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-aa1", {
      permissionSuggestions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
    });
    assert.equal(actions.length, 3);
  });

  it("should place Always Approve between Approve and Deny", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-aa2", {
      permissionSuggestions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
    });
    assert.equal(actions[0].label, "Approve");
    assert.equal(actions[1].label, "Always Approve");
    assert.equal(actions[2].label, "Deny");
  });

  it("should include alwaysAllow: true in Always Approve button body", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-aa3", {
      permissionSuggestions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
    });
    const body = JSON.parse(actions[1].body);
    assert.equal(body.requestId, "req-aa3");
    assert.equal(body.approved, true);
    assert.equal(body.alwaysAllow, true);
  });

  it("should return 2 actions when permissionSuggestions is empty", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-aa4", {
      permissionSuggestions: [],
    });
    assert.equal(actions.length, 2);
    assert.equal(actions[0].label, "Approve");
    assert.equal(actions[1].label, "Deny");
  });

  it("should return 2 actions when no options object is provided", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-aa5");
    assert.equal(actions.length, 2);
  });

  // ==================== Auth (Basic Auth headers) ====================

  it("should include headers with Authorization on each action when auth is provided", async () => {
    const buildAuthHeaderFn = await getBuildAuthHeader();
    assert.ok(buildAuthHeaderFn, "buildAuthHeader must be exported from ntfy.mjs");
    const auth = { username: "user", password: "pass" };
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-auth1", { auth });
    const expectedHeaders = buildAuthHeaderFn(auth);
    for (const action of actions) {
      assert.deepEqual(action.headers, expectedHeaders);
    }
  });

  it("should NOT include headers property on actions when auth is not provided", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-auth2");
    for (const action of actions) {
      assert.equal(action.headers, undefined, "actions should not have headers when auth is not provided");
    }
  });
});

// ---------------------------------------------------------------------------
// sendWithRetry
// ---------------------------------------------------------------------------

describe("sendWithRetry", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof sendWithRetry, "function");
  });

  it("should return the result on first success", async () => {
    const mockSend = mock.fn(async () => ({ ok: true }));
    const result = await sendWithRetry(mockSend, { server: "s", topic: "t" });
    assert.deepEqual(result, { ok: true });
    assert.equal(mockSend.mock.callCount(), 1);
  });

  it("should retry up to 3 times and return null on all failures", async () => {
    const originalDelay = _internal.delay;
    _internal.delay = () => Promise.resolve();
    try {
      const mockSend = mock.fn(async () => { throw new Error("fail"); });
      const result = await sendWithRetry(mockSend, { server: "s", topic: "t" });
      assert.equal(result, null);
      assert.equal(mockSend.mock.callCount(), 3);
    } finally {
      _internal.delay = originalDelay;
    }
  });

  it("should succeed on second attempt after first failure", async () => {
    const originalDelay = _internal.delay;
    _internal.delay = () => Promise.resolve();
    try {
      let count = 0;
      const mockSend = mock.fn(async () => {
        count++;
        if (count === 1) throw new Error("fail");
        return { ok: true };
      });
      const result = await sendWithRetry(mockSend, { server: "s", topic: "t" });
      assert.deepEqual(result, { ok: true });
      assert.equal(mockSend.mock.callCount(), 2);
    } finally {
      _internal.delay = originalDelay;
    }
  });

  // ==================== Linear Backoff Delay ====================

  it("should export RETRY_DELAY_MS as 1000", () => {
    assert.equal(typeof RETRY_DELAY_MS, "number", "RETRY_DELAY_MS should be exported as a number");
    assert.equal(RETRY_DELAY_MS, 1000, "RETRY_DELAY_MS should be 1000ms");
  });

  it("should delay between retry attempts with linear backoff", async () => {
    const delayArgs = [];
    const originalDelay = _internal.delay;
    _internal.delay = (ms) => { delayArgs.push(ms); return Promise.resolve(); };
    try {
      const mockSend = mock.fn(async () => { throw new Error("fail"); });
      const result = await sendWithRetry(mockSend, { server: "s", topic: "t" });
      assert.equal(result, null, "should return null after exhausting retries");
      assert.equal(mockSend.mock.callCount(), 3, "should have been called 3 times");
      assert.deepEqual(delayArgs, [1000, 2000], "should delay 1s then 2s (linear backoff)");
    } finally {
      _internal.delay = originalDelay;
    }
  });

});

// ---------------------------------------------------------------------------
// isAskUserQuestion
// ---------------------------------------------------------------------------

describe("isAskUserQuestion", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof isAskUserQuestion, "function");
  });

  it("should return true for AskUserQuestion with questions array", () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{ question: "Which?", header: "Q", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }], multiSelect: false }],
      },
    };
    assert.equal(isAskUserQuestion(input), true);
  });

  it("should return false for non-AskUserQuestion tools", () => {
    assert.equal(isAskUserQuestion({ tool_name: "Bash", tool_input: { command: "ls" } }), false);
  });

  it("should return false when questions is empty array", () => {
    assert.equal(isAskUserQuestion({ tool_name: "AskUserQuestion", tool_input: { questions: [] } }), false);
  });

  it("should return false when questions is not an array", () => {
    assert.equal(isAskUserQuestion({ tool_name: "AskUserQuestion", tool_input: { questions: "not array" } }), false);
  });

  it("should return false for null input", () => {
    assert.equal(isAskUserQuestion(null), false);
  });

  it("should return false for undefined input", () => {
    assert.equal(isAskUserQuestion(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// buildQuestionActions
// ---------------------------------------------------------------------------

describe("buildQuestionActions", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof buildQuestionActions, "function");
  });

  it("should return http actions for each option", () => {
    const options = [
      { label: "Option A", description: "desc A" },
      { label: "Option B", description: "desc B" },
    ];
    const actions = buildQuestionActions("https://ntfy.sh", "topic", "req-1", options);

    assert.equal(actions.length, 2);
    assert.equal(actions[0].action, "http");
    assert.equal(actions[0].label, "Option A");
    assert.equal(actions[1].label, "Option B");
  });

  it("should encode answer in the body", () => {
    const options = [{ label: "My Choice", description: "desc" }];
    const actions = buildQuestionActions("https://ntfy.sh", "topic", "req-1", options);

    const body = JSON.parse(actions[0].body);
    assert.equal(body.requestId, "req-1");
    assert.equal(body.answer, "My Choice");
  });

  it("should use {topic}-response URL", () => {
    const options = [{ label: "A", description: "a" }];
    const actions = buildQuestionActions("https://ntfy.sh", "my-topic", "req-1", options);

    assert.equal(actions[0].url, "https://ntfy.sh/my-topic-response");
  });

  // ==================== Auth (Basic Auth headers) ====================

  it("should include headers with Authorization on each action when auth is provided", async () => {
    const buildAuthHeaderFn = await getBuildAuthHeader();
    assert.ok(buildAuthHeaderFn, "buildAuthHeader must be exported from ntfy.mjs");
    const auth = { username: "user", password: "pass" };
    const options = [
      { label: "Option A", description: "desc A" },
      { label: "Option B", description: "desc B" },
    ];
    const actions = buildQuestionActions("https://ntfy.sh", "topic", "req-qa1", options, { auth });
    const expectedHeaders = buildAuthHeaderFn(auth);
    for (const action of actions) {
      assert.deepEqual(action.headers, expectedHeaders);
    }
  });

  it("should NOT include headers on actions when auth is not provided", () => {
    const options = [{ label: "A", description: "a" }];
    const actions = buildQuestionActions("https://ntfy.sh", "topic", "req-qa2", options);
    for (const action of actions) {
      assert.equal(action.headers, undefined, "actions should not have headers when auth is not provided");
    }
  });
});

// ---------------------------------------------------------------------------
// buildQuestionMessage
// ---------------------------------------------------------------------------

describe("buildQuestionMessage", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof buildQuestionMessage, "function");
  });

  it("should include the question text", () => {
    const msg = buildQuestionMessage("Which color?", [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }]);
    assert.ok(msg.includes("Which color?"), `Should include question, got: ${msg}`);
  });

  it("should include option labels and descriptions", () => {
    const msg = buildQuestionMessage("Pick one", [
      { label: "A", description: "first option" },
      { label: "B", description: "second option" },
    ]);
    assert.ok(msg.includes("A"), `Should include label A, got: ${msg}`);
    assert.ok(msg.includes("first option"), `Should include description, got: ${msg}`);
  });

  it("should include multiSelect note when specified", () => {
    const msg = buildQuestionMessage("Pick many", [{ label: "X", description: "x" }], { multiSelect: true });
    assert.ok(msg.includes("multiple") || msg.includes("複数"), `Should mention multiple selection, got: ${msg}`);
  });

  it("should include batch info when provided", () => {
    const msg = buildQuestionMessage("Pick", [{ label: "A", description: "a" }], { batchInfo: "(1/2)" });
    assert.ok(msg.includes("(1/2)"), `Should include batch info, got: ${msg}`);
  });
});
