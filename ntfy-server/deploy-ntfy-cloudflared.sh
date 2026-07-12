#!/usr/bin/env bash
#
# deploy-ntfy-cloudflared.sh — deploy private ntfy behind a Cloudflare Tunnel.
# Run ON the target box (Ubuntu). ZERO inbound ports opened: cloudflared reaches
# ntfy on localhost, Cloudflare terminates TLS at your public hostname.
#
# Prereqs on the box:
#   • Docker
#   • ~/.cloudflared/cert.pem  (the account cert from `cloudflared tunnel login`;
#     copy it from another box that already logged in, or run `cloudflared tunnel login`)
#
# Usage:
#   NTFY_DOMAIN=ntfy.example.com ./deploy-ntfy-cloudflared.sh
#   NTFY_DOMAIN=ntfy.example.com NTFY_USER=alex NTFY_PASS='s3cret' ./deploy-ntfy-cloudflared.sh
#
# Env (all optional except NTFY_DOMAIN):
#   NTFY_DOMAIN  (required) public hostname, e.g. ntfy.creast.win
#   NTFY_USER    admin username (default: alex)
#   NTFY_PASS    admin password (default: auto-generated, printed at the end)
#   NTFY_PORT    localhost port for ntfy (default: 2586)
#   NTFY_TUNNEL  cloudflared tunnel name (default: ntfy)
#   NTFY_DIR     ntfy data/config dir (default: /opt/ntfy)

set -euo pipefail

NTFY_DOMAIN="${NTFY_DOMAIN:-}"
NTFY_USER="${NTFY_USER:-alex}"
NTFY_PASS="${NTFY_PASS:-$(openssl rand -hex 16)}"
NTFY_PORT="${NTFY_PORT:-2586}"
NTFY_TUNNEL="${NTFY_TUNNEL:-ntfy}"
NTFY_DIR="${NTFY_DIR:-/opt/ntfy}"
NTFY_IMAGE="${NTFY_IMAGE:-binwiederhier/ntfy:latest}"
CF_DIR="$HOME/.cloudflared"

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "$NTFY_DOMAIN" ] || die "NTFY_DOMAIN is required (e.g. NTFY_DOMAIN=ntfy.example.com)"
command -v docker >/dev/null 2>&1 || die "docker not installed"
[ -f "$CF_DIR/cert.pem" ] || die "missing $CF_DIR/cert.pem — copy it from a logged-in box or run 'cloudflared tunnel login'"

SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

# ─── 1. cloudflared ──────────────────────────────────────────────────────────
if ! command -v cloudflared >/dev/null 2>&1; then
  log "Installing cloudflared…"
  ARCH=$(dpkg --print-architecture)
  curl -fsSL -o /tmp/cloudflared.deb \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb"
  $SUDO dpkg -i /tmp/cloudflared.deb >/dev/null 2>&1 || $SUDO apt-get -f install -y >/dev/null 2>&1
fi
log "cloudflared $(cloudflared --version 2>/dev/null | awk '{print $3}')"

# ─── 2. Tunnel (reuse if exists) ─────────────────────────────────────────────
if cloudflared tunnel list 2>/dev/null | grep -qw "$NTFY_TUNNEL"; then
  log "Reusing existing tunnel '$NTFY_TUNNEL'."
else
  log "Creating tunnel '$NTFY_TUNNEL'…"
  cloudflared tunnel create "$NTFY_TUNNEL" >/dev/null
fi
TID=$(cloudflared tunnel list 2>/dev/null | awk -v n="$NTFY_TUNNEL" '$2==n{print $1}' | head -1)
[ -n "$TID" ] || die "could not resolve tunnel id for '$NTFY_TUNNEL'"
[ -f "$CF_DIR/$TID.json" ] || die "missing credentials file $CF_DIR/$TID.json"
log "Tunnel id: $TID"

# ─── 3. cloudflared config + DNS route ───────────────────────────────────────
cat > "$CF_DIR/config.yml" <<CFG
tunnel: $TID
credentials-file: $CF_DIR/$TID.json

ingress:
  - hostname: $NTFY_DOMAIN
    service: http://localhost:$NTFY_PORT
  - service: http_status:404
CFG
log "Routing DNS $NTFY_DOMAIN -> tunnel…"
cloudflared tunnel route dns "$TID" "$NTFY_DOMAIN" 2>&1 | sed 's/^/  /' || log "(route may already exist)"

# ─── 4. ntfy container (localhost-bound, private) ────────────────────────────
log "Pulling ntfy + hashing password…"
$SUDO docker pull -q "$NTFY_IMAGE" >/dev/null
# 'ntfy user hash' prompts for password AND confirmation -> feed the value twice.
HASH="$(printf '%s\n%s\n' "$NTFY_PASS" "$NTFY_PASS" | $SUDO docker run --rm -i "$NTFY_IMAGE" user hash)"
case "$HASH" in \$2*) : ;; *) die "password hashing failed";; esac

$SUDO mkdir -p "$NTFY_DIR/data"
$SUDO tee "$NTFY_DIR/server.yml" >/dev/null <<YML
base-url: "https://$NTFY_DOMAIN"
cache-file: "/var/lib/ntfy/cache.db"
auth-file: "/var/lib/ntfy/user.db"
auth-default-access: "deny-all"
behind-proxy: true
auth-users:
  - "${NTFY_USER}:${HASH}:admin"
YML

log "Starting ntfy on 127.0.0.1:$NTFY_PORT…"
$SUDO docker rm -f ntfy >/dev/null 2>&1 || true
$SUDO docker run -d --name ntfy --restart unless-stopped \
  -p "127.0.0.1:${NTFY_PORT}:80" \
  -v "$NTFY_DIR/server.yml:/etc/ntfy/server.yml:ro" \
  -v "$NTFY_DIR/data:/var/lib/ntfy" \
  "$NTFY_IMAGE" serve >/dev/null
sleep 3
curl -fsS "http://localhost:${NTFY_PORT}/v1/health" >/dev/null && log "local ntfy healthy" || die "ntfy not healthy on localhost:$NTFY_PORT"

# ─── 5. cloudflared systemd service ──────────────────────────────────────────
log "Installing cloudflared systemd service…"
$SUDO tee /etc/systemd/system/cloudflared.service >/dev/null <<UNIT
[Unit]
Description=cloudflared ($NTFY_DOMAIN)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/cloudflared --no-autoupdate --config $CF_DIR/config.yml tunnel run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
$SUDO systemctl daemon-reload
$SUDO systemctl enable cloudflared >/dev/null 2>&1
$SUDO systemctl restart cloudflared
sleep 6
log "cloudflared: $($SUDO systemctl is-active cloudflared)"

# ─── 6. Verify via Cloudflare edge ───────────────────────────────────────────
log "Checking https://$NTFY_DOMAIN/v1/health via Cloudflare…"
OK=""
for i in $(seq 1 6); do
  if curl -fsS --max-time 8 "https://$NTFY_DOMAIN/v1/health" >/tmp/ntfy_h 2>/dev/null; then
    log "  edge OK: $(cat /tmp/ntfy_h)"; OK=1; break
  fi
  log "  attempt $i not ready, retrying in 5s…"; sleep 5
done
[ -n "$OK" ] || { log "edge not ready; recent logs:"; $SUDO journalctl -u cloudflared --no-pager -n 8 || true; }

cat <<EOF

────────────────────────────────────────────────────────────
 ntfy deployed behind Cloudflare Tunnel (no EC2 inbound ports)
────────────────────────────────────────────────────────────
 Server URL : https://$NTFY_DOMAIN
 Username   : $NTFY_USER
 Password   : $NTFY_PASS
 Tunnel     : $NTFY_TUNNEL ($TID)
 ntfy bind  : 127.0.0.1:$NTFY_PORT   (localhost only)

 On the phone: ntfy app -> add server "https://$NTFY_DOMAIN", sign in, subscribe.
 Approver: put this in ~/.config/remote-approver/config.json on each machine:
   {
     "topic": "cra-<32hex>",
     "ntfyServer": "https://$NTFY_DOMAIN",
     "ntfyUsername": "$NTFY_USER",
     "ntfyPassword": "$NTFY_PASS",
     "notifyOnStop": true
   }

 Manage: sudo docker logs -f ntfy   |   sudo systemctl status cloudflared
────────────────────────────────────────────────────────────
EOF
