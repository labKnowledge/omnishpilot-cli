#!/usr/bin/env bash
# Multi-platform installer for OmnishPilot CLI.
# Usage (from this folder):  bash install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "[omnishpilot] installing deps in $ROOT"
npm install

if [[ -f ../server/index.js ]]; then
  echo "[omnishpilot] syncing runtime from parent AgentBoard"
  npm run sync
elif [[ ! -f runtime/server/index.js ]]; then
  echo "[omnishpilot] ERROR: runtime/server missing and no parent checkout to sync from" >&2
  exit 1
fi

BIN_DIR="${OMNISHPILOT_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
ln -sfn "$ROOT/bin/omnishpilot.js" "$BIN_DIR/omnishpilot"
ln -sfn "$ROOT/bin/omnishpilot.js" "$BIN_DIR/omnip"
ln -sfn "$ROOT/bin/omnishpilot.js" "$BIN_DIR/agentboard"
chmod +x "$ROOT/bin/omnishpilot.js"

echo "[omnishpilot] linked → $BIN_DIR/omnishpilot (alias: omnip)"
if ! command -v omnishpilot >/dev/null 2>&1 && ! command -v omnip >/dev/null 2>&1; then
  echo "[omnishpilot] note: add $BIN_DIR to your PATH"
fi

"$BIN_DIR/omnip" version
OMNISHPILOT_INSTALL_SKILL=1 node "$ROOT/scripts/install-skill.js" install || true
"$BIN_DIR/omnip" doctor || true
echo
echo "Next: omnip start -d"
echo "      omnip service install   # optional login service"
echo "      omnip guide             # agents + humans"
echo "      omnip watch"
