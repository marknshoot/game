#!/usr/bin/env bash
# RELAY prototype — serve the folder, then open http://localhost:8080/
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8080}"
echo "RELAY prototype: http://localhost:${PORT}/"
exec python3 -m http.server "$PORT"
