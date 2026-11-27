#!/usr/bin/env sh
# Start QR Bridge in the background (macOS / Linux)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required but was not found." >&2
  echo "Install it from https://nodejs.org/ and run this again." >&2
  exit 1
fi
exec node control.js start "$@"
