#!/usr/bin/env bash
# Idempotent installer for remote-approver.
#   1. npm install + npm link  → puts the `remote-approver` command on $PATH
#      (so the registered hook uses the stable command, not this repo's path)
#   2. configures + registers the Claude Code hooks:
#        - existing config (topic already set) → `enable`        (keeps your topic)
#        - no config yet                       → `init` + `enable` (generates a topic + QR, then registers)
# Re-running is safe: it never regenerates an existing topic.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Installing dependencies and linking the command"
npm install

# `npm link` writes a symlink into npm's global prefix. If that prefix is a
# system dir (e.g. /usr), it needs root — point npm at a user-level prefix
# instead of asking for sudo.
if [ ! -w "$(npm prefix -g)/lib/node_modules" ] && [ ! -w "$(npm prefix -g)" ]; then
  echo "npm's global prefix ($(npm prefix -g)) is not writable by this user." >&2
  echo "Set a user-level prefix once, then re-run this script:" >&2
  echo "    npm config set prefix ~/.local" >&2
  echo "  (ensure ~/.local/bin is on your \$PATH)" >&2
  exit 1
fi

npm link   # exposes `remote-approver` on $PATH

if ! command -v remote-approver >/dev/null 2>&1; then
  echo "Error: 'remote-approver' is not on \$PATH after npm link." >&2
  echo "Ensure your npm global bin dir is on \$PATH, then re-run." >&2
  exit 1
fi

# Has a topic already been configured? Read the config directly (robust vs. parsing status output).
HAS_TOPIC=$(node --input-type=module -e "import {loadConfig} from './src/config.mjs'; process.stdout.write(loadConfig().topic ? 'yes' : 'no')")

echo ""
if [ "$HAS_TOPIC" = "yes" ]; then
  echo "==> Existing config found — registering hooks, keeping your topic"
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
