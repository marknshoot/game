# RELAY 3D — 3-player parkour relay over LAN

The 3D version of the design in [`../docs/design-pitch.md`](../docs/design-pitch.md), built to be
played by **three laptops on the same network**. Server-authoritative, zero dependencies,
three.js vendored locally so it needs no internet.

```bash
cd game
node server.js                # prints https://<your-lan-ip>:9791/  (and http on :8791)
```

Open that address on all three laptops, use the same **room code**, pick a different role on each.
Each role can only be held by one machine; the server refuses the fourth player.

## The three private screens

| | sees | hears | can do |
|---|---|---|---|
| **RUNNER** (blind) | first-person, fog kills the world past ~15 m, no labels, no door states, no timers, no map; `Q` sonar pulse reads the architecture out to ~26 m | the Bridge's voice + the gantry's mechanisms | run, jump, feel things by proximity |
| **OPERATOR** (mute) | an elevation schematic of the whole gantry: span/lift/exit states, hazard marks, timings — **and no runner, not even a dot** | the Bridge's and the Runner's voices, and the gantry | 3 levers, stamps, KNOCK |
| **BRIDGE** (deaf) | the Runner's cam *and* the Operator's board, side by side | **nothing** — `audio.js` is a hard-muted no-op | words, 6 chalk marks, the second key |

The isolation is structural, not a convention: the Runner's camera and the Operator's board render
**different layers of the same three.js scene** (`runnerCam.layers` = world+chalk,
`operatorCam.layers` = board only). There is no code path that could show one the other's
information by accident. The LAN test asserts the layer masks.

## The level (GANTRY RELAY) — one showcase level, four sections

~86 m, four sections, each starting at a **station** where the Runner may line up and steer but
not move forward. `W` commits him: from then on he runs at 6.6 m/s and **cannot stop** until the
next station (`S` braces to 3 m/s for 1.2 s per section). So every plan is made at the station and
executed live. Every death re-rolls the hazards, so nobody can memorise them.

1. **Span (z18).** A one-lane slide bridge across the gap; the lane is re-rolled each attempt and
   only drawn on the board. The Bridge lines him up, says GO, then THROW; the Operator's throw
   window is 0.89 s (Runner at z 12.7–18.6).
2. **Dark hall (z30–48).** Nine identical floor tiles, three true. **Only the Operator sees the
   lies** (a layer the Bridge's copy of the board does not render). He stamps the true tiles,
   the Bridge chalks the path on the Runner's visor, the Runner steers through it blind.
   Guessing gets through 2% of the time; the sonar lights lies and real floor identically.
3. **Press and lift (z56–64).** A crusher the Operator holds up with `H` (max 1.2 s, then it
   slams): the Bridge counts ON ONE and both go together (0.92 s window). Then the lift, raised
   only when the Bridge sees him standing on it.
4. **Collapse and two-key exit (z64–86).** Committing starts the catwalk falling away behind him
   at his own speed; one jump (0.42 s take-off window). The Operator arms the door, the Bridge
   holds the second key within 3 s, the door opens 1.5 s later and stays open 2.5 s.

After a win with three players, RUN AGAIN **rotates the roles** (Runner → Operator → Bridge →
Runner) and the room keeps a scoreboard of runs. `?assist=1` shows the Bridge distances and
call timing; without it he judges by eye.

## Controls

| Screen | Keys | Mouse |
|---|---|---|
| Runner | `W` go (no stopping after) · `A/D` steer · `S` brace · SPACE jump · arrows turn · `Q` sonar · hold `SHIFT` to talk (the Operator hears you) | click to look (pointer lock) |
| Operator | `B` span · hold `H` press up · `F` lift · `E` exit lever · `N` knock · `7/8/9` stamp | click the board to drop a stamp |
| Bridge | hold `SPACE` to talk (Runner + Operator hear you) · `K` hold the 2nd key · `C` cycle chalk · `V` chalk ahead | click his cam to paint chalk |
| Inspector | `1` Runner · `2` Operator · `3` Bridge — watch that screen; no controls, no voice, no vote | |
| Everyone | `R` or **RUN AGAIN** votes for a fresh run; two votes restart the room (one, if you are alone) | |

The demo autopilot (`P`) only exists for testing: start the server with `node server.js --debug`
and open the game with `?debug=1`. A normal server refuses it, and the raw reset event, from every client.

## Inspector seat

A full room takes one more person: the **inspector** (lobby → *INSPECT this room*, or the button
offered when a role is taken). He sees any of the three private screens exactly as that player
does — the Operator's lies included — and switches with `1 / 2 / 3` without reloading. The server
gives him snapshots and nothing else: every event, input, vote and voice link from him is refused,
and role rotation leaves him where he is. One per room.

## Voice

Talking is voice only — there is no text chat and no phrase buttons.

Built in, peer-to-peer over the LAN, and routed by role — the disabilities are enforced, not asked for:

| speaker | heard by | key |
|---|---|---|
| Bridge | Runner + Operator | hold `SPACE` (or `M` for an open mic) |
| Runner | Operator only | hold `SHIFT` (or `M`) |
| Operator | nobody — no mic is ever opened | |

Each allowed direction is its own one-way WebRTC connection (audio only). The server relays
signaling **only** along those three links ([`shared/voice-rules.js`](shared/voice-rules.js)) and
refuses any offer/answer that would send the other way, add video or open a data channel, so a
modified client can neither talk to the deaf Bridge nor give the mute Operator a voice. Talking
lights go only to the roles who can hear. No STUN/TURN: nothing leaves the network. Measured on
a LAN: ~35 ms jitter buffer plus a 20 ms Opus frame. Without a mic a player cannot talk.

**Browsers only allow the microphone on https** (or `localhost`). The server therefore also
listens on `port + 1000` (9791) with a self-signed certificate it generates on first run for this
laptop's LAN addresses (needs `openssl`; stored in `game/.cert/`, git-ignored, never served).
Each player clicks through the certificate warning once. On plain http the HUD links the https
address. The lobby has a mic test and a device picker. Use headphones, or the game's own sound
leaks into your mic. `--no-https` turns it off.

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
  public/js/audio.js     role-gated procedural WebAudio (bridge = hard-muted no-op)
  public/js/net.js       WebSocket client (RTT, snapshots, events)
  public/js/voice.js     role-routed WebRTC voice: mic, push-to-talk, one connection per link
  shared/voice-rules.js  who hears whom + the SDP direction check     (both sides)
  public/vendor/three.module.js   three.js r160, vendored (no CDN, no internet needed)
```

- **The server owns the world.** 60 Hz fixed-step sim per room, 30 Hz snapshot broadcast, ~0.65 KB per
  snapshot, bounded at ~1.4 KB in a busy session (event logs are trimmed to what clients still show). The Runner's client runs the same sim locally for prediction and corrects toward the
  authoritative snapshot (0.22 blend, hard snap above 2.5 m). This is why a player's browser being
  hidden or throttled no longer freezes anyone else — the lesson from the 2D prototype.
- **Roles are exclusive per room**; a role with no player simply does nothing that level needs.
- **The server enforces who may do what.** Levers, knocks and stamps are accepted from the Operator only;
  chalk and the second key from the Bridge only; the Runner sends only movement; the inspector nothing.
  A modified client cannot let one player do everyone's job. Event payloads are clamped, frames above
  16 KB close the socket, a Runner whose input stops arriving (frozen tab) stops running, and a Bridge
  who disconnects lets go of the key.
- **Sound is a private channel too.** `audio.js` is procedural WebAudio (no files): filtered-noise
  footsteps and landings, wooden knocks, a positional span motor (rising whine / steady hum /
  falling whine) and lift hum, door clunks, and death/win stingers. The Runner hears the gantry and
  the Bridge; the Operator hears the gantry and both voices; the Bridge's
  `createAudio` is a hard-muted no-op that never constructs an `AudioContext`.

## Honest limits

Voice is enforced only inside the game: three friends on Discord or in one room can still all
talk. Voice is LAN-only (no TURN server for the internet). One level, not yet playtested by humans. No enemies. The prediction is a light lerp, not a rollback
netcode. The Operator's board is an elevation view, so left/right position on the catwalk is not
readable — deliberate, since they are not supposed to see the Runner anyway. Three.js is r160 (2023)
because it is vendored; upgrading is a one-file swap.

## Verify it

```bash
node ../test/tune3d.mjs     # headless: beat windows, re-rolls, Monte Carlo of the human chain, 60-seed autopilot
node ../test/phase0.mjs     # integrity over raw WebSockets (normal server): 33 checks
node ../test/voice-proto.mjs  # voice routing at the protocol level + https: 23 checks
node ../test/voice3d.mjs    # real WebRTC between three Chrome tabs with a fake mic: 19 checks
node ../test/lan3d.mjs      # three real browser tabs over WebSocket (--debug server): 39 checks
./../test/run.sh            # everything, 2D and 3D
```

`test/lan3d.mjs` checks, among other things: WebGL is actually drawing, the layer isolation holds,
the Operator's lever crosses the network, there is no text chat anywhere, a real mouse click on
the Operator's board stamps that spot and reaches the Bridge, a click on the Bridge's board chalks,
the inspector can switch screens but act on nothing, the Bridge is hard-muted while the knock renders as a runner-cam
shake, chalk spends shared ink across machines, the two-key exit needs both machines, a full
server-side run completes, and RUN AGAIN rotates every tab into its next role.
