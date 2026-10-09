# RELAY — a 3-player asymmetric co-op parkour game

**Working title:** RELAY (alt: HANDOFF, TWO-KEY, SIGNAL, PULSE)
**Pitch line:** *Bombanana in motion — 3 players, 2 screens, 1 voice, and information that expires.*

---

**Two playable builds:** [`prototype/`](../prototype/README.md) — 2D, three panels in one window,
no setup. [`game/`](../game/README.md) — 3D three.js build, server-authoritative, played by three
laptops on one LAN (`node game/server.js`). The measured beat windows in §8.5 come out of them.

---

## 0. Why this is not just "Bombanana but parkour"

BOMBANANA! (Lefto Studio) is 3-player asym co-op bombing defusal: the **blind** monkey can't see the bomb but can *touch* it, the **mute** monkey is the only one who can read the manual, the **deaf** monkey can see the bomb and the furious gesturing. The game deliberately doesn't impose a communication method — the mesh is emergent.

Two structural shifts make a parkour version its own game:

1. **Information half-life.** In bomb defusal, a correct callout stays correct for 20 seconds. In a parkour run it expires in 500 ms. The whole design should be built around **commitment** (you can't un-jump) and **read-ahead** (the runner needs the next ~3 seconds of path *before* the commitment point).
2. **Star topology instead of mesh.** Here only the Bridge talks to both sides. That creates an overloaded hub and two isolated leaves — new tension, but also the #1 failure mode: a human telephone wire. Everything below exists to keep the Bridge *busy with decisions*, not just repeating sentences.

---

## 1. The role triangle (each role exactly one missing modality)

| | **RUNNER** — "Echo" | **OPERATOR** — "Control" | **BRIDGE** — "Voice" |
|---|---|---|---|
| Disability | **Blind** | **Mute** | **Deaf** |
| Sees | shapes/geometry only (no colors, labels, state, timers); limited radius | full schematic: door states, timers, patrols, hazards — but **no live runner marker** | runner's bodycam feed + operator's stamp board |
| Hears | game audio + Bridge's voice (not the Operator) | Bridge's voice + Runner's voice (hears, can't answer) | **nothing** — no audio tells, no Runner's voice |
| Speaks | yes, into the Operator's ear only | **no** | yes, to both |
| Acts on | parkour moveset, "touch" probing | doors, lifts, ramps, traps, timings | chalk arrows, authorizations, pings |

Each player is missing exactly one modality and *holds* the complementary one — that symmetry is the pitch in one image.

---

## 2. Core loop

**PLAN → RUN → RESOLVE** (a heist rhythm, not a sprint the whole way)

- **PLAN (slow, chatty):** Operator studies the schematic and stamps intents; Bridge drafts a route and lays chalk; Runner can "touch-probe" the first room. The Runner is at the start line, clock not running.
- **RUN (fast, quiet):** clock starts. Bridge now has to keep a rolling 3–5 s buffer of instructions in the Runner's head. Operator fires timings. Failures are usually *someone executing a stale instruction*.
- **RESOLVE (1 s):** death ragdoll, instant retry (<1 s), optional ghost replay of the last 4 s so blame is comedy, not a standoff.

Levels: 45–90 s. Checkpoint per "beat." Difficulty scales by **speed** (the Runner's top speed goes up), not by adding punishment — the comms volume per second grows and the plan falls apart on its own.

---

## 3. Keeping the Bridge from being a telephone (the important part)

The Bridge gets **one voice and three jobs**, all of which are decisions:

1. **Voice** — the only speech on the team. Free-form, but the Runner can only act on the last thing they heard.
2. **Chalk** — draw arrows/paths onto the Runner's view. Limited ink, recharges slowly. The Runner's HUD holds at most 3 queued tokens, so the Bridge must **choose what the Runner carries** and in what order. Wrong arrow → Runner jumps into the void, on camera, instantly funny.
3. **The second key (two-man rule)** — irreversible operator actions (one-way doors, launch ramps, lockdown release) need both the Operator's lever *and* the Bridge's authorization. Now the Bridge is physically inside the control loop and the Operator has to *ask*, non-verbally, with stamps.
4. **Route authority** — places have 2–3 route options (fast/shiny/safe). The Bridge is the one holding the map + both feeds, so the Bridge picks. Strategic agency > relay work.

**Operator's language is action.** Being mute is compensated by the power to *act*: a door opening *is* the word "go"; a door flickering twice *is* "wait." Players will invent Morse with your doors — encourage it, build a "flash the door" affordance, and never sand it off.

**Runner's language is touch.** Bump a door → learn locked/unlocked/hot. Slow, risky, and the Operator's schematic can't replicate it. This gives the Runner a way to *contribute information* rather than only receive it.

Up-channel cheat sheet (why the chain holds):

```
Runner  --voice-->            Operator            (Operator hears, cannot answer)
Runner  --gestures on cam-->  Bridge              (fast, ambiguous)
Operator--stamps on board-->  Bridge              (precise, slow)
Operator--world actions----->  Runner            (timing only, no meaning)
Bridge  --voice + chalk----->  Runner & Operator  (the only rich channel)
```

The Bridge's deafness matters because game audio (footsteps, door hiss, the click of a latch, alarms) is *their* missing channel — they must derive what they can't hear from the Runner's cam and the Operator's stamps.

---

## 4. Obstacle grammar (level design + endless mode in one table)

Every beat = obstacle × who holds the info × who holds the action × tolerance window.

| Beat type | Who knows | Who acts | Toy |
|---|---|---|---|
| Gap | Runner (shape) | Runner | Bridge's chalk |
| State gate | Operator (locked/open) | Operator + Bridge key | one-way doors |
| Timing gate | Operator (phase) | Operator | lasers, crushers, moving platforms |
| Invisible hazard | Operator (map flag) | nobody | Bridge must *warn in time* |
| Vertical launch | Bridge (sees momentum) | Operator | ramp/catapult, "JUMP ON MY MARK" |
| Route fork | Bridge | all | risk/reward, secrets |
| Enemy | Runner (sees it, too late) | Operator (locks a door on it) | pursuer pressure = a clock that pushes |
| Blackout | nobody | nobody | map dies; Operator works by sound only — rare, brutal, memorable |

Authoring tool = a beat picker with difficulty/tolerance sliders. Endless mode = seeded shuffle of beats with a speed multiplier; dailies + leaderboards = cheap retention.

---

## 5. Honest risks and the fixes

| Risk | Fix |
|---|---|
| **Blame + toxicity** (the #1 killer of asym co-op) | instant retry, 4 s ghost replay, team score only, "SORRY / NICE" emote wheel, no per-player stats on the death screen |
| **Bridge overload feels like a job** | give the Bridge authority (key, route, chalk) not just words; tutorial adds one channel per level; briefings that let the Bridge "commit" a plan before the run |
| **Blind Runner is unplayable/nauseating** | blind = *meaning*-blind, not dark: shapes stay crisp and parkour flows; a sonar/bloom pulse makes a gorgeous trailer moment; optional "no-pulse" hard mode for masochists |
| **Operator gets bored when nothing's happening** | forced triage: 2–3 overlapping systems, cooldowns, console lockouts, limited throws per level, and heroic saves (slamming a door on the pursuer) |
| **Content hunger** (asym co-op eats levels) | the beat grammar above + procedural endless + custom mutators, mirroring Bombanana's proven Campaign/Endless/Custom split |
| **Tone deafness** (making disability the joke) | the constraints are fictional superpower-taxes, not the punchline; and design each role to be playable by a person with that disability (blind role audio-first, deaf role visuals-first, mute role gesture-first). That's a genuine feature and a great press line. |

## 6. Progression / metagame

- **Role rotation each act is mandatory.** Everyone plays Echo, Control and Voice, or the runner becomes "the fun role" and the Bridge becomes the chore.
- Campaign in 3 acts (one per role's spotlight), ~25–30 handcrafted levels, then a final act where the team **swaps roles for the last heist** — and the last level lets the Bridge run.
- Unlocks are *team* unlocks (chalk ink, stamp slots, lever cooldown) that add bandwidth without removing any disability. Never let upgrades delete the premise.
- Spectator mode showing all three screens + map = absurdly good stream/TikTok material.

## 7. Prototype: built, and what building it already taught us

The playable slice in `prototype/` (one level: the gap, the phantom floor, the two-key exit)
exists because the argument for this game is a *feeling*, and you cannot write that down. What
the build settled before any human played it:

1. **The slide bridge sat 15 cm proud of the floor**, so a fully extended span was still
   unwinnable without a jump — the beat was broken and *looked* fine. A headless sweep of the
   simulation caught it in seconds (`test/tune.mjs` prints the throw window as a range).
   Levels should be data you can sweep, not geometry you eyeball.
2. **The camera framed underground in wide, short windows**, which made the Runner blind in a
   way that was not the design's blindness. Any per-role view needs its own framing rules and
   a test at three aspect ratios, because "the player can't see" is this game's failure mode
   in both senses.
3. **Browsers suspend `requestAnimationFrame` in occluded windows.** The simulation must not be
   tied to a player's window being visible — a shipping build wants the authoritative sim in a
   Web Worker or server-side. This is an architectural decision the prototype forced early,
   which is exactly what prototypes are for.
4. **The call window is a measurable quantity**, so difficulty can be tuned as numbers:
   `callLead` in metres, motor travel in seconds, reaction time as an explicit design constant.
   See the measured table in §8.5.

5. **The 3D build settled the netcode question for good.** Putting the simulation on the server
   (60 Hz, 30 Hz snapshots, ~0.7 KB each) removed the whole class of "one player's window froze
   everyone" problems, and made the comms routing enforceable rather than polite: the server is
   the thing that decides the Runner's voice reaches the Operator and never the deaf Bridge.
   Per-role information isolation is now a *layer mask* in the renderer (`runnerCam` = world +
   chalk, `operatorCam` = board only) — the Runner's camera *cannot* draw the Operator's board,
   so the design invariant is a property of the code, not a guideline. Assert it in tests.

Still to do before art: three more levels from the beat grammar, role rotation, and audio as a
first-class channel (the Bridge's deafness only *means* something once there is something to
miss).

### Still the cheapest test of all

Before building anything further: play a normal platformer (a Celeste level, a Mario course)
with one friend under a rule — the runner may only look through a slit, one friend holds a
paper map face-down, and only one person is allowed to talk. If that is funny, the game works.

### The original sketch of the order (kept for reference)

1. **Paper / off-the-shelf test (a weekend).** Play any platformer (a Celeste level, a Mario course) with rules: Runner covers most of the screen except a small slit (or uses a sonar shader), one friend holds a hand-drawn map face-down and can only point at it, one friend is the only one allowed to talk. If it's funny, the loop works.
2. **3-view grey-box (2 weeks).** Three browser windows or three clients: Runner cam, Operator console, Bridge spectator. One level, ~5 beats, no art. LAN/local first.
3. **Metrics that matter:** laughter per minute (the real KPI), deaths caused by stale instructions, emergent operator codes (door-flashing language), Bridge talk-time vs. silence, time-to-first-mistake.
4. Then: 10 grey-box beats, endscreen stats ("doors closed on teammate's face: 3"), and a trailer-shaped level for eyes.

**Engine:** Godot 4 (built-in high-level multiplayer, fast iteration, easy exports) — or a TS/WebGL stack if playtests-by-link matter more than visual fidelity. Both are viable; pick based on how much you need the Runner's game feel to be good.

---

## 8. Worked use case — GANTRY-03 "Two-Key Catwalk"

3 players, one level, ~65 seconds of run. This is the level to build first.

### 8.1 The level

Side-view factory, left → right. Runner sprint 7.5 m/s, jump range ~4 m, safe drop 8 m.

| x | Beat | System |
|---|---|---|
| 0–4 | Start line / PLAN zone | clock starts when Runner crosses x=4 |
| 18 | **A: 8 m gap** | `B1` slide bridge: 0.7 s travel, top flush with the floor, auto-retracts 2.6 s after it lands, two throws within 8 s → 6 s motor lockout |
| 31 | **B: shaft** | `B2` lift, 3 s rise; two wall-run panels |
| 41 | **C: route fork** | high road (catwalk, 12 s, needs plank throw + a ledge jump) / low road (crawl, 22 s, one laser gate) |
| 52 | **D: rotten panel** | camo pit, invisible to Runner, ▲ HAZARD D4 on Operator's map |
| 58 | **E: pursuer** | Groundsman drone spawns at T+20 s; Operator holds 1× alarm suppression (delays it 8 s) and 1× shutter |
| 64 | **F: exit** | two-key door: Operator lever `E1` + Bridge key, 1.5 s hold |

### 8.2 One instant, three screens (T = 22.6)

**RUNNER (blind)** — silhouettes only. The gap edge is a bright line of geometry. No icons, no colors: the bridge span reads as a grey rectangle *if it's there at all*. HUD: three empty arrow slots. Audio: their own footfalls, wind, and the bridge's voice in one ear. They are 3 m from the edge and physically **cannot stop**.

**OPERATOR (mute)** — schematic grid C4–D5, `B1 = RETRACTED`, motor temp OK, and *no runner marker* — an empty corridor and a bridge icon. Stamp tray: ▲ ● ▶ ◼ ⧗ ? ✓ ✖ + coordinates. Their only output is a lever, a stamp, or a knock.

**BRIDGE (deaf)** — split screen: left = runner's cam (a grey silhouette sprinting toward a hole), right = the operator's board, where a stamp ticks in 1 s ago: `◼B1 ⧗`. They cannot hear the runner's panting, the wind, or the motor. They have one voice, 2/6 ink left, and the key.

### 8.3 Play-by-play

**PLAN (T = 0:00–0:20)**
- Runner crouches at the bridge housing and *touch-probes* it: "There's a slide-out span here, it's dead." Only the Operator hears that.
- Operator stamps `◼B1` + `⧗` — *lever B1, timing*. The Bridge sees the flash on the board.
- Bridge fuses it: cam shows the gap and the housing, board says B1 is a timed throw. "Copy. One throw at the gap, one held in reserve — the motor locks after two in eight seconds. Runner, hold at the line. On my ONE, not before."
- Bridge chalks two arrows: launch point and lip of the far side (ink 2/6). The chalk persists through the run, so the plan is physically visible in the world — and in every replay.
- Operator stamps `✓` — confirmation must be visual, a head nod means nothing to a deaf Bridge. The team's first word is born: **"ONE"**.

**THE GAP (T = 0:20–0:24)**
- Clock starts. Runner sprints. The Bridge watches *feet* and counts strides off their own chalk.
- Physics the player never sees: bridge voice latency 0.2 s + Operator reaction 0.25 s + span travel 0.7 s ≈ **1.15 s from the word "ONE" to the span being seated**. The Runner's own jump input window is 0.4 s and sits 4 m later. So the Bridge must speak about **2.4 s before the edge**.
- "Three… two… **ONE**." Operator throws at 22.6. The span bangs out (the Runner *hears* it — blind, not deaf). Runner jumps blind at 22.9, lands on metal.
- Operator's schematic flips to `A: BRIDGE EXTENDED` and they stamp `✓`. Bridge sees the check, exhales, "Nice. Mobilise, you've got four seconds of span behind you."

**SHAFT + FORK (T = 0:31–0:45)**
- Operator sees the lift phase and throws `B2` on instinct — pre-authorized moves need no key.
- Bridge pre-loads the *next* beat before the current one finishes: "At the top don't stop, the right rail is frayed, go left." Chalk arrow (3/6). The Runner never sees the fray — only the arrow.
- Fork: the Bridge has the only route picture. "Keep the alarm charge, we're going high." Operator hears, stamps `✓`, and the Bridge's leftover ink is now the real clock.

**CAMO PIT (T = 0:52) — the pure-comms beat**
- To the Runner, the rotten panel is *identical* to concrete; blindness means no hazard flags. To the Operator it's `▲ D4` — but no runner marker, so they don't know if the Runner is at D3 or D4. They stamp `▲D4` and **knock**: 1 of 3 rumbles into the Bridge's controller.
- Bridge feels it, reads the board, and must convert a *map coordinate* into a *world action* using the cam: "STOP. Do not move." Too late to stop at 7.5 m/s — so they snap a chalk arrow at the upper ledge instead: "JUMP, left, NOW." Runner commits. Clears it. Total Bridge reaction budget from knock to call: 0.9 s.

**EXIT (T = 1:04)**
- Operator throws `E1`, console reads `ARMED — AWAITING KEY`. Bridge holds the key for 1.5 s: "Hold… hold… hold…" — the Runner hears the lock cycling but can't see the door, and the drone timer is bleeding.
- Door opens at 1:05.12. Clear. Stats screen: `65.12 s · 0 deaths · 4/6 ink · 1/3 knocks · "doors closed on face: 0"`.

### 8.4 The interesting failure (T = 22.6, take 2)

The Operator hears the Runner shout "**go**" at 21.4 — the Runner meant *I'm going*; the Operator read it as *throw now*. Span out at 21.6 and seated by 22.3, but the Runner's stride was still 1.5 m short of the launch mark, so they jumped from a standing compression, clipped the lip and fell 9 m.

Ghost replay, 4 seconds: the feet, the span sliding out 0.4 s before the stride, the moment the Bridge said "wait—". Everyone laughs. Nobody is blamed by the UI; the shared score screen just shows `stale instruction: 1`. The team invents the real rule out of the wreckage: **"ONE" is a throw word, "go" is not** — and by run five, the Operator's lever *itself* is the word, because the mute player's real language turned out to be the world.

### 8.5 Beat spec sheet (measured, not guessed)

These are the numbers the prototype actually runs on, produced by `test/tune.mjs` — a headless
sweep of the sim. Run it after every level change; it prints the windows instead of opinions.

```
1) SLIDE BRIDGE (A3)
   span travel ......... 0.7 s      span hold ....... 2.6 s (then auto-retract)
   motor ............... 2 throws inside 8 s -> 6 s lockout
   Operator throw window  x ∈ [2, 15] m        (2.12 s wide; failure is LATENESS)
   Bridge call window     d ∈ [4.5, 14] m from the edge  (1.44 s wide)
     -> callLead is set to 9.0 m: dead centre, with ~4.5 m of slop either way
   failure modes ........ call late -> he runs into the hole
                          throw early -> span is gone when he arrives

2) PHANTOM FLOOR (D4)  — invisible to the Runner, ▲ on the Operator's board
   Runner jump window ... x ∈ [41, 44.5] m     (1.21 s wide, single press)
   Bridge call window ... d ∈ [1.5, 5.0] m     (0.53 s wide)
     -> callLead is set to 4.5 m
   failure modes ........ call late -> 9 m fall; call very early -> he jumps into the far wall

3) TWO-KEY EXIT (F4)
   Operator arms it, Bridge holds the key 1.5 s. Neither screen alone can finish.

4) WHOLE LEVEL with the demo autopilot: 9.4 s, 0 deaths, no fail states reachable by luck.
```

Design rule that falls out of the numbers: **the Operator's action window must be wider than
Bridge-latency + Operator-reaction + travel time, or the beat feels unfair instead of funny.**
Tune travel speed and hold time, never the human chain. (Here: 0.25 s reaction + 0.7 s travel
= ~1 s of unavoidable lead, which is exactly what the `CALL NOW` indicator teaches.)

### 8.6 What each player actually does in those 65 s

| | Actions taken | Decisions | Frustration that is *their* fault, not the game's |
|---|---|---|---|
| Runner | ~110 inputs, 11 committed jumps, 2 probes | which route line to hold, when to trust | "I jumped because I was told." |
| Operator | 9 lever throws, 4 stamps, 1 knock | throw now vs. save the motor, spend the suppression | "Nobody told me he was there." |
| Bridge | 41 spoken lines, 3 chalk arrows, 1 key hold | route, what the Runner carries in 3 slots, when to spend attention | "I said it 0.4 s too late." |

That table is also the game's design checklist: if any column is empty for a whole level, that role is a passenger.

### 8.7 Variants worth shipping

- **Silent Run (mutator):** no voice at all. Chalk + lever timings + knocks only. The high-skill mode, and a speedrun category in waiting.
- **Delayed cam (hard mode):** the Bridge's runner-feed is 1.0 s stale — they must instruct a world that has already moved. Add after players master the base loop, never before.
- **Role swap:** the same level, roles rotated. GANTRY-03 becomes a different game three times, which is how you get 30 levels of content out of 10 maps.
- **Spectator cut:** the three screens cut together on one stream; the failure replay makes it a clip machine.
