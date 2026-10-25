import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

describe("cli stdin handling", () => {
  it("non-hook commands do not block on an open, never-closed stdin pipe", async () => {
    const child = spawn(process.execPath, [new URL("../bin/cli.mjs", import.meta.url).pathname, "--version"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => { child.kill(); resolve("hung"); }, 5000);
      child.on("exit", (c) => { clearTimeout(t); resolve(c); });
    });
    assert.equal(code, 0);
  });
});
