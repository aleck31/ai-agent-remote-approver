/**
 * Test suite for src/ntfy.mjs — notification sending and receiving
 *
 * Coverage:
 * - buildAuthHeader
 * - sendNotification (incl. priority/tags/markdown passthrough)
 * - waitForResponse
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { sendNotification, waitForResponse, buildAuthHeader } from "../src/ntfy.mjs";
import { createMockFetch, createSSEStream, createStreamingMockFetch, createUnterminatedSSEStream } from "./helpers.mjs";

// ---------------------------------------------------------------------------
// buildAuthHeader
// ---------------------------------------------------------------------------

describe("buildAuthHeader", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof buildAuthHeader, "function");
  });

  it("should return empty object when auth is null", () => {
    const result = buildAuthHeader(null);
    assert.deepEqual(result, {});
  });

  it("should return empty object when auth is undefined", () => {
    const result = buildAuthHeader(undefined);
    assert.deepEqual(result, {});
  });

  it("should return Authorization header with Basic base64 when auth has username and password", () => {
    const result = buildAuthHeader({ username: "user", password: "pass" });
    // btoa("user:pass") === "dXNlcjpwYXNz"
    assert.deepEqual(result, { Authorization: "Basic dXNlcjpwYXNz" });
  });

  it("should handle special characters in username and password", () => {
    const result = buildAuthHeader({ username: "user@domain", password: "p@ss:word" });
    const expected = `Basic ${btoa("user@domain:p@ss:word")}`;
    assert.deepEqual(result, { Authorization: expected });
  });
});

// ---------------------------------------------------------------------------
// sendNotification
// ---------------------------------------------------------------------------

describe("sendNotification", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should be a function exported from the module", () => {
    assert.equal(typeof sendNotification, "function");
  });

  it("should POST to the base server URL for JSON publishing", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "my-topic",
      title: "Test",
      message: "Hello",
      actions: [],
      requestId: "req-001",
    });

    assert.equal(mockFetch.calls.length, 1);
    assert.equal(mockFetch.calls[0].url, "https://ntfy.sh");
  });

  it("should use HTTP POST method", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "test-topic",
      title: "Title",
      message: "Body",
      actions: [],
      requestId: "req-002",
    });

    assert.equal(mockFetch.calls[0].options.method, "POST");
  });

  it("should send Content-Type: application/json header", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "test-topic",
      title: "Title",
      message: "Body",
      actions: [],
      requestId: "req-003",
    });

    const headers = mockFetch.calls[0].options.headers;
    // Headers may be a plain object or Headers instance
    const contentType =
      headers instanceof Headers
        ? headers.get("Content-Type")
        : headers["Content-Type"];
    assert.equal(contentType, "application/json");
  });

  it("should include title and message in the JSON body", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "test-topic",
      title: "Approval Needed",
      message: "Run bash command?",
      actions: [],
      requestId: "req-004",
    });

    const body = JSON.parse(mockFetch.calls[0].options.body);
    assert.equal(body.title, "Approval Needed");
    assert.equal(body.message, "Run bash command?");
  });

  it("should include actions in the JSON body", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    const actions = [
      {
        action: "http",
        label: "Approve",
        url: "https://ntfy.sh/my-response",
        method: "POST",
        body: JSON.stringify({ requestId: "req-005", approved: true }),
      },
      {
        action: "http",
        label: "Deny",
        url: "https://ntfy.sh/my-response",
        method: "POST",
        body: JSON.stringify({ requestId: "req-005", approved: false }),
      },
    ];

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "test-topic",
      title: "Title",
      message: "Body",
      actions,
      requestId: "req-005",
    });

    const body = JSON.parse(mockFetch.calls[0].options.body);
    assert.ok(Array.isArray(body.actions), "body.actions should be an array");
    assert.equal(body.actions.length, 2);
    assert.equal(body.actions[0].label, "Approve");
    assert.equal(body.actions[1].label, "Deny");
  });

  it("should include the topic in the JSON body", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "my-topic",
      title: "T",
      message: "M",
      actions: [],
      requestId: "req-006",
    });

    const body = JSON.parse(mockFetch.calls[0].options.body);
    assert.equal(body.topic, "my-topic");
  });

  it("should return the fetch response", async () => {
    const mockFetch = createMockFetch({ id: "abc123" }, 200);
    globalThis.fetch = mockFetch;

    const result = await sendNotification({
      server: "https://ntfy.sh",
      topic: "test-topic",
      title: "T",
      message: "M",
      actions: [],
      requestId: "req-007",
    });

    assert.ok(result, "should return a response object");
    assert.equal(result.status, 200);
  });

  it("should throw when fetch returns non-ok status", async () => {
    const mockFetch = createMockFetch({}, 500);
    globalThis.fetch = mockFetch;

    await assert.rejects(
      () =>
        sendNotification({
          server: "https://ntfy.sh",
          topic: "test-topic",
          title: "T",
          message: "M",
          actions: [],
          requestId: "req-err",
        }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("HTTP 500"),
          `Error message should include status code, got: "${err.message}"`
        );
        return true;
      }
    );
  });

  it("should handle server URLs with trailing slash", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh/",
      topic: "my-topic",
      title: "T",
      message: "M",
      actions: [],
      requestId: "req-008",
    });

    // Should strip trailing slash and POST to base URL only
    assert.equal(mockFetch.calls[0].url, "https://ntfy.sh");
  });

  // ==================== Auth ====================

  it("should include Authorization header when auth is provided", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "test-topic",
      title: "T",
      message: "M",
      actions: [],
      requestId: "req-auth1",
      auth: { username: "myuser", password: "mypass" },
    });

    const headers = mockFetch.calls[0].options.headers;
    assert.equal(
      headers.Authorization,
      `Basic ${btoa("myuser:mypass")}`,
      "Authorization header should contain Basic auth with base64-encoded credentials"
    );
  });

  it("should NOT include Authorization header when auth is not provided", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "test-topic",
      title: "T",
      message: "M",
      actions: [],
      requestId: "req-noauth1",
    });

    const headers = mockFetch.calls[0].options.headers;
    assert.equal(
      headers.Authorization,
      undefined,
      "Authorization header should not be present when auth is not provided"
    );
  });
});

// ---------------------------------------------------------------------------
// sendNotification — priority/tags/markdown passthrough
// ---------------------------------------------------------------------------

describe("sendNotification (priority/tags/markdown)", () => {
  it("should include priority, tags and markdown in the JSON body when provided", async () => {
    const mockFetch = createMockFetch({}, 200);
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "t",
      title: "T",
      message: "M",
      actions: [],
      requestId: "r",
      priority: 4,
      tags: ["computer"],
      markdown: true,
    });

    const body = JSON.parse(mockFetch.calls[0].options.body);
    assert.equal(body.priority, 4);
    assert.deepEqual(body.tags, ["computer"]);
    assert.equal(body.markdown, true);
  });

  it("should omit priority/tags/markdown when not provided", async () => {
    const mockFetch = createMockFetch({}, 200);
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "t",
      title: "T",
      message: "M",
      actions: [],
      requestId: "r",
    });

    const body = JSON.parse(mockFetch.calls[0].options.body);
    assert.ok(!("priority" in body));
    assert.ok(!("tags" in body));
    assert.ok(!("markdown" in body));
  });
});

// ---------------------------------------------------------------------------
// waitForResponse
// ---------------------------------------------------------------------------

describe("waitForResponse", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should be a function exported from the module", () => {
    assert.equal(typeof waitForResponse, "function");
  });

  it("should subscribe to the response topic via GET", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-100", approved: true }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-100",
      timeout: 5000,
    });

    assert.equal(mockFetch.calls.length, 1);
    const url = mockFetch.calls[0].url;
    assert.ok(
      url.includes("my-topic-response"),
      `URL should include response topic, got: ${url}`
    );
  });

  it("should return { approved: true } when a matching requestId with approved:true is received", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-200", approved: true }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-200",
      timeout: 5000,
    });

    assert.deepEqual(result, { approved: true, alwaysAllow: false });
  });

  it("should return { approved: false } when a matching requestId with approved:false is received", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-201", approved: false }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-201",
      timeout: 5000,
    });

    assert.deepEqual(result, { approved: false, alwaysAllow: false });
  });

  it("should filter messages by requestId and ignore non-matching ones", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "other-id", approved: true }),
      },
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-300", approved: false }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-300",
      timeout: 5000,
    });

    // Should skip the first event (wrong requestId) and return the second
    assert.deepEqual(result, { approved: false, alwaysAllow: false });
  });

  it("should return { timeout: true } on timeout", async () => {
    // Stream that never sends a matching event — just stays open
    const neverMatchStream = new ReadableStream({
      start() {
        // Never enqueue anything, never close — simulates waiting forever
      },
    });
    const mockFetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      body: neverMatchStream,
    }));
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-timeout",
      timeout: 200, // Very short timeout for fast test
    });

    assert.deepEqual(result, { timeout: true });
  });

  it("maps our timeout-abort to { timeout: true } even when read() rejects with a wrapped (non-AbortError) error", async () => {
    // Real fetch rejects the in-flight read() with `TypeError: fetch failed`
    // (NOT a bare AbortError) when the signal aborts mid-stream. The reader here
    // rejects read() once the signal fires, reproducing that path.
    const mockFetch = mock.fn(async (url, options) => {
      const signal = options?.signal;
      return {
        ok: true,
        status: 200,
        body: {
          getReader() {
            return {
              read() {
                return new Promise((_resolve, reject) => {
                  signal?.addEventListener("abort", () => reject(new TypeError("fetch failed")));
                });
              },
              cancel() { return Promise.resolve(); },
            };
          },
        },
      };
    });
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-wrapped-abort",
      timeout: 100,
    });

    assert.deepEqual(result, { timeout: true }, "our own timeout must not be misreported as a network error");
  });

  it("should connect to {server}/{topic}-response/json endpoint", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-400", approved: true }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-400",
      timeout: 5000,
    });

    const url = mockFetch.calls[0].url;
    assert.equal(
      url,
      "https://ntfy.sh/my-topic-response/json",
      `Expected SSE endpoint URL, got: ${url}`
    );
  });

  it("should abort the SSE connection after receiving a matching response", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-abort", approved: true }),
      },
    ];

    /** @type {AbortSignal | undefined} */
    let capturedSignal;

    const mockFetch = mock.fn(async (url, options) => {
      capturedSignal = options?.signal;
      return {
        ok: true,
        status: 200,
        body: createSSEStream(events),
      };
    });
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-abort",
      timeout: 5000,
    });

    assert.deepEqual(result, { approved: true, alwaysAllow: false });
    assert.ok(capturedSignal, "fetch should have been called with a signal");
    assert.equal(
      capturedSignal.aborted,
      true,
      "AbortController should be aborted after matching response to close SSE connection"
    );
  });

  it("should return { answer: string } when matching requestId has an answer field", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-ans", answer: "Option A" }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-ans",
      timeout: 5000,
    });

    assert.deepEqual(result, { answer: "Option A" });
  });

  it("should return { error: Error } on network error", async () => {
    const networkError = new Error("ECONNREFUSED");
    const mockFetch = mock.fn(async () => {
      throw networkError;
    });
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-err",
      timeout: 5000,
    });

    assert.ok(result.error instanceof Error, "should have error property");
    assert.equal(result.error.message, "ECONNREFUSED");
  });

  it("should prioritize answer over approved when both are present", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-both", approved: true, answer: "Option B" }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-both",
      timeout: 5000,
    });

    assert.deepEqual(result, { answer: "Option B" });
  });

  it("should return { approved: true, alwaysAllow: true } when response includes alwaysAllow: true", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-aa1", approved: true, alwaysAllow: true }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-aa1",
      timeout: 5000,
    });

    assert.deepEqual(result, { approved: true, alwaysAllow: true });
  });

  it("should return { approved: true, alwaysAllow: false } when response does not include alwaysAllow", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-aa2", approved: true }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-aa2",
      timeout: 5000,
    });

    assert.deepEqual(result, { approved: true, alwaysAllow: false });
  });

  // ==================== Auth ====================

  it("should include Authorization header when auth is provided", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-auth2", approved: true }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-auth2",
      timeout: 5000,
      auth: { username: "myuser", password: "mypass" },
    });

    const headers = mockFetch.calls[0].options.headers;
    assert.equal(
      headers.Authorization,
      `Basic ${btoa("myuser:mypass")}`,
      "Authorization header should contain Basic auth with base64-encoded credentials"
    );
  });

  it("should NOT include Authorization header when auth is not provided", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-noauth2", approved: true }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-noauth2",
      timeout: 5000,
    });

    const headers = mockFetch.calls[0].options.headers;
    assert.equal(
      headers,
      undefined,
      "No headers object should be present when auth is not provided"
    );
  });

  it("should match a matching line that arrives without a trailing newline before the stream closes", async () => {
    const events = [
      { event: "message", message: JSON.stringify({ requestId: "req-noeol", approved: true }) },
    ];
    const mockFetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      body: createUnterminatedSSEStream(events),
    }));
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-noeol",
      timeout: 5000,
    });

    assert.deepEqual(result, { approved: true, alwaysAllow: false });
  });

  it("should invoke onReady after the subscription connects and before returning", async () => {
    const events = [
      { event: "message", message: JSON.stringify({ requestId: "req-ready", approved: true }) },
    ];
    let connectedWhenReady = false;
    const mockFetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      body: createSSEStream(events),
    }));
    globalThis.fetch = mockFetch;

    const onReady = mock.fn(async () => {
      // fetch (subscribe) must already have been called by the time onReady fires.
      connectedWhenReady = mockFetch.mock.callCount() === 1;
    });

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-ready",
      timeout: 5000,
      onReady,
    });

    assert.equal(onReady.mock.callCount(), 1, "onReady should be called exactly once");
    assert.ok(connectedWhenReady, "onReady must fire only after the SSE connection is established");
    assert.deepEqual(result, { approved: true, alwaysAllow: false });
  });

  it("should propagate a throw from onReady (publish failure aborts the wait)", async () => {
    const mockFetch = createStreamingMockFetch([]);
    globalThis.fetch = mockFetch;

    const boom = new Error("publish failed");
    await assert.rejects(
      () => waitForResponse({
        server: "https://ntfy.sh",
        topic: "my-topic",
        requestId: "req-throw",
        timeout: 5000,
        onReady: async () => { throw boom; },
      }),
      (err) => err === boom
    );
  });
});
