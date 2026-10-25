import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { watchTerminalAnswer } from "../src/terminal-watch.mjs";
import { waitForResponse } from "../src/ntfy.mjs";
import { processHook } from "../src/adapters/claude-code.mjs";
import { createDeps } from "./helpers.mjs";

const use = (id, input, name = "Bash") => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } }) + "\n";
const result = (id) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }) + "\n";
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tw-")), "t.jsonl");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const input = { command: "touch x" };

describe("watchTerminalAnswer", () => {
  it("resolves true when the matching tool_use gets a result", async () => {
    const f = tmp();
    fs.writeFileSync(f, use("t1", input));
    const ac = new AbortController();
    const p = watchTerminalAnswer({ transcriptPath: f, toolName: "Bash", toolInput: input, signal: ac.signal, intervalMs: 20 });
    await sleep(60);
    fs.appendFileSync(f, result("t1"));
    assert.equal(await p, true);
  });

  it("ignores an earlier, already-resolved identical call", async () => {
    const f = tmp();
    fs.writeFileSync(f, use("old", input) + result("old") + use("new", input));
    const ac = new AbortController();
    const p = watchTerminalAnswer({ transcriptPath: f, toolName: "Bash", toolInput: input, signal: ac.signal, intervalMs: 20 });
    await sleep(100);
    ac.abort();
    assert.equal(await p, false);
  });

  it("ignores results for other tool calls", async () => {
    const f = tmp();
    fs.writeFileSync(f, use("a", input));
    const ac = new AbortController();
    const p = watchTerminalAnswer({ transcriptPath: f, toolName: "Bash", toolInput: input, signal: ac.signal, intervalMs: 20 });
    await sleep(60);
    fs.appendFileSync(f, result("other"));
    await sleep(60);
    ac.abort();
    assert.equal(await p, false);
  });

  it("tolerates a missing transcript and returns false on abort", async () => {
    const ac = new AbortController();
    const p = watchTerminalAnswer({ transcriptPath: "/nonexistent/t.jsonl", toolName: "Bash", toolInput: input, signal: ac.signal, intervalMs: 20 });
    await sleep(50);
    ac.abort();
    assert.equal(await p, false);
  });
});

describe("waitForResponse signal", () => {
  it("returns { cancelled } when the caller aborts", async () => {
    const server = http.createServer((req, res) => { res.writeHead(200); res.write("\n"); });
    await new Promise((r) => server.listen(0, r));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r = await waitForResponse({ server: `http://127.0.0.1:${server.address().port}`, topic: "t", requestId: "r", timeout: 5000, signal: ac.signal });
    server.closeAllConnections(); server.close();
    assert.deepEqual(r, { cancelled: true });
  });
});

describe("processHook terminal answer", () => {
  it("resolves the card as 🖥️ and falls back when the terminal answers first", async () => {
    const deps = createDeps({ config: { topic: "t", ntfyServer: "https://ntfy.sh", timeout: 5 } });
    deps.updateNotification = (await import("node:test")).mock.fn(async () => {});
    deps.watchTerminal = async () => true;
    deps.waitForResponse = async ({ signal, onReady }) => {
      if (onReady) await onReady();
      if (!signal.aborted) await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
      return { cancelled: true };
    };
    const r = await processHook({ tool_name: "Bash", tool_input: { command: "ls" }, transcript_path: "/x", session_id: "abcdef", cwd: "/p" }, deps);
    assert.equal(r.hookSpecificOutput.decision.behavior, "ask");
    const upd = deps.updateNotification.mock.calls[0].arguments[0];
    assert.match(upd.title, /^🖥️/);
    assert.match(upd.message, /Answered in terminal/);
  });
});
