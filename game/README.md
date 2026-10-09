# RELAY 3D — 3-player parkour relay over LAN

The 3D version of the design in [`../docs/design-pitch.md`](../docs/design-pitch.md), built to be
played by **three laptops on the same network**. Server-authoritative, zero dependencies,
three.js vendored locally so it needs no internet.

```bash
cd game
node server.js                # prints http://<your-lan-ip>:8791/
```

Open that address on all three laptops, use the same **room code**, pick a different role on each.
Each role can only be held by one machine; the server refuses the fourth player.

## The three private screens

| | sees | hears | can do |
|---|---|---|---|
| **RUNNER** (blind) | first-person, fog kills the world past ~15 m, no labels, no door states, no timers, no map; `Q` sonar pulse reads the architecture out to ~26 m | the Bridge | run, jump, feel things by proximity |
| **OPERATOR** (mute) | an elevation schematic of the whole gantry: span/lift/exit states, hazard marks, timings — **and no runner, not even a dot** | the Bridge and the Runner | 3 levers, stamps, KNOCK |
| **BRIDGE** (deaf) | the Runner's cam *and* the Operator's board, side by side | **nothing** | words, 6 chalk marks, the second key |

The isolation is structural, not a convention: the Runner's camera and the Operator's board render
**different layers of the same three.js scene** (`runnerCam.layers` = world+chalk,
`operatorCam.layers` = board only). There is no code path that could show one the other's
information by accident. The LAN test asserts the layer masks.

## The level (GANTRY RELAY)

One gantry, ~64 m, four beats, all of them measured by `test/tune3d.mjs`:

1. **z18 — the span.** A slide bridge the Operator throws; 0.7 s of travel, holds 2.6 s, motor
   locks after two throws inside 8 s. Operator throw window `z ∈ [4, 15]` (1.8 s wide).
   The Runner cannot see whether it is out until he is close, and cannot stop anyway.
2. **z44 — the phantom floor.** A floor plate over a hole, drawn with the *same mesh and material*
   as real floor. Only the Operator's board shows `▲`. Runner jump window `z ∈ [41, 44.5]`,
   Bridge call window `d ∈ [1.5, 5] m` — the level's `callLead` is 4.5 m, the middle of it.
3. **z51 — the lift.** A deck the Operator raises. Neither of them can tell whether the Runner is
   *on* it — only the Bridge's cam can, so this beat is a state relay, not a timing relay.
4. **z57 — the catwalk jump and the two-key exit (z63).** The Operator arms the door, the Bridge
   *holds* the second key while the Runner crosses: release early and the door closes in front of him.
5. Falling off the catwalk is not death (you land in the corridor and take the lift again).
   Falling in the two holes is. Death is a 1 s respawn at the last checkpoint.

## Controls

| Screen | Keys | Mouse |
|---|---|---|
| Runner | WASD · SPACE jump · arrows turn · `Q` sonar · `P` autopilot · ⏎ shout (reaches the Operator only) | click to look (pointer lock) |
| Operator | `B` span · `F` lift · `E` exit lever · `N` knock · `7/8/9` stamp | click the board to drop a stamp |
| Bridge | `1..6` GO/WAIT/JUMP NOW/STOP/LEFT/RIGHT · `T` THROW · `O` ON ONE · `K` hold the 2nd key · `C` cycle chalk · `V` chalk ahead | click his cam to paint chalk |

## Architecture

```
game/
  server.js              static files + hand-rolled RFC6455 WebSocket + rooms + the sim loop
  shared/level3d.js      level geometry + beats + call leads            (pure data, both sides)
  shared/sim3d.js        deterministic sim: physics, span motor, lift, two-key, events
  public/index.html      lobby: room code, role cards, the design in one page
  public/play.html       the client shell (one canvas, up to two viewports)
  public/js/world.js     three.js scene, the two camera rigs, chalk, schematic layers
  public/js/main.js      per-role HUD, input, prediction, coach lines
  public/js/net.js       WebSocket client (RTT, snapshots, events)
  public/vendor/three.module.js   three.js r160, vendored (no CDN, no internet needed)
```

- **The server owns the world.** 60 Hz fixed-step sim per room, 30 Hz snapshot broadcast, 0.7 KB per
  snapshot. The Runner's client runs the same sim locally for prediction and corrects toward the
  authoritative snapshot (0.22 blend, hard snap above 2.5 m). This is why a player's browser being
  hidden or throttled no longer freezes anyone else — the lesson from the 2D prototype.
- **Roles are exclusive per room**; a role with no player simply does nothing that level needs.
- **The Runner's voice** (typed here, spoken in a real build) reaches the Operator only: the
  Operator is mute, the Bridge is deaf. The server enforces the routing.

## Honest limits

No voice chat (LAN players usually have Discord; the phrase wheel replaces the Bridge's voice so
the rate limit is real). One level. No enemies. The prediction is a light lerp, not a rollback
netcode. The Operator's board is an elevation view, so left/right position on the catwalk is not
readable — deliberate, since they are not supposed to see the Runner anyway. Three.js is r160 (2023)
because it is vendored; upgrading is a one-file swap.

## Verify it

```bash
node ../test/tune3d.mjs     # headless: beat windows, lift, two-key rule, full autopilot run
node ../test/lan3d.mjs      # three real browser tabs over WebSocket: 20 checks
./../test/run.sh            # everything, 2D and 3D
```

`test/lan3d.mjs` checks, among other things: WebGL is actually drawing, the layer isolation holds,
the Operator's lever crosses the network, the Bridge's word reaches both other screens and is
rate-limited, the Operator's stamp reaches *only* the Bridge, the Runner's shout reaches the
Operator but never the deaf Bridge, chalk spends shared ink across machines, the two-key exit needs
both machines, and a full server-side run completes.
