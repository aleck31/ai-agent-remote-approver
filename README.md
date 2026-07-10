# Remote Approver for AI Agent

Approve / deny AI coding agent permission prompts from your phone — via **ntfy**. Works with **Claude Code** today (incl. **plain Bedrock**, no claude.ai / Console auth needed); other agents (e.g. **kiro-cli**) can be added via adapters. Also sends completion notifications.

The transport (ntfy) is agent-agnostic; per-agent **adapters** translate each agent's hook contract to the shared core:
- **Claude Code** — `PermissionRequest` hook returning an allow/deny/ask JSON decision (current implementation).
- **Other agents** — e.g. kiro-cli's `preToolUse` hook (allow=exit 0 / deny=exit 2). Not yet implemented; the ntfy core (`src/ntfy.mjs`) is reusable.

## Why this design

| Decision | Rationale |
|---|---|
| Modern `PermissionRequest` hook (returns `allow`/`deny`/`ask`) | No PreToolUse exit-code hacks, **no keyboard injection** — the phone button *is* the decision. Works on any OS incl. Linux EC2. |
| **Serverless** — the hook process itself subscribes to the ntfy response topic via SSE | No long-running daemon, **no Tailscale**. |
| Cherry-picked **rich formatting** | Bash shows description + command, Edit shows a diff, Write shows line count; each tool gets an emoji tag + priority. |
| Timeout → **fall back to CLI** (not deny) | Safe: if the phone never answers, you just get the normal terminal prompt. |
| Basic-auth support | Lets you point at a **private self-hosted ntfy**. |

### Dropped from claude-ntfy-hook (not needed here)
Tailscale, the local HTTP callback server, Windows `SendKeys` keyboard injection / terminal-PID discovery, and the re-implemented permission matcher. All obsolete once the phone button returns the decision directly and the callback rides the ntfy response topic.

## Features

- **Approve / Deny / Always-Approve** (Always-Approve writes back `updatedPermissions`).
- **Notification resolves in place** — after you tap, the pending prompt is *replaced* (via ntfy `sequence_id`) with a button-less card showing the outcome: `✅ Approved` / `✅ Always-approved` / `❌ Denied` / `💬 Answered` / `⏱️ Timed out → CLI`. No more "both buttons ticked" confusion, and the final decision stays in history.
- **Distinguish concurrent sessions**: each notification title is prefixed with `[project·sessionid]` (project = basename of the session's `cwd`, sessionid = first 6 chars of `session_id`), so multiple Claude Code sessions are told apart at a glance. Approve/Deny routing was already isolated per request via a random `requestId` over the shared response topic — the prefix just makes them visually distinct.
- **AskUserQuestion** — option buttons on your phone (auto-batched into groups of 3, ntfy's action limit).
- **Plan review** (`ExitPlanMode`) with a longer, separate timeout.
- **Rich previews:** Bash (description + command), Edit (diff), Write (line count), Read/Glob/Grep/WebFetch/WebSearch/Task, with per-tool emoji tags + `high` priority.
- **Self-hosted ntfy + Basic auth.**
- **Retry with backoff**, and **timeout → CLI fallback**.

## Install

```bash
cd ai-agent-remote-approver
npm install
npm test           # node --test, split across test/*.test.mjs
npm link           # optional: exposes the `remote-approver` command globally
```

## Quick start (public ntfy.sh)

```bash
remote-approver setup     # generates a random topic, registers the hook, prints a QR code
```

Scan the QR in the ntfy Android app, then use Claude Code normally. When Claude wants a permission, your phone buzzes with Approve/Deny buttons.

Config lives at `~/.config/remote-approver/config.json`:

```json
{
  "topic": "cra-<random-hex>",
  "ntfyServer": "https://ntfy.sh",
  "timeout": 120,
  "planTimeout": 300,
  "ntfyUsername": "",
  "ntfyPassword": "",
  "notifyOnStop": false
}
```

### Completion notifications (opt-in)

Set `"notifyOnStop": true` to get a one-shot push when Claude finishes a turn — title `[project·sessionid] Claude 干完了`, body = a preview of Claude's last message, no buttons. It fires on the `Stop` hook, which is registered automatically at `setup`, so you only flip the config flag — **no re-running setup**. Default is `false` (no completion notifications, no noise). Only the once-per-turn `Stop` event is used; per-tool activity is deliberately not streamed.

### Configuration reference

`~/.config/remote-approver/config.json` (mode `0600`):

| Field | Default | Meaning |
|---|---|---|
| `topic` | *(generated)* | ntfy topic to publish to; responses ride `{topic}-response`. 128-bit random `cra-<32hex>` — unguessable. |
| `ntfyServer` | `https://ntfy.sh` | ntfy base URL. Point at your self-hosted instance. `setup` does **not** prompt for this — pre-write it or edit after. |
| `timeout` | `120` | Seconds to wait for a phone tap before falling back to the CLI prompt. |
| `planTimeout` | `300` | Longer timeout for `ExitPlanMode` (plan review). |
| `ntfyUsername` / `ntfyPassword` | `""` | Basic-auth for a private (`deny-all`) server. Env `NTFY_USERNAME` / `NTFY_PASSWORD` override the file. |
| `notifyOnStop` | `false` | Send the one-shot "finished" push on `Stop`. |

### Fleet setup (multiple machines)

Recommended for several machines (e.g. laptop + EC2s): **one topic per machine, one shared ntfy account.**

- Give each machine its **own** `topic` (subscribe to each on the phone, name them e.g. *laptop* / *devClient* / *sbox*). This lets you tell machines apart at the subscription level and mute/rotate per machine.
- Within a machine, concurrent sessions are still distinguished by the `[project·sessionid]` title prefix.
- The same ntfy user/password is used by **every publisher (each machine's hook) and the phone subscriber** — the server is `deny-all`, so all of them authenticate. A single admin account is fine for a personal fleet; for tighter isolation, create per-machine users with per-topic write ACLs plus a read-all user for the phone.
- To wire a machine **without changing its topic**, pre-write its config then run `remote-approver enable` (registers the hooks, keeps the topic). Use `setup` only for first-time provisioning — it regenerates the topic.

## Self-hosted ntfy on EC2 (Android, recommended)

On **Android** the ntfy app uses a WebSocket "instant delivery" connection to your own server — **no Firebase, no APNs, no upstream forwarding**. Full privacy, instant push. (iOS would additionally need `upstream-base-url: https://ntfy.sh`; not relevant here.)

> **Deploy scripts** (see [`ntfy-server/README.md`](ntfy-server/README.md) for the full guide + method comparison):
> - **Cloudflare Tunnel (recommended)** — [`ntfy-server/deploy-ntfy-cloudflared.sh`](ntfy-server/deploy-ntfy-cloudflared.sh): **zero inbound ports**, TLS + IP hidden by Cloudflare. Needs Docker + a `cert.pem` + a domain on Cloudflare.
> - **HTTP-only / HTTPS-Caddy** — [`ntfy-server/deploy-ntfy.sh`](ntfy-server/deploy-ntfy.sh): direct exposure (`NTFY_PORT`, or 443 via Caddy when `NTFY_DOMAIN` is set).
>
> All create a private (`deny-all`) instance with an admin user and print your `~/.config/remote-approver/config.json` snippet. The manual steps below are the Caddy equivalent, for reference.

### 1. Run ntfy (single Go binary) with Caddy auto-TLS

`docker-compose.yml` on the EC2 box:

```yaml
services:
  ntfy:
    image: binwiederhier/ntfy
    command: serve
    restart: unless-stopped
    environment:
      NTFY_BASE_URL: https://ntfy.your-domain.com
      NTFY_LISTEN_HTTP: ":2586"
      NTFY_BEHIND_PROXY: "true"
      NTFY_AUTH_FILE: /var/lib/ntfy/user.db
      NTFY_AUTH_DEFAULT_ACCESS: deny-all      # private instance
      NTFY_CACHE_FILE: /var/lib/ntfy/cache.db
    volumes:
      - ./ntfy:/var/lib/ntfy

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - ./caddy_data:/data
```

`Caddyfile` (Caddy handles Let's Encrypt automatically):

```
ntfy.your-domain.com {
    reverse_proxy ntfy:2586
}
```

### 2. Create a user (private instance)

```bash
docker compose exec ntfy ntfy user add --role=admin phil
docker compose exec ntfy ntfy access phil "cra-*" rw     # allow your approver topics
```

### 3. Point the approver at your server

Edit `~/.config/remote-approver/config.json`:

```json
{
  "topic": "cra-<random-hex>",
  "ntfyServer": "https://ntfy.your-domain.com",
  "ntfyUsername": "phil",
  "ntfyPassword": "your-password"
}
```

Or pass creds via env (`NTFY_USERNAME` / `NTFY_PASSWORD`) — env wins over the file.

### 4. Subscribe on the phone

In the ntfy Android app: add your server `https://ntfy.your-domain.com`, sign in as `phil`, subscribe to your `cra-...` topic. Run `remote-approver test --wait` to verify the full round trip — it sends an **Ack** button and blocks until you tap it, confirming both publish and the SSE callback reach this machine (a plain `test` only confirms the publish).

> Security notes: open **only 443** to the internet on the EC2 security group, keep `auth-default-access: deny-all`, and use a topic name that is unguessable (the generated `cra-<32 hex>` already is).

## Commands

```
remote-approver setup       # generate topic, register hook, print QR
remote-approver test        # send a test notification (one-way)
remote-approver test --wait # round-trip check: sends an "Ack" button and blocks until you tap it
remote-approver status      # show current config
remote-approver disable     # temporarily remove the hook
remote-approver enable      # re-add the hook
remote-approver uninstall   # remove hook + delete config
```

The hooks are registered under `hooks.PermissionRequest` (approve/deny + AskUserQuestion + plan review) and `hooks.Stop` (completion notification) in `~/.claude/settings.json`. Both run the same `cli.mjs hook` command, which branches on the event. `enable`/`disable` toggle the hooks without touching your topic; `setup` regenerates the topic.

## What changed vs the base (claude-remote-approver)

- **Rich per-tool previews** (`src/ntfy.mjs`): `formatToolInfo` → `formatToolPreview` + a `PRIORITY` map; `priority` / `tags` / `markdown` threaded through `sendNotification`. The JSON-fallback contract (missing primary field → raw `JSON.stringify(tool_input)`) is preserved.
- **Session tag** (`sessionTag`): titles prefixed `[project·sessionid]` so concurrent sessions are distinguishable.
- **Resolve-in-place** (`sequence_id`): after a decision, the notification is replaced with a button-less `✅/❌/💬/⏱️` outcome card (`updateNotification` in `src/hook.mjs`).
- **Completion notification** (`notifyOnStop`): opt-in `Stop` hook (`processStop` + `formatStopNotification`), registered alongside `PermissionRequest`.
- **Setup**: hook detection matches this fork's path and the upstream marker; `registerStopHook` added.
- **Tests**: split by concern across `test/*.test.mjs` with shared mocks in `test/helpers.mjs`, via `node --test`.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the hook lifecycle and request/response flow, and [`ntfy-server/README.md`](ntfy-server/README.md) for self-hosting ntfy.
