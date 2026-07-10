// src/ntfy.mjs

export function buildAuthHeader(auth) {
  if (!auth) return {};
  return { Authorization: `Basic ${Buffer.from(auth.username + ':' + auth.password).toString('base64')}` };
}

/**
 * Send a push notification via ntfy.
 *
 * @param {{ server: string, topic: string, title: string, message: string, actions: unknown[], requestId: string, priority?: number, tags?: string[], markdown?: boolean }} params
 * @returns {Promise<Response>}
 */
export async function sendNotification({ server, topic, title, message, actions, requestId, auth, priority, tags, markdown, sequenceId }) {
  const baseUrl = server.replace(/\/+$/, '');
  const url = baseUrl;

  const body = { topic, title, message, actions };
  // Optional enrichment (cherry-picked from claude-ntfy-hook): priority + emoji tags + markdown.
  // Only include when set so we never regress the plain-JSON contract.
  if (Number.isFinite(priority)) body.priority = priority;
  if (Array.isArray(tags) && tags.length > 0) body.tags = tags;
  if (markdown === true) body.markdown = true;
  // sequence_id links messages so a later publish REPLACES this notification
  // (used to flip an approve/deny prompt to a resolved, button-less state).
  if (sequenceId) body.sequence_id = sequenceId;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildAuthHeader(auth) },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`ntfy notification failed: HTTP ${response.status}`);
  }

  return response;
}

/**
 * Parse one SSE line into a response object matching `requestId`, or null when
 * the line is blank, non-JSON, or for a different request.
 *
 * @param {string} line
 * @param {string} requestId
 * @returns {{ approved: boolean, alwaysAllow: boolean } | { answer: string } | null}
 */
function parseResponseLine(line, requestId) {
  if (!line.trim()) return null;
  try {
    const event = JSON.parse(line);
    const parsed = JSON.parse(event.message);
    if (parsed.requestId !== requestId) return null;
    if (typeof parsed.answer === 'string') return { answer: parsed.answer };
    return { approved: parsed.approved, alwaysAllow: parsed.alwaysAllow === true };
  } catch {
    return null; // skip non-JSON lines
  }
}

/**
 * Subscribe to the response topic via SSE and wait for a matching requestId.
 *
 * `onReady` (optional) is invoked once the SSE connection is established, before
 * we start reading. Callers publish the notification from within `onReady` so
 * the subscription is guaranteed live first — otherwise a fast tap could land in
 * the gap between publish and subscribe and be lost (ntfy's /json only streams
 * messages received after connect). onReady failures reject the wait.
 *
 * @param {{ server: string, topic: string, requestId: string, timeout: number, onReady?: () => (void | Promise<void>) }} params
 * @returns {Promise<{ approved: boolean } | { timeout: true } | { error: Error } | { answer: string }>}
 */
export async function waitForResponse({ server, topic, requestId, timeout, auth, onReady }) {
  const baseUrl = server.replace(/\/+$/, '');
  const url = `${baseUrl}/${topic}-response/json`;

  const controller = new AbortController();

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  // An onReady (publish) throw is the caller's failure, not a subscription error:
  // rethrow it verbatim so the caller can act on it, rather than mapping to { error }.
  let onReadyError;
  // Set when OUR timeout fired the abort, so the resulting read rejection is
  // reported as a clean timeout — real fetch wraps the abort as "fetch failed"
  // (not a bare AbortError), which would otherwise look like a network error.
  let timedOut = false;

  try {
    const authHeaders = auth ? buildAuthHeader(auth) : undefined;
    const response = await fetch(url, { signal: controller.signal, ...(authHeaders && { headers: authHeaders }) });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Listen to abort so we can cancel the reader even when the mock stream
    // never closes (the real fetch would propagate the signal, but mocks may not).
    // reader.cancel() rejects if the stream is already errored by the aborted
    // signal — swallow it so it doesn't surface as an unhandled rejection.
    const onAbort = () => { reader.cancel().catch(() => {}); };
    controller.signal.addEventListener('abort', onAbort);

    // Subscription is live: let the caller publish now (no publish→subscribe gap).
    if (onReady) {
      try {
        await onReady();
      } catch (err) {
        onReadyError = err;
        controller.signal.removeEventListener('abort', onAbort);
        controller.abort();
        throw err;
      }
    }

    // Start the timeout AFTER fetch resolves so we measure waiting time only.
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);

    const finish = (result) => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      controller.abort();
      return result;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const result = parseResponseLine(line, requestId);
          if (result) return finish(result);
        }
      }
      // Stream closed: flush any trailing line left without a newline terminator.
      const result = parseResponseLine(buffer, requestId);
      if (result) return finish(result);
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
    }

    clearTimeout(timer);
    return { timeout: true };
  } catch (err) {
    if (timer !== undefined) clearTimeout(timer);
    if (err === onReadyError) throw err; // caller's publish failed — let them handle it
    if (timedOut || err?.name === "AbortError") {
      return { timeout: true };
    }
    console.error("[agent-remote-approver] waitForResponse error:", err.message ?? err);
    return { error: err };
  }
}

/**
 * Strip markdown formatting from text, returning plain text.
 *
 * @param {string} text - Markdown text to strip
 * @returns {string} Plain text with markdown removed
 */
export function stripMarkdown(text) {
  // Input guard
  if (text.length > MAX_INPUT) {
    text = text.slice(0, MAX_INPUT);
  }

  // Order matters: fenced code blocks must be first to prevent processing markdown inside them.
  let result = text
    .replace(/```[\s\S]*?(?:```|$)/g, '')                // Fenced code blocks
    .replace(/^[ \t]*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/gm, '') // Horizontal rules (before list markers)
    .replace(/^#{1,6}\s+/gm, '')                          // Headers
    .replace(/^(?:>[ \t]?)+/gm, '')                       // Block quotes
    .replace(/^[ \t]*[-*+] /gm, '')                       // Unordered list markers with indent
    .replace(/^[ \t]*\d+\. /gm, '');                      // Ordered list markers with indent

  result = stripInline(result);

  return result.replace(/\n{2,}/g, '\n').trim();
}

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const MAX_INPUT = 10000;
const MESSAGE_MAX_LENGTH = 1000;

/**
 * Count consecutive runs of character ch starting at pos.
 *
 * @param {string} text
 * @param {number} pos
 * @param {string} ch
 * @returns {number}
 */
function countRun(text, pos, ch) {
  let count = 0;
  while (pos + count < text.length && text[pos + count] === ch) count++;
  return count;
}

const RE_ALPHANUMERIC = /[a-zA-Z0-9]/;
const RE_WHITESPACE = /\s/;
const RE_ASCII_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isAlphanumeric(ch) { return RE_ALPHANUMERIC.test(ch); }

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isWhitespace(ch) { return RE_WHITESPACE.test(ch); }

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isAsciiPunctuation(ch) { return RE_ASCII_PUNCTUATION.test(ch); }

/**
 * Precompute matched bracket/paren pairs using a stack in O(n).
 * Skips backslash-escaped characters so that \[ \] \( \) don't create false pairs.
 * Returns a Map from opening index to closing index.
 *
 * @param {string} str
 * @param {string} open
 * @param {string} close
 * @returns {Map<number, number>}
 */
function precomputePairs(str, open, close) {
  const pairs = new Map();
  const stack = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === '\\' && i + 1 < str.length && isAsciiPunctuation(str[i + 1])) {
      i += 2;
      continue;
    }
    // Skip code spans — brackets inside are literal
    if (str[i] === '`') {
      const tickCount = countRun(str, i, '`');
      const closeIdx = findBacktickCloser(str, tickCount, i + tickCount);
      if (closeIdx !== -1) {
        i = closeIdx + tickCount;
        continue;
      }
      i += tickCount;
      continue;
    }
    if (str[i] === open) stack.push(i);
    else if (str[i] === close && stack.length > 0) {
      pairs.set(stack.pop(), i);
    }
    i++;
  }
  return pairs;
}

/**
 * Find exactly tickCount consecutive backticks (not more, not less).
 * CommonMark: backslash inside code spans is literal, so no escape skipping.
 *
 * @param {string} text
 * @param {number} tickCount
 * @param {number} start
 * @returns {number}
 */
function findBacktickCloser(text, tickCount, start) {
  let i = start;
  while (i < text.length) {
    if (text[i] === '`') {
      const run = countRun(text, i, '`');
      if (run === tickCount) return i;
      i += run;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Find a closing ~~ for strikethrough, skipping backslash-escaped characters.
 *
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function findStrikethroughCloser(text, start) {
  let i = start;
  while (i < text.length - 1) {
    if (text[i] === '\\' && isAsciiPunctuation(text[i + 1])) {
      i += 2;
      continue;
    }
    if (text[i] === '~' && text[i + 1] === '~') return i;
    i++;
  }
  return -1;
}

/**
 * Find a closer for emphasis marker ch with at least markerLen consecutive chars.
 * Skips \* and \_ (escaped markers).
 * Closer condition: run >= markerLen AND preceding char is not whitespace.
 *
 * @param {string} text
 * @param {string} ch
 * @param {number} markerLen
 * @param {number} start
 * @returns {number}
 */
function findEmphasisCloser(text, ch, markerLen, start) {
  let i = start;
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length && isAsciiPunctuation(text[i + 1])) {
      i += 2;
      continue;
    }
    if (text[i] === ch) {
      const run = countRun(text, i, ch);
      if (run >= markerLen && i > 0 && !isWhitespace(text[i - 1])) return i;
      i += run;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Handle emphasis markers (* or _).
 * Returns { output, nextPos } on success, or null if the run should be treated as literal.
 *
 * @param {string} text
 * @param {number} pos
 * @returns {{ output: string, nextPos: number } | null}
 */
function handleEmphasis(text, pos) {
  const ch = text[pos];

  // Count run length
  const runLen = countRun(text, pos, ch);

  // Opener condition:
  //   - prevChar is NOT alphanumeric (or start of string)
  //   - char after the run is NOT whitespace and not end of string
  const prevChar = pos > 0 ? text[pos - 1] : '';
  const afterIdx = pos + runLen;
  const afterChar = afterIdx < text.length ? text[afterIdx] : '';

  const isOpener = !isAlphanumeric(prevChar) && afterChar !== '' && !isWhitespace(afterChar);

  if (!isOpener) return null;

  // Try matching closest, longest-first (min(runLen, 3) down to 1)
  const maxMarker = Math.min(runLen, 3);
  // NOTE: O(n²) worst case when many openers lack closers (k openers × O(n) scan).
  // Bounded by MAX_INPUT=10000; measured ~163ms worst case. Acceptable for notification text.
  for (let markerLen = maxMarker; markerLen >= 1; markerLen--) {
    let searchFrom = pos + runLen;
    while (true) {
      const idx = findEmphasisCloser(text, ch, markerLen, searchFrom);
      if (idx === -1) break; // no closer found for this markerLen
      const content = text.slice(pos + markerLen, idx);
      if (content.length === 0) {
        // Empty emphasis — skip this closer and keep searching
        searchFrom = idx + countRun(text, idx, ch);
        continue;
      }
      return { output: stripInline(content), nextPos: idx + markerLen };
    }
  }

  return null;
}

/**
 * Strip inline markdown formatting by scanning character by character.
 *
 * @param {string} text
 * @returns {string}
 */
function stripInline(text) {
  // NOTE: Recursive calls for emphasis/strikethrough/link content.
  // Depth bounded by nesting level (shallow in real-world markdown).
  const bracketPairs = precomputePairs(text, '[', ']');
  const parenPairs = precomputePairs(text, '(', ')');

  let out = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '\\' && i + 1 < text.length && isAsciiPunctuation(text[i + 1])) {
      out += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      const tickCount = countRun(text, i, '`');
      const closeIdx = findBacktickCloser(text, tickCount, i + tickCount);
      if (closeIdx !== -1) {
        out += text.slice(i + tickCount, closeIdx);
        i = closeIdx + tickCount;
        continue;
      }
      // Unclosed backtick(s) — output as literal
      out += text.slice(i, i + tickCount);
      i += tickCount;
      continue;
    }

    if (ch === '!' && i + 1 < text.length && text[i + 1] === '[') {
      const closeBracket = bracketPairs.get(i + 1);
      if (closeBracket !== undefined && closeBracket + 1 < text.length && text[closeBracket + 1] === '(') {
        const closeParen = parenPairs.get(closeBracket + 1);
        if (closeParen !== undefined) {
          const altText = text.slice(i + 2, closeBracket);
          out += stripInline(altText);
          i = closeParen + 1;
          continue;
        }
      }
      // Not a valid image — output ! as literal
      out += ch;
      i++;
      continue;
    }

    if (ch === '[') {
      const closeBracket = bracketPairs.get(i);
      if (closeBracket !== undefined && closeBracket + 1 < text.length && text[closeBracket + 1] === '(') {
        const closeParen = parenPairs.get(closeBracket + 1);
        if (closeParen !== undefined) {
          const linkText = text.slice(i + 1, closeBracket);
          out += stripInline(linkText);
          i = closeParen + 1;
          continue;
        }
      }
      // Not a valid link — output as literal
      out += ch;
      i++;
      continue;
    }

    if (ch === '~' && i + 1 < text.length && text[i + 1] === '~') {
      const searchStart = i + 2;
      const closeIdx = findStrikethroughCloser(text, searchStart);
      if (closeIdx !== -1) {
        const content = text.slice(searchStart, closeIdx);
        if (content.length === 0) {
          out += '~~';
          i += 2;
          continue;
        }
        out += stripInline(content);
        i = closeIdx + 2;
        continue;
      }
      // No closer — output ~~ as literal
      out += '~~';
      i += 2;
      continue;
    }

    if (ch === '*' || ch === '_') {
      const result = handleEmphasis(text, i);
      if (result !== null) {
        out += result.output;
        i = result.nextPos;
        continue;
      }
      // Not an opener or no closer — output entire run as literal
      const runLen = countRun(text, i, ch);
      out += text.slice(i, i + runLen);
      i += runLen;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * ntfy numeric priority levels (1=min … 5=max).
 */
export const PRIORITY = Object.freeze({ min: 1, low: 2, default: 3, high: 4, urgent: 5 });

const PREVIEW_MAX_LENGTH = 1000;
// Commands / code / long free-text are clipped short for the phone; the full
// text is always visible in the terminal. Titles/paths are not clipped here.
const CODE_PREVIEW_MAX = 300;

/**
 * Truncate a string to `max` chars, appending "..." when it overflows.
 */
function clip(text, max) {
  return text.length > max ? text.slice(0, max) + "..." : text;
}

/**
 * Wrap literal content (a command, code, a path) in a Markdown code fence so the client renders it verbatim
 * — otherwise `#`, `*`, `_`, backticks etc. in the content are interpreted as Markdown (a leading `#` becomes an <h1>). 
 * Uses a fence longer than the longest backtick run inside, per CommonMark, so content containing ``` doesn't terminate the block early.
 *
 * @param {string} content
 * @param {string} [info] - fence info string (e.g. "diff")
 */
function codeFence(content, info = "") {
  let longest = 0;
  const m = content.match(/`+/g);
  if (m) for (const run of m) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${content}\n${fence}`;
}

/**
 * Render a path/pattern as inline code so Markdown metacharacters in it
 * (underscores, asterisks) aren't interpreted. Inline code can't contain a
 * backtick reliably, so fall back to a fenced block if one is present.
 */
function inlineCode(text) {
  return text.includes("`") ? codeFence(text) : `\`${text}\``;
}

/**
 * Build a rich, markdown-formatted preview of a tool call.
 * Ported from claude-ntfy-hook's _format_tool_preview (nickknissen) and adapted
 * to preserve claude-remote-approver's JSON-fallback contract: whenever the
 * primary field is missing, we fall back to JSON.stringify(tool_input) so the
 * notification still carries the raw payload.
 *
 * @returns {{ message: string, tags: string[], priority: number }}
 */
export function formatToolPreview(tool_name, tool_input) {
  const input = tool_input && typeof tool_input === "object" ? tool_input : {};
  const json = () => JSON.stringify(tool_input);

  switch (tool_name) {
    case "Bash": {
      const cmd = input.command;
      if (typeof cmd !== "string" || cmd === "") {
        return { message: json(), tags: ["computer"], priority: PRIORITY.high };
      }
      // Fence the command so shell metacharacters (#, *, backticks) render
      // verbatim; the description, when present, is a plain line above it.
      const fenced = codeFence(clip(cmd, CODE_PREVIEW_MAX));
      const msg = input.description ? `${input.description}\n${fenced}` : fenced;
      return { message: msg, tags: ["computer"], priority: PRIORITY.high };
    }

    case "Write": {
      const path = input.file_path;
      if (typeof path !== "string") {
        return { message: json(), tags: ["pencil2"], priority: PRIORITY.high };
      }
      const content = typeof input.content === "string" ? input.content : "";
      const lineCount = content ? content.split("\n").length : 0;
      return { message: `${inlineCode(path)} — ${lineCount} lines`, tags: ["pencil2"], priority: PRIORITY.high };
    }

    case "Edit": {
      const path = input.file_path;
      if (typeof path !== "string") {
        return { message: json(), tags: ["pencil2"], priority: PRIORITY.high };
      }
      const oldStr = typeof input.old_string === "string" ? input.old_string : "";
      const newStr = typeof input.new_string === "string" ? input.new_string : "";
      const oldP = clip(oldStr, 200);
      const newP = clip(newStr, 200);
      // One fence long enough for both sides, so a ``` inside old/new can't break it.
      const diff = codeFence(`- ${oldP}\n+ ${newP}`, "diff");
      return {
        message: `${inlineCode(path)}\n${diff}`,
        tags: ["pencil2"],
        priority: PRIORITY.high,
      };
    }

    case "Read": {
      const path = input.file_path;
      if (typeof path !== "string") {
        return { message: json(), tags: ["eyes"], priority: PRIORITY.high };
      }
      return { message: inlineCode(path), tags: ["eyes"], priority: PRIORITY.high };
    }

    case "Glob":
    case "Grep": {
      const pattern = input.pattern;
      if (typeof pattern !== "string") {
        return { message: json(), tags: ["mag"], priority: PRIORITY.high };
      }
      const where = input.path || ".";
      return { message: `${inlineCode(pattern)} in ${inlineCode(where)}`, tags: ["mag"], priority: PRIORITY.high };
    }

    case "WebFetch": {
      const url = input.url;
      if (typeof url !== "string") return { message: json(), tags: ["globe_with_meridians"], priority: PRIORITY.high };
      return { message: inlineCode(url), tags: ["globe_with_meridians"], priority: PRIORITY.high };
    }

    case "WebSearch": {
      const query = input.query;
      if (typeof query !== "string") return { message: json(), tags: ["globe_with_meridians"], priority: PRIORITY.high };
      return { message: inlineCode(query), tags: ["globe_with_meridians"], priority: PRIORITY.high };
    }

    case "Task": {
      const desc = clip(input.description || "", CODE_PREVIEW_MAX);
      const agent = input.subagent_type || "";
      const msg = agent ? `**[${agent}]** ${desc}` : desc || json();
      return { message: msg, tags: ["robot"], priority: PRIORITY.high };
    }

    default:
      return { message: json(), tags: ["lock"], priority: PRIORITY.high };
  }
}

/**
 * Build a short session/project tag from the hook input so concurrent Claude
 * Code sessions are distinguishable on the phone. Uses the project folder name
 * (basename of cwd) plus a short slice of session_id to disambiguate two
 * sessions in the same directory. Returns "" when no cwd/session_id is present
 * (e.g. in unit tests), leaving titles unchanged.
 *
 * @param {{ cwd?: string, session_id?: string }} input
 * @returns {string}
 */
export function sessionTag({ cwd, session_id } = {}) {
  const parts = [];
  if (typeof cwd === "string" && cwd) {
    const base = cwd.split(/[/\\]/).filter(Boolean).pop();
    if (base) parts.push(base);
  }
  if (typeof session_id === "string" && session_id) parts.push(session_id.slice(0, 6));
  return parts.join("\u00b7"); // middle dot
}

/**
 * Build a one-shot "Claude finished" notification from a Stop hook input.
 * Title carries the [project·sessionid] prefix so you can tell which session
 * finished; body is a preview of Claude's last message. Fire-and-forget: no
 * actions, no blocking.
 *
 * @param {{ cwd?: string, session_id?: string, last_assistant_message?: string }} input
 * @returns {{ title: string, message: string, priority: number, tags: string[], markdown: boolean }}
 */
export function formatStopNotification({ cwd, session_id, last_assistant_message } = {}) {
  const tag = sessionTag({ cwd, session_id });
  const prefix = tag ? `[${tag}] ` : "";
  let msg = typeof last_assistant_message === "string" ? last_assistant_message.trim() : "";
  if (!msg) msg = "Task complete.";
  return {
    title: `${prefix}Claude 干完了`,
    message: clip(msg, 400),
    priority: PRIORITY.default,
    tags: ["white_check_mark"],
    markdown: true,
  };
}

/**
 * Format tool information for display in the notification.
 *
 * Returns a rich, markdown-formatted preview plus ntfy priority + emoji tags.
 * The title is prefixed with a [project·sessionid] tag (when the hook input
 * carries cwd/session_id) so multiple concurrent sessions are distinguishable.
 * ExitPlanMode is treated specially: its plan text is markdown-stripped and
 * shown at default priority.
 *
 * @param {{ hook_event_name: string, tool_name: string, tool_input: Record<string, unknown>, cwd?: string, session_id?: string }} params
 * @returns {{ title: string, message: string, priority: number, tags: string[], markdown: boolean }}
 */
export function formatToolInfo({ hook_event_name, tool_name, tool_input, cwd, session_id }) {
  const tag = sessionTag({ cwd, session_id });
  const prefix = tag ? `[${tag}] ` : "";

  if (tool_name === 'ExitPlanMode' && typeof tool_input?.plan === 'string') {
    const plain = tool_input.plan.trim() ? stripMarkdown(tool_input.plan) : '';
    const message = clip(plain || '(empty plan)', PREVIEW_MAX_LENGTH);
    return {
      title: `${prefix}Claude Code: Plan Review`,
      message,
      priority: PRIORITY.default,
      tags: ['clipboard'],
      markdown: false,
    };
  }

  const { message, tags, priority } = formatToolPreview(tool_name, tool_input);
  return {
    title: `${prefix}Claude Code: ${tool_name}`,
    message: clip(message, PREVIEW_MAX_LENGTH),
    priority,
    tags,
    markdown: true,
  };
}
