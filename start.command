#!/usr/bin/env sh
# Double-click on macOS to start QR Bridge
cd "$(dirname "$0")" || exit 1
./start.sh "$@"
printf '\nPress Enter to close this window…'
read -r _
