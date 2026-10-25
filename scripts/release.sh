#!/usr/bin/env bash
# Cut a release: bump version, test, tag, push. GitHub Actions builds and publishes the asset.
# Usage: scripts/release.sh <patch|minor|major|X.Y.Z>
set -euo pipefail
cd "$(dirname "$0")/.."

[ -z "$(git status --porcelain)" ] || { echo "Working tree not clean." >&2; exit 1; }
[ "$(git branch --show-current)" = "main" ] || { echo "Release from main." >&2; exit 1; }

npm test
npm version "${1:?usage: release.sh <patch|minor|major|X.Y.Z>}" -m "chore(release): v%s"
git push origin main --follow-tags
echo "Pushed $(git describe --tags). Watch: gh run watch"
