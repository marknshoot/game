# RELAY (working title)

A 3-player asymmetric co-op **parkour** game. Three players, two screens, one voice, and
information that expires before it lands.

- **Runner — blind.** Sees shape and nothing else: no labels, no door states, no timers, no map.
  Runs at 6.6 m/s and physically cannot stop once committed.
- **Operator — mute.** Has the board (door states, timings, hazards) and every lever, and
  **cannot see the Runner at all**. Their language is stamps, knocks and the world itself.
- **Bridge — deaf.** Sees both feeds, is the **only one who can speak**, and hears nothing:
  no footsteps, no door hiss, no voice from anyone. Holds the chalk and the second key.

The whole design rests on one measured number, not a vibe: from the word "go" to a thing
happening takes ~1 second of human chain (0.25 s reaction + 0.7 s mechanism). In a platformer
that is ~2 seconds of runway. **Comms is read-ahead, not reaction.**

## What's in here

| Path | What |
|---|---|
| [`docs/design-pitch.md`](docs/design-pitch.md) | Full design: role triangle, comms topology, obstacle grammar, risks, and a worked level with **measured** beat windows |
| [`game/`](game/README.md) | **3D LAN build** — three.js, server-authoritative, played by three laptops on one network. `node game/server.js` |
| [`prototype/`](prototype/README.md) | **2D prototype** — the same idea in one browser window, three panels, zero setup |
| [`test/`](test/run.sh) | `./test/run.sh` runs everything: 15 + 14 checks against browser windows, 24 checks over real WebSockets, and two headless tuning harnesses that print the level's beat windows |
| `shots/` | Screenshots of the three private screens, 2D and 3D |

## Play it

**3D, three laptops on the same network (the real thing):**

```bash
cd game && node server.js       # prints http://<your-lan-ip>:8791/
```

Open that address on all three laptops (or let all three play on one machine, one tab each),
same room code, different role on each. Zero dependencies, no internet needed — three.js is vendored.

**2D, right now, one window:**

```bash
cd prototype && python3 -m http.server 8080
# open http://localhost:8080/ and click the 1-person demo
```

Verify everything headless:

```bash
./test/run.sh          # everything: 2D windows + 3D WebSockets + tuning harnesses
./test/run.sh 3d       # just the 3D LAN game
```

## Sound, sonar & feel (3D build)

The asymmetry is enforced in the client, not just the fiction:

- **Procedural audio, role-gated.** [`game/public/js/audio.js`](game/public/js/audio.js)
  synthesizes every sound with WebAudio — no files, no dependencies: filtered-noise footsteps and
  landings, wooden knocks, a positional span motor (rising whine, steady hum, falling whine) and
  lift hum, door clunks, and death/win stingers. The Bridge's `createAudio` is a hard-muted no-op
  that never constructs an `AudioContext`; the Runner and Operator hear the gantry, and
  phrase-wheel words and the Runner's shout are spoken with `speechSynthesis`.
- **Sonar (`Q`).** The blind Runner emits an expanding ring (0 → 26 m over 1.2 s, 3.5 s cooldown)
  that lights up the architecture — and the phantom floor identically, because it shares the same
  material. It reads shape, never state.
- **Camera dynamics.** Head-bobbing while running, a spring-damped landing dip scaled by impact
  speed, speed FOV (75° at rest → 82° at 6.6 m/s), and death/win vignettes that render on the
  Runner's screen and on the Bridge's runner-cam feed alike.

## Status

Two playable builds of the same design: a 2D hot-seat prototype and a 3D LAN game that runs
across three laptops with a server-authoritative simulation. One level, forced comms, measured
tuning, 53 automated checks.

Honest gaps: no networked voice chat (a phrase wheel and local TTS stand in for speech), one
level, no enemies, no role rotation, no art beyond flat-shaded industrial. The 3D build's
prediction is a light lerp, not rollback netcode.

Next up, in order of value: **play it with two friends and count the laughs**, then three more
levels built from the beat grammar, then role rotation.
