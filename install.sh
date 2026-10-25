#!/usr/bin/env bash
# Idempotent installer / upgrader for remote-approver.
#   From a checkout:  ./install.sh   → packs THIS checkout and installs it globally.
#   Standalone:       curl -fsSL https://raw.githubusercontent.com/aleck31/ai-agent-remote-approver/main/install.sh | bash
#                     → installs the latest GitHub release.
# Then: init (only when no topic yet) + enable (registers hooks, adds new config fields).
# Re-running is safe: it never regenerates an existing topic.
set -euo pipefail

RELEASE_URL="https://github.com/aleck31/ai-agent-remote-approver/releases/latest/download/remote-approver.tgz"

# Global install needs a writable prefix. If it's a system dir (e.g. /usr),
# point npm at a user-level prefix instead of asking for sudo.
if [ ! -w "$(npm prefix -g)/lib/node_modules" ] && [ ! -w "$(npm prefix -g)" ]; then
  echo "npm's global prefix ($(npm prefix -g)) is not writable by this user." >&2
  echo "Set a user-level prefix once, then re-run this script:" >&2
  echo "    npm config set prefix ~/.local" >&2
  echo "  (ensure ~/.local/bin is on your \$PATH)" >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-}")" 2>/dev/null && pwd || true)"
if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/package.json" ] && grep -q '"ai-agent-remote-approver"' "$SRC_DIR/package.json"; then
  echo "==> Installing remote-approver globally from this checkout"
  cd "$SRC_DIR"
  # `npm install -g .` on a local DIRECTORY symlinks back to it (a dev setup).
  # Packing to a tarball first forces a real copy into the global prefix.
  TARBALL=$(npm pack --silent | tail -1)
  trap 'rm -f "$TARBALL"' EXIT
  npm install -g "./$TARBALL"
else
  echo "==> Installing the latest remote-approver release"
  npm install -g "$RELEASE_URL"
fi

if ! command -v remote-approver >/dev/null 2>&1; then
  echo "Error: 'remote-approver' is not on \$PATH after npm install -g." >&2
  echo "Ensure your npm global bin dir is on \$PATH, then re-run." >&2
  exit 1
fi

TOPIC=$(remote-approver status 2>/dev/null | sed -n 's/^Topic: *//p')

echo ""
if [ -z "$TOPIC" ]; then
  echo "==> No config yet — initializing (generates a topic + QR)"
  remote-approver init
fi
echo "==> Registering hooks (keeps your topic, adds any new config fields)"
remote-approver enable

echo ""
echo "Done ($(remote-approver --version)). Verify the round trip with:  remote-approver test --wait"
echo ""
echo "NOTE: restart running Claude Code sessions so they pick up the new hooks."
