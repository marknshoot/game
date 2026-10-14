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
# first browser found wins; override with CHROME=/path/to/chrome
if [ -z "${CHROME:-}" ]; then
  for c in chromium chromium-browser google-chrome google-chrome-stable; do
    if command -v "$c" >/dev/null 2>&1; then CHROME="$(command -v "$c")"; break; fi
  done
fi
CHROME="${CHROME:-/usr/bin/chromium}"
CHROME_FLAGS=(--headless=new --no-sandbox --enable-unsafe-swiftshader --use-angle=swiftshader --window-size=1500,900)

PROTO_PORT=8099
CDP2D=9222
# off the game's default port (8791), so a server you are playing on is never tested by mistake
GAME_PORT="${GAME_PORT:-8891}"
GAME_PORT_STRICT="${GAME_PORT_STRICT:-8892}"
CDP3D=9223
CDPV=9224
# Chrome's fake microphone (a beep), no permission prompt, voice may autoplay, and the
# self-signed LAN certificate is accepted: what a player does by hand, once
VOICE_FLAGS=(--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --autoplay-policy=no-user-gesture-required --ignore-certificate-errors)
P2D="$(mktemp -d /tmp/relay-p2d-XXXX)"
P3D="$(mktemp -d /tmp/relay-p3d-XXXX)"
PV="$(mktemp -d /tmp/relay-pv-XXXX)"
L2D="$(mktemp /tmp/relay-s2d-XXXX.log)"
L3D="$(mktemp /tmp/relay-s3d-XXXX.log)"
L3S="$(mktemp /tmp/relay-s3s-XXXX.log)"

PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  rm -rf "$P2D" "$P3D" "$PV" "$L2D" "$L3D" "$L3S"
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
  # the browser suite drives the demo autopilot, so it needs a --debug server;
  # the integrity suite runs against a normal one, exactly as players get it
  for p in "$GAME_PORT" "$GAME_PORT_STRICT" "$((GAME_PORT_STRICT + 1000))"; do
    if curl -s "http://127.0.0.1:$p/" >/dev/null 2>&1 || curl -sk "https://127.0.0.1:$p/" >/dev/null 2>&1; then
      echo "port $p is already in use: stop that server or set GAME_PORT / GAME_PORT_STRICT"; exit 1
    fi
  done
  node game/server.js "$GAME_PORT" --debug >"$L3D" 2>&1 & PIDS+=($!)
  node game/server.js "$GAME_PORT_STRICT" >"$L3S" 2>&1 & PIDS+=($!)
  "$CHROME" "${CHROME_FLAGS[@]}" --remote-debugging-port="$CDP3D" --user-data-dir="$P3D" about:blank >/dev/null 2>&1 & PIDS+=($!)
  "$CHROME" "${CHROME_FLAGS[@]}" "${VOICE_FLAGS[@]}" --remote-debugging-port="$CDPV" --user-data-dir="$PV" about:blank >/dev/null 2>&1 & PIDS+=($!)
  wait_for "http://127.0.0.1:$GAME_PORT/index.html" || echo "  (warning: game server slow)"
  wait_for "http://127.0.0.1:$GAME_PORT_STRICT/index.html" || echo "  (warning: strict game server slow)"
  wait_for "http://127.0.0.1:$CDP3D/json/version" || echo "  (warning: chromium slow)"
  wait_for "http://127.0.0.1:$CDPV/json/version" || echo "  (warning: voice chromium slow)"
  echo "--- headless level/beat harness ---"
  node test/tune3d.mjs || fail=1
  echo "--- Phase 0 integrity: roles, restart vote, input, snapshots, clock, frames ---"
  WS="ws://127.0.0.1:$GAME_PORT_STRICT/ws" node test/phase0.mjs || fail=1
  echo "--- voice routing: signaling rules, SDP directions, https (no browser) ---"
  NODE_EXTRA_CA_CERTS=game/.cert/cert.pem WS="ws://127.0.0.1:$GAME_PORT_STRICT/ws" HTTPS="https://127.0.0.1:$((GAME_PORT_STRICT + 1000))" node test/voice-proto.mjs || fail=1
  echo "--- voice in real browsers: WebRTC + fake mic, Bridge over the https LAN address ---"
  CDP_PORT="$CDPV" BASE="http://127.0.0.1:$GAME_PORT_STRICT" HTTPS_PORT="$((GAME_PORT_STRICT + 1000))" node test/voice3d.mjs || fail=1
  echo "--- three machines' worth of WebSocket clients ---"
  CDP_PORT="$CDP3D" BASE="http://127.0.0.1:$GAME_PORT" node test/lan3d.mjs || fail=1
  echo
fi

[ "$fail" -eq 0 ] && echo "all suites passed" || echo "SOME SUITES FAILED"
exit $fail
