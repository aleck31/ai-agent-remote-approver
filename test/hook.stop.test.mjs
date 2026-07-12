/**
 * Test suite for src/adapters/claude-code.mjs — processStop
 *
 * Coverage:
 * - processStop
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { processStop } from "../src/adapters/claude-code.mjs";

// ---------------------------------------------------------------------------
// processStop
// ---------------------------------------------------------------------------

describe("processStop", () => {
  const baseInput = {
    hook_event_name: "Stop",
    cwd: "/home/u/ai-stack",
    session_id: "abcdef123456",
    last_assistant_message: "Done.",
  };

  it("sends a fire-and-forget notification when notifyOnStop is true and returns {}", async () => {
    const sendNotification = mock.fn(async () => ({ ok: true }));
    const config = { topic: "t", ntfyServer: "https://ntfy.sh", notifyOnStop: true };
    const result = await processStop(baseInput, config, { sendNotification, resolveAuth: () => null });

    assert.deepEqual(result, {});
    assert.equal(sendNotification.mock.callCount(), 1);
    const params = sendNotification.mock.calls[0].arguments[0];
    assert.equal(params.title, "\ud83c\udfc1 [ai-stack\u00b7abcdef] Claude Code: Done");
    assert.equal(params.message, "Done.");
    assert.deepEqual(params.actions, []);
  });

  it("does nothing when notifyOnStop is false", async () => {
    const sendNotification = mock.fn(async () => ({ ok: true }));
    const config = { topic: "t", ntfyServer: "https://ntfy.sh", notifyOnStop: false };
    const result = await processStop(baseInput, config, { sendNotification, resolveAuth: () => null });

    assert.deepEqual(result, {});
    assert.equal(sendNotification.mock.callCount(), 0);
  });

  it("does nothing when no topic is configured", async () => {
    const sendNotification = mock.fn(async () => ({ ok: true }));
    const config = { topic: "", ntfyServer: "https://ntfy.sh", notifyOnStop: true };
    const result = await processStop(baseInput, config, { sendNotification, resolveAuth: () => null });

    assert.deepEqual(result, {});
    assert.equal(sendNotification.mock.callCount(), 0);
  });

  it("still returns {} even if the notification send fails", async () => {
    const sendNotification = mock.fn(async () => { throw new Error("boom"); });
    const config = { topic: "t", ntfyServer: "https://ntfy.sh", notifyOnStop: true };
    // sendWithRetry swallows and returns null; processStop must not throw
    const result = await processStop(baseInput, config, { sendNotification, resolveAuth: () => null });
    assert.deepEqual(result, {});
  });
});
