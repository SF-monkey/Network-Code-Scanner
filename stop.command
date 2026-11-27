#!/usr/bin/env sh
# Double-click on macOS to stop QR Bridge
cd "$(dirname "$0")" || exit 1
./stop.sh "$@"
printf '\nPress Enter to close this window…'
read -r _
