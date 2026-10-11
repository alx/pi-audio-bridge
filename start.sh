#!/usr/bin/env bash
# Start the pi-audio-bridge server for one UI experiment.
#
#   ./start.sh            # main app (web/main)
#   ./start.sh chat       # friend-chat UI (web/chat)
#   ./start.sh talk --tls # mobile one-button UI over HTTPS/h2
#
# Extra args are passed through to server.mjs (--tls, PORT=..., etc.).
set -euo pipefail
cd "$(dirname "$0")"

UI="${1:-main}"
if [[ $# -gt 0 ]]; then shift; fi

if [[ ! -f "web/$UI/index.html" ]]; then
  echo "start.sh: unknown UI '$UI' — no web/$UI/index.html" >&2
  echo "available: $(ls web | tr '\n' ' ')" >&2
  exit 1
fi

exec node server.mjs --ui "$UI" "$@"
