#!/usr/bin/env bash
# Idempotent installer for remote-approver.
#   1. npm install -g .  → COPIES the package into npm's global prefix and puts
#      the `remote-approver` command on $PATH. A real install: independent of
#      this source checkout (you can move/delete the repo afterwards).
#   2. configures + registers the Claude Code hooks:
#        - existing config (topic already set) → `enable`        (keeps your topic)
#        - no config yet                       → `init` + `enable` (generates a topic + QR, then registers)
# Re-running is safe: it never regenerates an existing topic.
set -euo pipefail

cd "$(dirname "$0")"

# Global install needs a writable prefix. If it's a system dir (e.g. /usr),
# point npm at a user-level prefix instead of asking for sudo.
if [ ! -w "$(npm prefix -g)/lib/node_modules" ] && [ ! -w "$(npm prefix -g)" ]; then
  echo "npm's global prefix ($(npm prefix -g)) is not writable by this user." >&2
  echo "Set a user-level prefix once, then re-run this script:" >&2
  echo "    npm config set prefix ~/.local" >&2
  echo "  (ensure ~/.local/bin is on your \$PATH)" >&2
  exit 1
fi

echo "==> Installing remote-approver globally (copies the package — no dependency on this checkout)"
# NOTE: `npm install -g .` on a local DIRECTORY still symlinks back to it (like
# npm link) — that is a dev setup, not an install. Packing to a tarball first
# forces a real copy into the global prefix, so this checkout can be moved or
# deleted afterwards without breaking the installed command.
TARBALL=$(npm pack --silent | tail -1)
trap 'rm -f "$TARBALL"' EXIT
npm install -g "./$TARBALL"

if ! command -v remote-approver >/dev/null 2>&1; then
  echo "Error: 'remote-approver' is not on \$PATH after npm install -g." >&2
  echo "Ensure your npm global bin dir is on \$PATH, then re-run." >&2
  exit 1
fi

# Has a topic already been configured? Read the config directly (robust vs. parsing status output).
HAS_TOPIC=$(node --input-type=module -e "import {loadConfig} from './src/config.mjs'; process.stdout.write(loadConfig().topic ? 'yes' : 'no')")

echo ""
if [ "$HAS_TOPIC" = "yes" ]; then
  echo "==> Existing config found — upgrading schema (adds missing fields only), keeping your values"
  node --input-type=module -e "import { upgradeConfig } from './src/config.mjs'; const { added } = upgradeConfig(); console.log(added.length ? 'added: ' + added.join(', ') : 'already up to date');"
  echo "==> Registering hooks, keeping your topic"
  remote-approver enable
else
  echo "==> No config yet — initializing (generates a topic + QR)"
  remote-approver init
  echo "==> Registering hooks"
  remote-approver enable
fi

echo ""
echo "Done. Verify the round trip with:  remote-approver test --wait"
echo ""
echo "NOTE: the hooks are now registered in ~/.claude/settings.json. If you are"
echo "running this from inside an active Claude Code session, that session will"
echo "start invoking the hook too — restart the session to pick it up cleanly."
