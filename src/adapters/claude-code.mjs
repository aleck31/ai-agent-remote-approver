// src/adapters/claude-code.mjs — Claude Code hook adapter.
// Translates Claude Code's PermissionRequest/Stop hook contract to the shared
// ntfy core. Other agents get their own adapter alongside this one.

import crypto from "node:crypto";
import { DEFAULT_CONFIG } from "../config.mjs";
import { buildAuthHeader, sessionTag, formatStopNotification, STATUS, cardBody, subtitle } from "../ntfy.mjs";

export const ASK = Object.freeze({ hookSpecificOutput: Object.freeze({ hookEventName: "PermissionRequest", decision: Object.freeze({ behavior: "ask" }) }) });
const DENY = Object.freeze({ hookSpecificOutput: Object.freeze({ hookEventName: "PermissionRequest", decision: Object.freeze({ behavior: "deny" }) }) });
const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 1000;
/** Sentinel thrown from an onReady publish so the wait aborts and falls back to CLI. */
const SEND_FAILED = Symbol("send-failed");
/** @internal Replaceable delay for testing. Do not use outside of tests. */
export const _internal = { delay: ms => new Promise(r => setTimeout(r, ms)) };

/**
 * Build ntfy action buttons for Approve / Deny (and optionally Always Approve).
 *
 * @param {string} server - ntfy server URL
 * @param {string} topic - ntfy topic
 * @param {string} requestId - Unique request identifier
 * @param {object} [options] - Optional settings
 * @param {string[]} [options.permissionSuggestions] - When non-empty, adds an "Always Approve" button
 * @returns {Array<object>} Array of action objects
 */
export function buildActions(server, topic, requestId, { permissionSuggestions, auth } = {}) {
  const url = `${server}/${topic}-response`;
  const authHeaders = auth ? buildAuthHeader(auth) : undefined;
  const actions = [
    {
      action: "http",
      label: "Approve",
      url,
      body: JSON.stringify({ requestId, approved: true }),
      method: "POST",
      ...(authHeaders && { headers: authHeaders }),
    },
    {
      action: "http",
      label: "Deny",
      url,
      body: JSON.stringify({ requestId, approved: false }),
      method: "POST",
      ...(authHeaders && { headers: authHeaders }),
    },
  ];
  if (permissionSuggestions?.length > 0) {
    actions.splice(1, 0, {
      action: "http",
      label: "Always Approve",
      url,
      body: JSON.stringify({ requestId, approved: true, alwaysAllow: true }),
      method: "POST",
      ...(authHeaders && { headers: authHeaders }),
    });
  }
  return actions;
}

/**
 * A single "kept" action for a resolved card — the option the user actually
 * chose, so the actions area still reflects the choice. Same http POST target
 * as the pending buttons (re-tapping just repeats the answer, harmlessly).
 */
export function keptAction(server, topic, requestId, label, bodyObj, { auth } = {}) {
  const authHeaders = auth ? buildAuthHeader(auth) : undefined;
  return {
    action: "http",
    label,
    url: `${server}/${topic}-response`,
    body: JSON.stringify({ requestId, ...bodyObj }),
    method: "POST",
    ...(authHeaders && { headers: authHeaders }),
  };
}

/**
 * Send with retry, returning null on exhausted retries.
 * Uses linear backoff: delay = RETRY_DELAY_MS * attempt (1s, 2s, …).
 */
export async function sendWithRetry(sendFn, params) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await sendFn(params);
    } catch (err) {
      if (i === MAX_RETRIES - 1) {
        console.error(`[remote-approver] Notification failed after ${MAX_RETRIES} attempts:`, err.message, "— Falling back to CLI.");
        return null;
      }
      await _internal.delay(RETRY_DELAY_MS * (i + 1));
    }
  }
  return null;
}

/**
 * Resolved-outcome → state emoji (STATUS). The emoji alone conveys the outcome;
 * no redundant "Approved"/"Denied" word in the title. `always` reuses the allow
 * emoji (it's still an approval).
 */
const RESOLVED_EMOJI = Object.freeze({
  allow:   STATUS.allow,
  always:  STATUS.allow,
  deny:    STATUS.deny,
  answer:  STATUS.answer,
  timeout: STATUS.timeout,
});

/**
 * Replace the pending notification with a resolved, button-less one (same
 * sequenceId), so the phone notification flips from ⏳ pending → outcome while
 * preserving history. The title's leading state emoji IS the outcome (no extra
 * word); `detail` (e.g. the chosen answer) is shown as the body so you can see
 * what you picked. Best-effort; failures swallowed. No-op without updateNotification.
 */
async function sendResolved(updateNotification, { server, topic, requestId, tag, subtitle, body, outcome, action, auth }) {
  if (!updateNotification) return;
  const emoji = RESOLVED_EMOJI[outcome] || STATUS.timeout;
  try {
    await updateNotification({
      server,
      topic,
      sequenceId: requestId,
      requestId,
      // Title: state emoji + [proj·sid]. Subtitle + body live in the markdown card.
      title: `${emoji}${tag ? ` [${tag}]` : ""}`,
      message: cardBody(subtitle, body),
      // Keep ONLY the chosen action (the picked option / Approve|Deny); drop the
      // rest. It stays tappable (ntfy has no disabled button) but re-tapping just
      // repeats the same answer to a topic nobody's listening on — harmless, and
      // it shows in the actions area what you chose. Timeout keeps no button.
      actions: action ? [action] : [],
      priority: 2,
      markdown: true,
      ...(auth && { auth }),
    });
  } catch {
    /* best-effort: the decision has already been returned to Claude Code */
  }
}

/**
 * Check if the input is an AskUserQuestion tool call with questions.
 */
export function isAskUserQuestion(input) {
  return (
    input?.tool_name === "AskUserQuestion" &&
    Array.isArray(input?.tool_input?.questions) &&
    input.tool_input.questions.length > 0
  );
}

/**
 * Build ntfy action buttons for question options.
 */
export function buildQuestionActions(server, topic, requestId, options, { auth } = {}) {
  const url = `${server}/${topic}-response`;
  const authHeaders = auth ? buildAuthHeader(auth) : undefined;
  return options.map((opt) => ({
    action: "http",
    label: opt.label,
    url,
    body: JSON.stringify({ requestId, answer: opt.label }),
    method: "POST",
    ...(authHeaders && { headers: authHeaders }),
  }));
}

/**
 * Build a human-readable message for a question with options.
 */
export function buildQuestionMessage(question, options, opts = {}) {
  const { multiSelect, batchInfo } = opts;
  let msg = question;
  if (batchInfo) msg += ` ${batchInfo}`;
  if (multiSelect) msg += "\n(multiple selections allowed)";
  msg += "\n\n";
  for (const opt of options) {
    msg += `• ${opt.label}: ${opt.description}\n`;
  }
  return msg.trimEnd();
}

/**
 * Process an AskUserQuestion hook request.
 */
export async function processAskUserQuestion(input, deps) {
  const config = deps.loadConfig();
  if (!config.topic) return ASK;

  const auth = deps.resolveAuth ? deps.resolveAuth(config) : null;
  const questions = input.tool_input.questions;
  const answers = {};
  const qTag = sessionTag(input);
  const qTitle = qTag ? `[${qTag}]` : "";

  for (const q of questions) {
    const requestId = crypto.randomUUID();
    const options = q.options;
    const sub = subtitle(q.header || "Question");

    const MAX_BUTTONS = 3;
    const batches = [];
    for (let j = 0; j < options.length; j += MAX_BUTTONS) {
      batches.push(options.slice(j, j + MAX_BUTTONS));
    }

    // Batches share one requestId/sequenceId, so a later resolved update replaces
    // the notification currently shown in the phone's tray.
    let anyBatchSent = false;

    // Publish all batches once the SSE subscription is live (inside onReady), so
    // a fast tap can't land in a publish→subscribe gap.
    const publish = async () => {
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const batchInfo = batches.length > 1 ? `(${i + 1}/${batches.length})` : undefined;
        const actions = buildQuestionActions(config.ntfyServer, config.topic, requestId, batch, { ...(auth && { auth }) });
        const body = buildQuestionMessage(q.question, batch, { multiSelect: q.multiSelect, batchInfo });

        const sent = await sendWithRetry(deps.sendNotification, {
          server: config.ntfyServer,
          topic: config.topic,
          title: `${STATUS.pending}${qTitle ? ` ${qTitle}` : ""}`,
          message: cardBody(sub, body),
          actions,
          requestId,
          sequenceId: requestId,
          priority: 4,
          markdown: true,
          ...(auth && { auth }),
        });
        if (!sent) throw SEND_FAILED;
        anyBatchSent = true;
      }
    };

    // AskUserQuestion uses standard timeout (not planTimeout)
    let response;
    try {
      response = await deps.waitForResponse({
        server: config.ntfyServer,
        topic: config.topic,
        requestId,
        timeout: config.timeout * 1000,
        onReady: publish,
        ...(auth && { auth }),
      });
    } catch (err) {
      if (err === SEND_FAILED) {
        // A later batch failed after an earlier one already reached the phone:
        // resolve the lingering pending card so the user doesn't tap a dead prompt.
        if (anyBatchSent) {
          await sendResolved(deps.updateNotification, {
            server: config.ntfyServer, topic: config.topic, requestId,
            tag: qTag, subtitle: sub, body: q.question, outcome: "timeout",
            ...(auth && { auth }),
          });
        }
        return ASK;
      }
      console.error("[remote-approver] Response listener failed:", err.message, "— Falling back to CLI.");
      return ASK;
    }

    if (response.answer) {
      answers[q.question] = response.answer;
      // Resolved: body = just the question; the chosen option stays as the sole
      // kept button in the actions area (unpicked options dropped).
      await sendResolved(deps.updateNotification, {
        server: config.ntfyServer, topic: config.topic, requestId,
        tag: qTag, subtitle: sub, body: q.question, outcome: "answer",
        action: keptAction(config.ntfyServer, config.topic, requestId, `${STATUS.answer} ${response.answer}`, { answer: response.answer }, { ...(auth && { auth }) }),
        ...(auth && { auth }),
      });
    } else {
      console.error("[remote-approver] No answer received. Falling back to CLI.");
      return ASK;
    }
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        updatedInput: {
          questions: input.tool_input.questions,
          answers,
        },
      },
    },
  };
}

/**
 * Process a Stop hook: fire-and-forget "Claude finished" notification.
 * Opt-in via config.notifyOnStop. Never blocks, never adds actions, and always
 * returns {} so Claude stops normally regardless of send success.
 *
 * @param {object} input - Stop hook input (last_assistant_message, cwd, session_id)
 * @param {object} config - Loaded config
 * @param {object} deps - { sendNotification, resolveAuth }
 * @returns {Promise<object>} Always {}
 */
export async function processStop(input, config, { sendNotification, resolveAuth }) {
  if (!config.notifyOnStop || !config.topic) return {};

  const auth = resolveAuth ? resolveAuth(config) : null;
  const { title, message, priority, markdown } = formatStopNotification(input);

  await sendWithRetry(sendNotification, {
    server: config.ntfyServer,
    topic: config.topic,
    title,
    message,
    actions: [],
    requestId: "stop",
    priority,
    markdown,
    ...(auth && { auth }),
  });

  return {};
}

/**
 * Process a Claude Code hook request.
 *
 * @param {object} input - The hook input payload
 * @param {object} deps - Injected dependencies
 * @param {Function} deps.loadConfig
 * @param {Function} deps.sendNotification
 * @param {Function} deps.waitForResponse
 * @param {Function} deps.formatToolInfo
 * @returns {Promise<object>} Decision JSON
 */
export async function processHook(input, { loadConfig, sendNotification, waitForResponse, formatToolInfo, resolveAuth, updateNotification }) {
  const config = loadConfig();

  if (input?.hook_event_name === "Stop") {
    return processStop(input, config, { sendNotification, resolveAuth });
  }

  if (!config.topic) {
    return ASK;
  }

  // Master switch: when disabled, keep permission prompts in the terminal —
  // don't publish or wait on the phone, just fall back to the native CLI prompt.
  if (config.notify === false) {
    return ASK;
  }

  const auth = resolveAuth ? resolveAuth(config) : null;

  if (isAskUserQuestion(input)) {
    return processAskUserQuestion(input, { loadConfig, sendNotification, waitForResponse, resolveAuth, updateNotification });
  }

  const requestId = crypto.randomUUID();
  const { title, tag, subtitle, body, message, priority, markdown } = formatToolInfo(input);
  const actions = buildActions(config.ntfyServer, config.topic, requestId, {
    permissionSuggestions: input.permission_suggestions,
    ...(auth && { auth }),
  });

  // The chosen button to keep on the resolved card (timeout keeps none).
  const ka = (label, bodyObj) => keptAction(config.ntfyServer, config.topic, requestId, label, bodyObj, { ...(auth && { auth }) });
  const KEPT = {
    // Label word first, then a check/cross — the title already carries the
    // state emoji, so no leading ✅/❌ here (would double up).
    allow:  ka("Approved ✔", { approved: true }),
    always: ka("Always approved ✔", { approved: true, alwaysAllow: true }),
    deny:   ka("Denied ✖", { approved: false }),
  };
  const resolve = (outcome) => sendResolved(updateNotification, {
    server: config.ntfyServer, topic: config.topic, requestId,
    tag, subtitle, body, outcome, action: KEPT[outcome], ...(auth && { auth }),
  });

  // Publish only once the SSE subscription is live (inside onReady), so a fast
  // tap can't land in a publish→subscribe gap. A send failure throws SEND_FAILED
  // to abort the wait and fall back to CLI.
  const publish = async () => {
    const sent = await sendWithRetry(sendNotification, {
      server: config.ntfyServer,
      topic: config.topic,
      title: `${STATUS.pending} ${title}`,
      message,
      actions,
      requestId,
      sequenceId: requestId,
      priority,
      markdown,
      ...(auth && { auth }),
    });
    if (!sent) throw SEND_FAILED;
  };

  let response;
  try {
    const isPlanReview = input.tool_name === "ExitPlanMode";
    const timeout = (isPlanReview ? (config.planTimeout ?? DEFAULT_CONFIG.planTimeout) : config.timeout) * 1000;
    response = await waitForResponse({
      server: config.ntfyServer,
      topic: config.topic,
      requestId,
      timeout,
      onReady: publish,
      ...(auth && { auth }),
    });
  } catch (err) {
    if (err === SEND_FAILED) return ASK;
    console.error("[remote-approver] Response listener failed:", err.message, "— Falling back to CLI.");
    await resolve("timeout");
    return ASK;
  }

  if (response.timeout) {
    console.error("[remote-approver] Timed out waiting for response. Falling back to CLI.");
    await resolve("timeout");
    return ASK;
  }
  if (response.error) {
    console.error("[remote-approver] Response error:", response.error.message, "— Falling back to CLI.");
    await resolve("timeout");
    return ASK;
  }
  if (response.approved === false) {
    await resolve("deny");
    return DENY;
  }
  const decision = { behavior: "allow" };
  if (response.alwaysAllow === true && input.permission_suggestions?.length > 0) {
    decision.updatedPermissions = input.permission_suggestions;
    await resolve("always");
  } else {
    await resolve("allow");
  }
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}
