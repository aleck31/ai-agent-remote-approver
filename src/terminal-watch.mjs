import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";

const INITIAL_WINDOW = 256 * 1024;

/**
 * Resolve true once the pending tool call was answered in the terminal, i.e. a
 * tool_result for its tool_use shows up in the session transcript; false if
 * `signal` aborts first. Claude Code neither signals nor kills a running hook
 * when the terminal dialog is answered first, so the transcript is the only cue.
 * The hook input has no tool_use_id, so the call is matched by tool name + input.
 */
export async function watchTerminalAnswer({ transcriptPath, toolName, toolInput, signal, intervalMs = 1500, fsp = fs.promises }) {
  const unresolved = []; // ids of matching tool_use blocks with no result yet
  let target = null;     // set once the initial scan is done
  let scanned = false;
  let offset = -1;
  let tail = "";

  const consume = (line) => {
    let entry;
    try { entry = JSON.parse(line); } catch { return false; }
    const blocks = entry?.message?.content;
    if (!Array.isArray(blocks)) return false;
    for (const b of blocks) {
      if (b.type === "tool_use" && b.name === toolName && isDeepStrictEqual(b.input, toolInput)) {
        if (scanned) target ??= b.id; else unresolved.push(b.id);
      } else if (b.type === "tool_result") {
        if (scanned) { if (b.tool_use_id === target) return true; }
        else { const i = unresolved.indexOf(b.tool_use_id); if (i >= 0) unresolved.splice(i, 1); }
      }
    }
    return false;
  };

  while (!signal?.aborted) {
    try {
      const { size } = await fsp.stat(transcriptPath);
      if (offset < 0) offset = Math.max(0, size - INITIAL_WINDOW);
      if (size > offset) {
        const fh = await fsp.open(transcriptPath, "r");
        try {
          const buf = Buffer.alloc(size - offset);
          await fh.read(buf, 0, buf.length, offset);
          const firstChunk = !scanned && offset > 0;
          offset = size;
          const lines = (tail + buf.toString("utf8")).split("\n");
          tail = lines.pop();
          if (firstChunk) lines.shift(); // starts mid-line
          let seen = false;
          for (const l of lines) if (l && consume(l)) seen = true;
          if (!scanned) { scanned = true; target = unresolved.at(-1) ?? null; }
          else if (seen) return true;
        } finally { await fh.close(); }
      } else if (!scanned) {
        scanned = true;
      }
    } catch { /* transcript not readable yet — keep polling */ }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, intervalMs);
      signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
  return false;
}
