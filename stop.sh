#!/usr/bin/env sh
# Stop QR Bridge (macOS / Linux)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found, so the stop script cannot run." >&2
  exit 1
fi
exec node control.js stop "$@"
