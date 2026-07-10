# Deploying ntfy for ai-agent-remote-approver

Guidance for standing up the ntfy server that `remote-approver` publishes to. 
Targeted at **Android** (ntfy app uses a WebSocket "instant delivery" connection — no Firebase/APNs needed).

## Pick a method

| Method | Public port on your box? | TLS | Needs | Best for |
|---|---|---|---|---|
| **Public ntfy.sh** | n/a (managed) | ✅ (theirs) | nothing | fastest start; OK if messages transiting ntfy.sh is acceptable |
| **Cloudflare Tunnel** (`deploy-ntfy-cloudflared.sh`) | **none** 🔒 | ✅ (Cloudflare) | Docker + `cert.pem` + a domain on Cloudflare | **recommended self-host** — zero inbound ports, IP hidden |
| **HTTPS via Caddy** (`deploy-ntfy.sh` + `NTFY_DOMAIN`) | 443 (+80 ACME) | ✅ (Let's Encrypt) | Docker + a domain A-record → the box | you're fine exposing 443 and have a domain pointing at the box |
| **HTTP-only** (`deploy-ntfy.sh`) | `NTFY_PORT` | ❌ cleartext | Docker | trusted LAN / quick test only |

**Rule of thumb:** self-hosting + don't want to expose EC2 → **Cloudflare Tunnel**.
No domain, just want it working → **public ntfy.sh** (`remote-approver setup`).

All self-host scripts create a **private** instance (`auth-default-access: deny-all`)
with one admin user, and print the exact `~/.config/remote-approver/config.json` snippet.

---

## Method A — Cloudflare Tunnel (recommended) · `deploy-ntfy-cloudflared.sh`

No inbound ports opened: `cloudflared` dials **out** to Cloudflare, which
terminates TLS at your public hostname and forwards to ntfy on `localhost`.
Your box's public IP stays hidden.

```
phone / hook  →  Cloudflare edge (TLS)  →  tunnel  →  sbox localhost:2586 (ntfy)
```

### Prerequisites on the box
- **Docker**
- **`~/.cloudflared/cert.pem`** — the Cloudflare account credential. Get it by either:
  - running `cloudflared tunnel login` once (opens a browser, authorize your zone), or
  - copying an existing `cert.pem` from another box that already logged in:
    ```bash
    ssh SRC 'cat ~/.cloudflared/cert.pem' | ssh DST 'mkdir -p ~/.cloudflared && cat > ~/.cloudflared/cert.pem && chmod 600 ~/.cloudflared/cert.pem'
    ```
- A **domain managed by that Cloudflare account** (e.g. `creast.win`).

### Run

```bash
NTFY_DOMAIN=ntfy.example.com ./deploy-ntfy-cloudflared.sh
# or, reusing/naming a tunnel and fixing the user:
NTFY_DOMAIN=ntfy.example.com NTFY_TUNNEL=ntfy NTFY_USER=phil ./deploy-ntfy-cloudflared.sh
```

Remotely (scp + ssh):

```bash
scp -i ~/.ssh/key.pem ntfy-server/deploy-ntfy-cloudflared.sh ubuntu@HOST:/tmp/
ssh -i ~/.ssh/key.pem ubuntu@HOST \
  'NTFY_DOMAIN=ntfy.example.com NTFY_TUNNEL=ntfy bash /tmp/deploy-ntfy-cloudflared.sh'
```

It installs cloudflared, **creates/reuses a named tunnel**, **auto-creates the
DNS record** (`cloudflared tunnel route dns`, via `cert.pem` — no dashboard/API
key needed), runs ntfy bound to `127.0.0.1:NTFY_PORT`, installs a systemd
service, and verifies `https://NTFY_DOMAIN/v1/health` through the edge.

### Env vars

| Var | Default | Meaning |
|---|---|---|
| `NTFY_DOMAIN` | — (required) | public hostname, e.g. `ntfy.creast.win` |
| `NTFY_USER` | `phil` | admin username |
| `NTFY_PASS` | *(auto-generated, printed)* | admin password |
| `NTFY_PORT` | `2586` | localhost port ntfy binds to |
| `NTFY_TUNNEL` | `ntfy` | cloudflared tunnel name (reused if it exists) |
| `NTFY_DIR` | `/opt/ntfy` | ntfy config/data dir |

### Manage

```bash
sudo docker logs -f ntfy                    # ntfy logs
sudo systemctl status cloudflared           # tunnel status
sudo journalctl -u cloudflared -f           # tunnel logs
cloudflared tunnel list                     # tunnels on the account
```

> **Live reference deployment:** ntfy runs on **sbox** at
> `https://ntfy.creast.win` via tunnel `ntfy-sbox`, ntfy bound to
> `127.0.0.1:2586`, deny-all + admin `phil`. Deployed with:
> `NTFY_DOMAIN=ntfy.creast.win NTFY_TUNNEL=ntfy-sbox bash deploy-ntfy-cloudflared.sh`

---

## Method B / C — `deploy-ntfy.sh` (HTTP-only or HTTPS-Caddy)

Use when you don't want Cloudflare in the path. `deploy-ntfy.sh` auto-selects:
- **HTTP-only** (default): `http://<public-ip>:<NTFY_PORT>`. ⚠️ Basic-auth is
  cleartext — lock the security group to your own source IPs.
- **HTTPS via Caddy**: set `NTFY_DOMAIN` (with an A record → the box). Caddy
  auto-issues a Let's Encrypt cert; opens 80/443.

```bash
# HTTP-only (port 8080)
sudo NTFY_USER=phil NTFY_PASS='s3cret' ./deploy-ntfy.sh
# HTTPS with a domain
sudo NTFY_USER=phil NTFY_PASS='s3cret' NTFY_DOMAIN=ntfy.example.com ./deploy-ntfy.sh
```

### Env vars

| Var | Default | Meaning |
|---|---|---|
| `NTFY_USER` / `NTFY_PASS` | — (required) | admin credentials |
| `NTFY_DOMAIN` | *(unset)* | set → HTTPS via Caddy; unset → HTTP-only |
| `NTFY_PORT` | `8080` | host port in HTTP-only mode |
| `NTFY_DIR` | `/opt/ntfy` | install directory |

Manage (compose-based): `cd /opt/ntfy && sudo docker compose {logs -f,restart,down,down -v}`.

---

## After deployment (any method)

1. **Phone (Android):** subscribe in the ntfy app — see below.
2. **Each machine running Claude Code** (local + EC2s): put this in
   `~/.config/remote-approver/config.json`, then run `remote-approver setup` (it
   preserves `ntfyServer`, regenerates the topic, registers the hooks) and
   `remote-approver test`:

   ```json
   {
     "topic": "cra-<32hex>",
     "ntfyServer": "https://ntfy.example.com",
     "ntfyUsername": "phil",
     "ntfyPassword": "<password>",
     "notifyOnStop": true
   }
   ```

   Note: `setup` does **not** prompt for `ntfyServer` — pre-write it (or edit the
   file after), then run setup.

## Subscribe on your phone (Android)

Because the server is **private (`deny-all`)**, you **must enter the username/password**.

1. Install the **ntfy** app — [Google Play](https://play.google.com/store/apps/details?id=io.heckel.ntfy) or [F-Droid](https://f-droid.org/en/packages/io.heckel.ntfy/). The F-Droid build always uses instant delivery (no Firebase).
2. **Add the account first:** Settings → **Users** (Manage users) → add:
   - Server / Base URL: `https://ntfy.example.com`
   - Username: `phil`
   - Password: your password
3. **Subscribe to the topic:** tap **+** → enter your `cra-…` topic → tap **Use another server** and enter `https://ntfy.example.com` → **Subscribe**. The app uses the credentials you added for that server automatically.
4. Send a test from any machine (`remote-approver test`) or via curl:
   ```bash
   curl -u 'phil:<password>' -d "hello from ntfy" https://ntfy.example.com/<your-topic>
   ```

Notes:
- **No custom headers / no certificate import needed.** Custom headers are only
  for proxy-level auth (Cloudflare Access, Tailscale Funnel). Our tunnel exposes
  ntfy directly with its own Basic auth, and the TLS cert is Cloudflare's
  (publicly trusted), so a plain user/password is all you need.
- A `401/403` in the app means the username/password is wrong.
- Self-hosted servers get **instant delivery** (WebSocket), no Firebase/APNs.

## Security notes

- `deny-all` default: only the admin user (or ACL'd users) can read/write.
- Approver topics are 128-bit random (`cra-<32 hex>`) → unguessable path.
- Cloudflare Tunnel mode opens **no** inbound ports and hides the origin IP.
- HTTP-only mode exposes cleartext Basic-auth — never point it at `0.0.0.0/0`.
- `cert.pem` is a secret account credential; if a box is decommissioned, delete
  its `~/.cloudflared/cert.pem` and/or delete the tunnel in the Cloudflare
  Zero Trust dashboard (Networks → Tunnels).
