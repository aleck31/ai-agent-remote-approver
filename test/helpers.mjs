/**
 * Shared test helpers for the remote-approver test suite.
 */

import { mock } from "node:test";

// ---------------------------------------------------------------------------
// From hook.test.mjs — createDeps and sampleInput
// ---------------------------------------------------------------------------

/**
 * Creates a standard set of dependency stubs for processHook.
 * Override individual stubs as needed in each test.
 */
export function createDeps(overrides = {}) {
  const defaultConfig = {
    topic: "test-topic",
    ntfyServer: "https://ntfy.sh",
    timeout: 120,
    planTimeout: 300,
    autoApprove: [],
    autoDeny: [],
  };

  return {
    loadConfig: mock.fn(() => overrides.config ?? defaultConfig),
    sendNotification: mock.fn(async () => ({ ok: true, status: 200 })),
    // Mirror real waitForResponse: the subscription is live, so the caller
    // publishes via onReady before we resolve. Propagate a publish throw.
    waitForResponse: mock.fn(
      async ({ onReady } = {}) => {
        if (onReady) await onReady();
        return overrides.waitResult ?? { approved: true };
      }
    ),
    formatToolInfo: mock.fn(() => overrides.toolInfo ?? {
      title: "Claude Code: Bash",
      message: "echo hello",
    }),
    ...overrides,
  };
}

/**
 * A waitForResponse mock that mirrors real semantics: the subscription is live,
 * so it invokes onReady (where the caller publishes) before resolving `result`.
 * A publish throw propagates, just like the real function.
 */
export function mockWaitForResponse(result) {
  return mock.fn(async ({ onReady } = {}) => {
    if (onReady) await onReady();
    return result;
  });
}

/** Standard input mimicking a Claude Code hook payload. */
export const sampleInput = {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "echo hello" },
};

// ---------------------------------------------------------------------------
// From ntfy.test.mjs — mock factories
// ---------------------------------------------------------------------------

/**
 * Creates a mock fetch that captures the request and returns a canned response.
 */
export function createMockFetch(responseBody = {}, status = 200) {
  const calls = [];
  const fn = mock.fn(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    };
  });
  fn.calls = calls;
  return fn;
}

/**
 * Creates a ReadableStream that emits newline-delimited JSON lines (SSE-style)
 * after a short delay, then closes.
 */
export function createSSEStream(events) {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        // Small delay to simulate network
        await new Promise((r) => setTimeout(r, 10));
      }
      controller.close();
    },
  });
}

/**
 * Like createSSEStream but emits the whole payload as one chunk with NO trailing
 * newline, then closes — exercising the "flush the last buffered line" path.
 */
export function createUnterminatedSSEStream(events) {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const payload = events.map((e) => JSON.stringify(e)).join("\n"); // no trailing \n
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

/**
 * Creates a mock fetch that returns a streaming response (for SSE subscriptions).
 */
export function createStreamingMockFetch(events) {
  const calls = [];
  const fn = mock.fn(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      body: createSSEStream(events),
    };
  });
  fn.calls = calls;
  return fn;
}
