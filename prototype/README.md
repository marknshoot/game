# RELAY — playable prototype

`GANTRY-03 "Two-Key Catwalk"` — one 65-second level, three private screens, and only one
voice on the team. Built to answer one question as fast as possible:
**does a *timed* information relay feel fun, or just stressful?**

Read `../docs/design-pitch.md` §8 for the design behind this level.

## Run it

```bash
cd prototype
python3 -m http.server 8080
# open http://localhost:8080/
```

No build step, no dependencies, ~1000 lines of plain ES modules.

**Three players:** open the Runner / Operator / Bridge links in three *visible* windows
(three screens, or side by side). They find each other automatically over `BroadcastChannel`
on the same origin — the Runner's window owns the simulation, the others sync to it.
**Keep all three windows visible:** browsers throttle hidden windows, which slows the sim.

**One player:** open the 1-person demo. It shows all three panels on one screen so you can
see exactly how little each role knows. Nothing is hidden behind fog of war — the panels
genuinely cannot talk to each other except through the game's own channels.

## The 60-second demo script

| # | Do this | Watch this |
|---|---|---|
| 1 | Open the 1-person demo | three panels, three different pictures of the same world |
| 2 | Press `P` (autopilot) in the Runner panel | he runs and jumps on his own, so you can drive the other two roles |
| 3 | When the Bridge panel flashes `CALL NOW` → press `T`, then `B` in the Operator panel | the span slides out; the motor only holds it 3 s |
| 4 | Near `PHANTOM FLOOR (D4)` → press `3` (JUMP NOW) at ~4.5 m | the floor is invisible to the Runner. Late call = 9 m fall |
| 5 | At the exit: `E` in the Operator panel, then **hold** `K` in the Bridge panel | one screen alone cannot finish the level |

## Controls

| Screen | Keys | Mouse |
|---|---|---|
| Runner | `A`/`D`, `SPACE`, `P` autopilot | — |
| Operator | `B` throw bridge · `E` exit lever · `N` knock · `7`/`8`/`9` pick stamp | click the board to stamp a coordinate |
| Bridge | `1` GO · `2` WAIT · `3` JUMP NOW · `4` STOP · `5` LEFT · `6` RIGHT · `T` THROW · `O` ON ONE · `C` cycle chalk · `V` quick chalk · hold `K` for the second key | click the Runner's cam to draw a chalk arrow |

## What is real in here

- **Asymmetric information, enforced.** The Runner's renderer physically cannot draw door
  states, timers, colours or the map; the Operator's board has no runner marker; the Bridge
  gets no audio at all (there is no audio in the prototype — the point is that they *miss* it).
- **One voice, and it is a wheel with a 1.2 s cooldown.** This is the stand-in for "the Bridge
  is the only one who can speak". It makes the bandwidth limit real instead of roleplay.
- **Call lead as a number.** The Bridge sees `5.7 m / 0.86 s` to the next beat, and `CALL NOW`
  fires at `callLead` metres — the exact distance where speaking now lands in time after
  latency + the other player's reaction. The level is tuned around those numbers.
- **Commitment.** 6.6 m/s, no air control of consequence, a 0.12 s jump buffer and 0.1 s
  coyote time. Once he is 2.5 m from the edge he is going, and that's the whole game.
- **The two-man rule, the chalk budget, the motor overheat, the knock budget** — all real
  state in `sim.js`, all verified by tests.
- **Failure review.** On death the Bridge's cam shows a 6-second ghost trail of where the
  Runner actually was, so the argument is about timing, not blame.

## What is faked / not built

- Voice chat (the prototype uses the phrase wheel; a real build wants free speech over the
  Bridge channel with the same cooldown idea replaced by "you can only say one thing at a time").
- The Operator's stamps are just markers with grid labels, not a gesture language.
- One level, no art, no audio, no roles rotation, no progression, no matchmaking, no lobby.
- No enemies/pursuer, no secrets, no scoring beyond time and death count.

## The measured numbers (this is the design)

From `test/tune.mjs`, a headless sweep of the sim — not hand-waving:

| Beat | Action window | Call window (with human reaction) | Set `callLead` to |
|---|---|---|---|
| Slide bridge (A3) | Operator throws at x ∈ [2, 15] m → **2.12 s wide** | Bridge speaks at d ∈ [4.5, 14] m → **1.44 s wide** | 9.0 m |
| Phantom floor (D4) | Runner jumps at x ∈ [41, 44.5] m → **1.21 s wide** | Bridge speaks at d ∈ [1.5, 5.0] m → **0.53 s wide** | 4.5 m |
| Two-key exit (F4) | Operator arms + Bridge holds 1.5 s | — | 5.0 m |

The rule the numbers enforce: an action window has to be wider than
`latency + the other player's reaction + travel`, or the beat reads as unfair instead of funny.
The `CALL NOW` flash on the Bridge's panel exists purely to teach that lead time.

## Tests (they run headless against real Chromium)

```bash
./test/run.sh
```

- `test/browser.mjs` — drives a real Chromium over CDP and plays the whole level with the
  keyboard: Bridge words reach both other screens, Operator stamps reach *only* the Bridge,
  the Runner crosses the gap on a thrown span, the phantom floor kills when the call is late,
  the exit needs both keys. 15 checks.
- `test/multitab.mjs` — opens three real browser tabs, verifies host election, then that the
  Operator's lever, the Bridge's words and the Bridge's chalk all cross windows correctly, and
  that the game survives the Runner's window being closed. 14 checks.
- `test/tune.mjs` — headless physics harness: what dies, what clears, where the jump windows are.

Last run: **15/15** and **14/14** passing.

## Files

```
index.html          the lobby (read this first)
play.html           the app shell        player.html?mode=solo | ?mode=net&role=runner|operator|bridge
js/level.js         the level: geometry, beats, call leads
js/sim.js           deterministic sim: physics, span motor, two-key, events   (no DOM)
js/render.js        three private renderers: world view, vignette, schematic
js/net.js           BroadcastChannel transport + role-priority host election
js/app.js           panels, controls, coach lines, main loop
style.css           dark console theme
```
