#!/usr/bin/env bash
# RELAY — full test pass: the 2D prototype (browser windows) and the 3D LAN game
# (server + three browser tabs over WebSocket), plus both headless tuning harnesses.
#
#   ./test/run.sh           everything
#   ./test/run.sh 2d        only the 2D prototype
#   ./test/run.sh 3d        only the 3D game
set -uo pipefail
cd "$(dirname "$0")/.."

WHAT="${1:-all}"
CHROME="${CHROME:-/usr/bin/chromium}"
CHROME_FLAGS=(--headless=new --no-sandbox --enable-unsafe-swiftshader --use-angle=swiftshader --window-size=1500,900)

PROTO_PORT=8099
CDP2D=9222
GAME_PORT=8791
CDP3D=9223
P2D="$(mktemp -d /tmp/relay-p2d-XXXX)"
P3D="$(mktemp -d /tmp/relay-p3d-XXXX)"
L2D="$(mktemp /tmp/relay-s2d-XXXX.log)"
L3D="$(mktemp /tmp/relay-s3d-XXXX.log)"

PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  rm -rf "$P2D" "$P3D"
}
trap cleanup EXIT
wait_for() { for _ in $(seq 1 60); do curl -sf "$1" >/dev/null && return 0; sleep 0.25; done; return 1; }

fail=0

# --------------------------------------------------------------------- 2D
if [[ "$WHAT" == "all" || "$WHAT" == "2d" ]]; then
  echo "════════════ 2D PROTOTYPE (three windows on one machine) ════════════"
  ( cd prototype && python3 -m http.server "$PROTO_PORT" >"$L2D" 2>&1 ) & PIDS+=($!)
  "$CHROME" "${CHROME_FLAGS[@]}" --remote-debugging-port="$CDP2D" --user-data-dir="$P2D" about:blank >/dev/null 2>&1 & PIDS+=($!)
  wait_for "http://127.0.0.1:$PROTO_PORT/index.html" || echo "  (warning: prototype server slow)"
  wait_for "http://127.0.0.1:$CDP2D/json/version" || echo "  (warning: chromium slow)"
  echo "--- solo play-through ---"
  CDP_PORT="$CDP2D" BASE="http://127.0.0.1:$PROTO_PORT" node test/browser.mjs || fail=1
  echo "--- three windows: host election + relay chain ---"
  CDP_PORT="$CDP2D" BASE="http://127.0.0.1:$PROTO_PORT" node test/multitab.mjs || fail=1
  echo "--- tuning harness (physics, no browser) ---"
  node test/tune.mjs > /tmp/relay-tune2d.log 2>&1 || fail=1
  tail -22 /tmp/relay-tune2d.log
  echo
fi

# --------------------------------------------------------------------- 3D
if [[ "$WHAT" == "all" || "$WHAT" == "3d" ]]; then
  echo "════════════ 3D LAN GAME (server-authoritative, three browser tabs) ════════════"
  node game/server.js "$GAME_PORT" >"$L3D" 2>&1 & PIDS+=($!)
  "$CHROME" "${CHROME_FLAGS[@]}" --remote-debugging-port="$CDP3D" --user-data-dir="$P3D" about:blank >/dev/null 2>&1 & PIDS+=($!)
  wait_for "http://127.0.0.1:$GAME_PORT/index.html" || echo "  (warning: game server slow)"
  wait_for "http://127.0.0.1:$CDP3D/json/version" || echo "  (warning: chromium slow)"
  echo "--- headless level/beat harness ---"
  node test/tune3d.mjs || fail=1
  echo "--- three machines' worth of WebSocket clients ---"
  CDP_PORT="$CDP3D" BASE="http://127.0.0.1:$GAME_PORT" node test/lan3d.mjs || fail=1
  echo
fi

[ "$fail" -eq 0 ] && echo "all suites passed" || echo "SOME SUITES FAILED"
exit $fail
