# Architecture

`remote-approver` is **serverless**: there is no daemon. Claude Code spawns
a short-lived hook process for each event; that process talks to ntfy and returns
a decision on stdout. State lives only in ntfy's topic + the config file.

## Components

```
Claude Code ──spawn──▶ node bin/cli.mjs hook          (per event, stdin=JSON)
                          │  publish notification ─────────────▶ ntfy  ──push──▶ phone
                          │  subscribe {topic}-response (SSE) ◀── ntfy ◀──tap──── phone
                          ▼
                       decision JSON on stdout ──▶ Claude Code
```

- **ntfy** — HTTP pub/sub. The approver publishes to `{topic}` and listens on
  `{topic}-response`. Self-hostable (see [`../ntfy-server/README.md`](../ntfy-server/README.md)).
- **Config** — `$XDG_CONFIG_HOME/remote-approver/config.json` (default
  `~/.config/remote-approver/config.json`). Holds server URL, topic, auth,
  timeouts, `notify` (master switch), `notifyOnStop`. No secrets live in the repo.
- **Hooks** — registered in `~/.claude/settings.json` under `PermissionRequest`
  (approve/deny, AskUserQuestion, plan review) and `Stop` (completion). Both run
  the same `cli.mjs hook`; it branches on `hook_event_name`.

## Files

| File | Responsibility |
|---|---|
| `bin/cli.mjs` | CLI entry: `init/enable/upgrade[ --check]/disable/test[ --wait]/status/uninstall/hook`. Reads stdin, calls the adapter's `processHook`, writes decision to stdout. Wires deps (incl. `updateNotification = sendNotification`). `test --wait` does a full round-trip check (publish an Ack button, block on `waitForResponse`). |
| `src/adapters/claude-code.mjs` | Claude Code adapter: `processHook`, `processAskUserQuestion`, `processStop`, `buildActions`, `sendWithRetry`, `sendResolved`, `ASK`/`DENY` constants. Translates the CC hook contract to the shared ntfy core. |
| `src/ntfy.mjs` | Agent-agnostic ntfy core (incl. the card visual language: `STATUS` emoji, `STATUS_LABEL`, `statusTitle`, `PRIORITY`): `sendNotification`, `waitForResponse` (SSE), `formatToolInfo`/`formatToolPreview`, `sessionTag`, `formatStopNotification`, `stripMarkdown`, `PRIORITY`. |
| `src/config.mjs` | Load/validate/save config (single XDG path); `generateTopic`; `resolveAuth`. |
| `src/upgrade.mjs` | GitHub-release lookup for `upgrade`: `fetchLatestRelease` (API `releases/latest`), `compareVersions`, `assetUrl` (`remote-approver.tgz` asset). `upgrade` runs `npm install -g <asset>` then the NEW binary's `enable` (which also runs `upgradeConfig`). |
| `src/terminal-watch.mjs` | `watchTerminalAnswer`: polls the session transcript (`transcript_path`) for the `tool_result` of the pending call (matched by tool name + input; the hook input has no `tool_use_id`). Claude Code does not signal or kill a hook whose terminal dialog was answered first, so this is the only cue. |
| `src/hooks.mjs` | Register/unregister hooks in settings.json (`PermissionRequest` + `Stop`); `getHookCommand` (stable global command, else absolute-path fallback); `runInit` (config-only, no hook). |
| `test/*.test.mjs` | Node built-in test runner; shared mocks in `test/helpers.mjs`. |

## PermissionRequest lifecycle (`processHook`)

1. Read config. If `hook_event_name === "Stop"` → `processStop` (fire-and-forget) and return `{}`.
2. If no `topic` configured → return `ASK` (fall back to the terminal prompt).
3. If `notify === false` (master switch) → return `ASK` immediately: no publish, no wait, prompt stays in the terminal.
4. `AskUserQuestion` → `processAskUserQuestion` (option buttons; returns `updatedInput.answers`).
5. Otherwise:
   - `requestId = crypto.randomUUID()` — the anchor that keeps concurrent sessions from crossing.
   - `formatToolInfo(input)` → `{ title (with [project·sid] prefix), message, priority, tags, markdown }`.
   - `buildActions(...)` → `✅ Approve` / `❌ Deny` (+ `✅ Always Approve` when `permission_suggestions` present). Each button is an ntfy `http` action that POSTs `{requestId, approved[, alwaysAllow]}` to `{topic}-response`.
   - `waitForResponse` subscribes to `{topic}-response/json` (SSE) first, then publishes the notification (`sequenceId = requestId`, via `sendWithRetry`) from inside its `onReady` callback — so a fast tap can't land in a publish→subscribe gap and be lost. If the publish fails after retries → `ASK`. It then resolves on the **first** message whose `requestId` matches. Timeout = `planTimeout` for `ExitPlanMode`, else `timeout`.
   - Map the response:
     - `approved === false` → `DENY`
     - `alwaysAllow === true` (+ suggestions) → `allow` with `updatedPermissions`
     - else → `allow`
     - timeout → per `config.onTimeout`: `ask` → `ASK` (default), `allow` → allow, `deny` → deny with a reason message (`AskUserQuestion`: `allow` picks the first option); the card notes it was automatic
     - listener error → `ASK` regardless of `onTimeout`; card shows ⚠️
   - `sendResolved(...)` publishes a same-`sequenceId` update: button-less, title = `statusTitle(...)` (emoji + label + tag; tier C low priority, tier B default) — flips the phone notification from *pending* to *resolved* while preserving history.
   - The phone wait runs alongside `watchTerminalAnswer`; if the terminal answers first the wait is aborted (`waitForResponse` `signal` → `{ cancelled }`), the card flips to 🖥️ and the hook returns `ASK` (ignored by Claude Code).
   - Return the decision as `{ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }`.

## Why concurrent sessions don't cross

All sessions may share a topic. Every request uses a fresh random `requestId`;
`waitForResponse` ignores any response whose `requestId` isn't its own. So stale
taps, re-taps, or another session's replies are filtered out — a tap only ever
resolves the one matching pending request. The `[project·sessionid]` title prefix
is purely cosmetic (tell them apart on the phone).

## Safety model

- **Fail open to the terminal**: any failure (send error, SSE error, timeout,
  bad input) returns `ASK`, so Claude Code shows its normal permission prompt.
  The tool never denies or approves on its own due to an error.
- **`deny`/`ask` rules still apply**: per Claude Code, a hook `allow` does not
  override a matching deny/ask permission rule.
- **No secrets in-repo**: credentials live in the config file (and env).
  Self-hosted ntfy is `deny-all` + Basic auth over TLS.

## Extending

- New per-tool preview: add a case in `formatToolPreview` (`src/ntfy.mjs`).
- New resolved-outcome label: add to the `RESOLVED` map (`src/adapters/claude-code.mjs`).
- New hook event: branch in `processHook` and register it in `src/hooks.mjs`.
- New agent: add `src/adapters/<agent>.mjs` translating its hook contract to the ntfy core.
