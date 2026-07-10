#!/usr/bin/env bash
#
# deploy-ntfy.sh — deploy a private, self-hosted ntfy server on an Ubuntu EC2
# box for use with remote-approver (Android instant push, no Firebase).
#
# Run this ON the EC2 instance (Ubuntu 20.04+). It:
#   1. installs Docker + compose plugin if missing
#   2. writes /opt/ntfy/{docker-compose.yml, server.yml} (+ Caddyfile in TLS mode)
#   3. provisions a private (deny-all) instance with one admin user
#   4. starts the stack and prints the exact ~/.config/remote-approver/config.json snippet
#
# Two modes (auto-selected):
#   • HTTP-only (default)  — no domain needed. ntfy on http://<public-ip>:<PORT>.
#                            Android's ntfy app can subscribe over http.
#                            ⚠ Basic-auth travels in cleartext, so LOCK the
#                            security group to known source IPs.
#   • HTTPS via Caddy      — set NTFY_DOMAIN=ntfy.example.com (A record -> this
#                            box). Caddy gets a Let's Encrypt cert automatically.
#
# Usage:
#   sudo NTFY_USER=phil NTFY_PASS='s3cret' ./deploy-ntfy.sh                 # HTTP-only, port 8080
#   sudo NTFY_USER=phil NTFY_PASS='s3cret' NTFY_PORT=8080 ./deploy-ntfy.sh
#   sudo NTFY_USER=phil NTFY_PASS='s3cret' NTFY_DOMAIN=ntfy.example.com ./deploy-ntfy.sh   # HTTPS
#
# Teardown:  cd /opt/ntfy && sudo docker compose down       (add -v to wipe data)

set -euo pipefail

# ─── Config (env-overridable) ────────────────────────────────────────────────
NTFY_DIR="${NTFY_DIR:-/opt/ntfy}"
NTFY_USER="${NTFY_USER:-}"
NTFY_PASS="${NTFY_PASS:-}"
NTFY_DOMAIN="${NTFY_DOMAIN:-}"          # set => HTTPS via Caddy
NTFY_PORT="${NTFY_PORT:-8080}"          # host port in HTTP-only mode
NTFY_IMAGE="${NTFY_IMAGE:-binwiederhier/ntfy:latest}"
CADDY_IMAGE="${CADDY_IMAGE:-caddy:2}"

log()  { printf '\033[1;34m[ntfy-deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "$NTFY_USER" ] || die "NTFY_USER is required (e.g. NTFY_USER=phil)"
[ -n "$NTFY_PASS" ] || die "NTFY_PASS is required (e.g. NTFY_PASS='s3cret')"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "run as root or install sudo"
  SUDO="sudo"
fi

# ─── 1. Docker ───────────────────────────────────────────────────────────────
install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker + compose already present."
    return
  fi
  log "Installing Docker (via get.docker.com)…"
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO systemctl enable --now docker
  docker compose version >/dev/null 2>&1 || die "docker compose plugin missing after install"
}
install_docker

DC="$SUDO docker compose"
DOCKER="$SUDO docker"

# ─── 2. Discover public IP (EC2 IMDSv2 -> IMDSv1 -> ifconfig.me) ──────────────
public_ip() {
  local tok ip
  tok=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
        -H "X-aws-ec2-metadata-token-ttl-seconds: 60" --max-time 2 2>/dev/null || true)
  if [ -n "$tok" ]; then
    ip=$(curl -s -H "X-aws-ec2-metadata-token: $tok" --max-time 2 \
         http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
  fi
  [ -z "${ip:-}" ] && ip=$(curl -s --max-time 2 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
  [ -z "${ip:-}" ] && ip=$(curl -s --max-time 3 https://ifconfig.me 2>/dev/null || true)
  echo "${ip:-}"
}

# ─── 3. Compute BASE_URL + bcrypt hash ───────────────────────────────────────
if [ -n "$NTFY_DOMAIN" ]; then
  MODE="https"
  BASE_URL="https://$NTFY_DOMAIN"
else
  MODE="http"
  IP="$(public_ip)"
  [ -n "$IP" ] || die "could not auto-detect public IP; set NTFY_DOMAIN or NTFY_BASE_URL_IP"
  BASE_URL="http://${IP}:${NTFY_PORT}"
fi

log "Mode: $MODE   Base URL: $BASE_URL"
log "Generating bcrypt hash for user '$NTFY_USER'…"
HASH="$(printf '%s' "$NTFY_PASS" | $DOCKER run --rm -i "$NTFY_IMAGE" user hash 2>/dev/null || true)"
case "$HASH" in
  \$2*) : ;;  # looks like a bcrypt hash
  *) die "failed to generate password hash via '$NTFY_IMAGE user hash'";;
esac

# ─── 4. Write config files ───────────────────────────────────────────────────
$SUDO mkdir -p "$NTFY_DIR/data"

# server.yml — YAML keeps the '$' in the bcrypt hash literal (no interpolation).
$SUDO tee "$NTFY_DIR/server.yml" >/dev/null <<YML
base-url: "$BASE_URL"
cache-file: "/var/lib/ntfy/cache.db"
auth-file: "/var/lib/ntfy/user.db"
auth-default-access: "deny-all"
auth-users:
  - "${NTFY_USER}:${HASH}:admin"
$( [ "$MODE" = "https" ] && echo 'behind-proxy: true' )
YML

if [ "$MODE" = "https" ]; then
  $SUDO tee "$NTFY_DIR/docker-compose.yml" >/dev/null <<'YML'
services:
  ntfy:
    image: binwiederhier/ntfy:latest
    command: serve
    restart: unless-stopped
    volumes:
      - ./server.yml:/etc/ntfy/server.yml:ro
      - ./data:/var/lib/ntfy
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O - http://localhost:80/v1/health | grep -q '\"healthy\":true' || exit 1"]
      interval: 60s
      timeout: 10s
      retries: 3
  caddy:
    image: caddy:2
    restart: unless-stopped
    depends_on: [ntfy]
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy_data:/data
      - ./caddy_config:/config
YML
  $SUDO tee "$NTFY_DIR/Caddyfile" >/dev/null <<CADDY
$NTFY_DOMAIN {
    reverse_proxy ntfy:80
}
CADDY
else
  $SUDO tee "$NTFY_DIR/docker-compose.yml" >/dev/null <<YML
services:
  ntfy:
    image: binwiederhier/ntfy:latest
    command: serve
    restart: unless-stopped
    ports:
      - "${NTFY_PORT}:80"
    volumes:
      - ./server.yml:/etc/ntfy/server.yml:ro
      - ./data:/var/lib/ntfy
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O - http://localhost:80/v1/health | grep -q '\"healthy\":true' || exit 1"]
      interval: 60s
      timeout: 10s
      retries: 3
YML
fi

# ─── 5. Launch ───────────────────────────────────────────────────────────────
log "Starting ntfy…"
( cd "$NTFY_DIR" && $DC pull -q && $DC up -d )

sleep 3
log "Health check:"
if curl -fsS --max-time 5 "${BASE_URL%/}/v1/health" >/dev/null 2>&1; then
  log "  OK — $BASE_URL/v1/health reachable"
else
  warn "  health endpoint not reachable yet from here (TLS cert may still be issuing, or the security group / DNS isn't ready). Check: cd $NTFY_DIR && $SUDO docker compose logs -f"
fi

TOPIC="cra-$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')"

# ─── 6. Summary ──────────────────────────────────────────────────────────────
cat <<EOF

────────────────────────────────────────────────────────────
 ntfy deployed ($MODE)
────────────────────────────────────────────────────────────
 Server URL : $BASE_URL
 Admin user : $NTFY_USER
 Files      : $NTFY_DIR/{server.yml,docker-compose.yml$( [ "$MODE" = https ] && echo ,Caddyfile )}

 NEXT STEPS
 1. Security group: allow inbound $( [ "$MODE" = https ] && echo "443 (and 80 for the ACME challenge)" || echo "$NTFY_PORT" ) .
$( [ "$MODE" = http ]  && echo "    ⚠ HTTP mode: Basic-auth is cleartext. Restrict the SG to YOUR source IPs, not 0.0.0.0/0." )
$( [ "$MODE" = https ] && echo "    Ensure DNS A record: $NTFY_DOMAIN -> this box's public IP (needed before the cert issues)." )
 2. Android ntfy app: add server "$BASE_URL", sign in as "$NTFY_USER", subscribe to your topic.
 3. Point remote-approver at it — write ~/.config/remote-approver/config.json:

    {
      "topic": "$TOPIC",
      "ntfyServer": "$BASE_URL",
      "ntfyUsername": "$NTFY_USER",
      "ntfyPassword": "<your password>",
      "notifyOnStop": true
    }

    …then run:  remote-approver init   (keeps this ntfyServer; regenerates topic; then: enable)
    or keep the topic above and just run:      remote-approver test

 Teardown:  cd $NTFY_DIR && $SUDO docker compose down    (add -v to also delete data)
────────────────────────────────────────────────────────────
EOF
