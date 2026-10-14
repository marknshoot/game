// RELAY 3D — headless design harness for the showcase level. No browser, no renderer.
//
//   1. a full run completes for many rolled layouts, with each role doing its job
//   2. every beat FAILS when the role that owns it does nothing, or does it wrong
//   3. the measured windows (seconds) of every timed beat
//   4. a human-chain Monte Carlo per beat (first-time vs practised team) — a MODEL with
//      stated assumptions, used as a tuning gate, not as a claim about real players
//   5. blind/random play does not get through
//   6. determinism + integrity (re-rolls, collisions, resets, payloads, snapshot size)
import { LEVEL, hallTiles, laneX, LANE_W } from '../game/shared/level3d.js';
import * as SIM from '../game/shared/sim3d.js';

const DT = 1 / 60;
let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const pct = (x) => `${(100 * x).toFixed(0)}%`;

// seeded gaussian for the Monte Carlo (reproducible runs)
let mc = 12345;
const urand = () => {
  mc = (mc * 1664525 + 1013904223) >>> 0;
  return mc / 4294967296;
};
const gauss = (m, sd) => m + sd * Math.sqrt(-2 * Math.log(urand() || 1e-9)) * Math.cos(2 * Math.PI * urand());

// put the Runner at a station of a fresh state
function at(section, seed = 1) {
  const s = SIM.createState(seed);
  const st = LEVEL.stations[section];
  s.section = section;
  s.checkpoint = { z: st.z, y: st.y };
  Object.assign(s.runner, { x: 0, y: st.y, z: st.z });
  if (section >= 3) s.lift = { y: LEVEL.lift.up, target: LEVEL.lift.up, moving: false };
  return s;
}
// step until `until(s)` or death/win/section change; `ctl(s)` returns input + may apply events
function run(s, ctl, { maxT = 12, stopSection = true } = {}) {
  const sec = s.section;
  const t0 = s.t;
  while (s.t - t0 < maxT && !s.dead && !s.won) {
    SIM.step(s, DT, ctl(s));
    if (stopSection && s.section !== sec) break;
  }
  return s;
}
const passed = (s, sec) => !s.dead && (s.won || s.section > sec);

// ------------------------------------------------- 1. full runs, many layouts
console.log('=== RELAY 3D — showcase level harness ===\n');
function perfectCrew(s) {
  const r = s.runner;
  if (s.section === 0 && r.committed && s.span.phase === 'out' && r.z > 14 && !s._t) {
    SIM.applyEvent(s, { type: 'span.throw' });
    s._t = 1;
  }
  if (s.section === 2 && r.committed && !s._p) {
    SIM.applyEvent(s, { type: 'press', down: true });
    s._p = 1;
  }
  if (s.section === 2 && r.z > 58.6 && s.press.held) SIM.applyEvent(s, { type: 'press', down: false });
  if (r.onLift && s.lift.y < 0 && !s.lift.moving && r.z > 63) SIM.applyEvent(s, { type: 'lift.toggle' });
  if (s.section === 3 && !r.committed && !s._e) {
    SIM.applyEvent(s, { type: 'exit.lever' });
    SIM.applyEvent(s, { type: 'key', down: true });
    s._e = 1;
  }
  if (s.dead) s._t = s._p = s._e = 0;
  return null;
}
{
  let wins = 0;
  let deaths = 0;
  let worst = 0;
  const seeds = 60;
  for (let seed = 1; seed <= seeds; seed++) {
    const s = SIM.createState(seed);
    s.runner.auto = true;
    for (let i = 0; i < 60 * 40 && !s.won; i++) SIM.step(s, DT, perfectCrew(s));
    wins += s.won ? 1 : 0;
    deaths += s.deaths;
    if (s.won) worst = Math.max(worst, s.wonTime);
  }
  check(`a full run completes on every rolled layout (${seeds} seeds)`, wins === seeds && deaths === 0, `wins=${wins} deaths=${deaths} slowest=${worst.toFixed(1)} s of running`);
}

// --------------------------------------- 2. every beat fails without its owner
const go = (extra = {}) => () => ({ yaw: 0, f: 1, s: 0, jump: false, ...extra });
// the Runner can see the catwalk gap (it is shape): he jumps it at z 71.4
const hop = (s) => s.runner.y > 3.5 && s.runner.z > 71.4 && s.runner.z < 72.2;
const steerTo = (tx, extra = {}) => (s) => ({ yaw: 0, f: 1, s: Math.max(-1, Math.min(1, (s.runner.x - tx) * 2.5)), jump: false, ...extra });
{
  // the span
  let dead = 0;
  let wrongDead = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const s = run(at(0, seed), steerTo(laneX(SIM.createState(seed).layout.spanLane)));
    dead += s.dead ? 1 : 0;
    const w = at(0, seed);
    const wrong = laneX((w.layout.spanLane + 1) % 3);
    run(w, (q) => {
      if (q.runner.z > 14 && q.span.phase === 'out' && !q._t) {
        SIM.applyEvent(q, { type: 'span.throw' });
        q._t = 1;
      }
      return steerTo(wrong)(q);
    });
    wrongDead += w.dead ? 1 : 0;
  }
  check('SPAN: nobody throws it → the Runner falls (every layout)', dead === 30, `${dead}/30`);
  check('SPAN: thrown on time, Runner in the wrong lane → he falls', wrongDead === 30, `${wrongDead}/30`);

  // the hall
  let straight = 0;
  let fixed = 0;
  for (let seed = 1; seed <= 60; seed++) {
    straight += run(at(1, seed), go()).dead ? 1 : 0;
    fixed += run(at(1, seed), steerTo(laneX(seed % 3))).dead ? 1 : 0;
  }
  check('HALL: running straight down the centre dies on every layout', straight === 60, `${straight}/60`);
  check('HALL: holding any one lane dies on every layout', fixed === 60, `${fixed}/60`);

  // the press
  const p0 = run(at(2), go(), { maxT: 3 });
  const p1 = run(at(2), (s) => {
    if (s.runner.committed && !s._p) {
      SIM.applyEvent(s, { type: 'press', down: true });
      s._p = 1;
    }
    if (s.runner.z > 56.3 && s.press.held) SIM.applyEvent(s, { type: 'press', down: false }); // lets go too soon
    return go()(s);
  }, { maxT: 3 });
  check('PRESS: nobody raises it → crushed', p0.dead && p0.deathCause === 'crushed');
  check('PRESS: let go while he is under it → crushed', p1.dead && p1.deathCause === 'crushed');

  // the lift
  const l0 = run(at(2), (s) => {
    if (s.runner.committed && !s._p) {
      SIM.applyEvent(s, { type: 'press', down: true });
      s._p = 1;
    }
    if (s.runner.z > 58.6 && s.press.held) {
      SIM.applyEvent(s, { type: 'press', down: false });
      SIM.applyEvent(s, { type: 'lift.toggle' }); // raised before he is on it
    }
    return go()(s);
  }, { maxT: 6 });
  check('LIFT: raised before he is on it → he falls down the shaft', l0.dead && l0.deathCause === 'fell', `z=${l0.runner.z.toFixed(1)}`);

  // the exit
  const e0 = run(at(3), (s) => {
    if (s.runner.committed && !s._e) {
      SIM.applyEvent(s, { type: 'exit.lever' }); // the Operator arms, nobody turns the key
      s._e = 1;
    }
    return go({ jump: hop(s) })(s);
  }, { maxT: 8 });
  check('EXIT: armed but no key → the collapse takes him at the door', e0.dead && e0.runner.z > 80, `z=${e0.runner.z.toFixed(1)} cause=${e0.deathCause}`);
  const e1 = run(at(3), (s) => {
    if (!s._e) {
      SIM.applyEvent(s, { type: 'key', down: true }); // key without the lever
      s._e = 1;
    }
    return go({ jump: hop(s) })(s);
  }, { maxT: 8 });
  check('EXIT: key but nobody armed it → he does not get out', e1.dead && !e1.won);
  const e2 = at(3);
  SIM.applyEvent(e2, { type: 'exit.lever' });
  for (let i = 0; i < 60 * 3.5; i++) SIM.step(e2, DT, null);
  check('EXIT: an arm nobody turns the key on expires after 3 s', e2.exit.armed === false);
  const b0 = run(at(3), (s) => {
    if (!s._e) {
      SIM.applyEvent(s, { type: 'exit.lever' });
      SIM.applyEvent(s, { type: 'key', down: true });
      s._e = 1;
    }
    return { yaw: 0, f: s.runner.committed ? -1 : 1, s: 0, jump: hop(s) }; // braces the whole way
  }, { maxT: 8 });
  check('COLLAPSE: a Runner who brakes on the catwalk is caught', b0.dead, `cause=${b0.deathCause} z=${b0.runner.z.toFixed(1)}`);
}

// ------------------------------------------------------- 3. measured windows
const windowOf = (xs, ok) => {
  const good = xs.filter(ok);
  return good.length ? [Math.min(...good), Math.max(...good)] : [NaN, NaN];
};
// span: throw time relative to the moment the Runner is at the far edge of his run-up
function spanTry(throwZ, seed = 3) {
  const s = at(0, seed);
  const tx = laneX(s.layout.spanLane);
  s.runner.x = tx;
  run(s, (q) => {
    if (!q._t && q.runner.z >= throwZ) {
      SIM.applyEvent(q, { type: 'span.throw' });
      q._t = 1;
    }
    return steerTo(tx)(q);
  });
  return passed(s, 0);
}
const zs = [];
for (let z = 6; z <= 20; z += 0.1) zs.push(+z.toFixed(1));
const spanW = windowOf(zs, (z) => spanTry(z));
const spanSec = (spanW[1] - spanW[0]) / SIM.TUNING.runSpeed;
console.log(`\n  SPAN  throw window:  Runner at z ∈ [${spanW[0]}, ${spanW[1]}] m  = ${spanSec.toFixed(2)} s`);

// press: raise time relative to the Runner's commit
function pressTry(dt0) {
  const s = at(2);
  let tc = null;
  run(s, (q) => {
    if (tc === null && q.runner.committed) tc = q.t;
    if (dt0 < 0 && !q._p && q.t >= 0.5 + dt0) {
      SIM.applyEvent(q, { type: 'press', down: true });
      q._p = 1;
    }
    if (dt0 >= 0 && tc !== null && !q._p && q.t - tc >= dt0) {
      SIM.applyEvent(q, { type: 'press', down: true });
      q._p = 1;
    }
    return q.t >= 0.5 ? go()(q) : { yaw: 0, f: 0, s: 0, jump: false };
  }, { maxT: 4 });
  return passed(s, 2) || (!s.dead && s.runner.z > 59);
}
const ps = [];
for (let d = -1.5; d <= 1.5; d += 0.02) ps.push(+d.toFixed(2));
const pressW = windowOf(ps, pressTry);
console.log(`  PRESS raise window:  Operator presses at commit ${pressW[0] >= 0 ? '+' : ''}${pressW[0]} … +${pressW[1]} s  = ${(pressW[1] - pressW[0]).toFixed(2)} s`);

// exit: key time relative to the Runner's commit (the lever is armed just before the key)
function exitTry(dk) {
  const s = at(3);
  const tGo = 4;
  run(s, (q) => {
    if (!q._k && q.t >= tGo + dk) {
      SIM.applyEvent(q, { type: 'exit.lever' });
      SIM.applyEvent(q, { type: 'key', down: true });
      q._k = 1;
    }
    return q.t >= tGo ? go({ jump: hop(q) })(q) : { yaw: 0, f: 0, s: 0, jump: false };
  }, { maxT: 14 });
  return s.won;
}
const ks = [];
for (let d = -3; d <= 1.5; d += 0.05) ks.push(+d.toFixed(2));
const exitW = windowOf(ks, exitTry);
console.log(`  EXIT  key window:    Bridge turns the key at commit ${exitW[0]} … ${exitW[1] >= 0 ? '+' : ''}${exitW[1]} s  = ${(exitW[1] - exitW[0]).toFixed(2)} s`);

// catwalk jump: take-off z
function jumpTry(zj) {
  const s = at(3);
  SIM.applyEvent(s, { type: 'exit.lever' });
  SIM.applyEvent(s, { type: 'key', down: true });
  run(s, (q) => ({ yaw: 0, f: 1, s: 0, jump: !q._j && q.runner.z >= zj ? (q._j = 1) : false }), { maxT: 10 });
  return s.won;
}
const js = [];
for (let z = 66; z <= 74; z += 0.05) js.push(+z.toFixed(2));
const jumpW = windowOf(js, jumpTry);
console.log(`  JUMP  take-off:      z ∈ [${jumpW[0]}, ${jumpW[1]}] m  = ${((jumpW[1] - jumpW[0]) / SIM.TUNING.runSpeed).toFixed(2)} s`);
check('SPAN throw window is tight but fair (0.5–1.0 s)', spanSec >= 0.5 && spanSec <= 1.0, `${spanSec.toFixed(2)} s`);
check('PRESS raise window is tight but fair (0.5–1.2 s)', pressW[1] - pressW[0] >= 0.5 && pressW[1] - pressW[0] <= 1.2, `${(pressW[1] - pressW[0]).toFixed(2)} s`);
check('EXIT key window exists and needs planning (> 1 s)', exitW[1] - exitW[0] > 1, `${(exitW[1] - exitW[0]).toFixed(2)} s`);
check('JUMP window exists (> 0.25 s)', (jumpW[1] - jumpW[0]) / SIM.TUNING.runSpeed > 0.25);

// ----------------------------------------------- 4. human-chain Monte Carlo
// ASSUMPTIONS (not measurements): reaction to a heard word N(0.40, 0.12) s for a first-time
// player, N(0.30, 0.06) practised; voice latency 0.08 s + 0.15 s of the word before it is
// understood; the Bridge aims his call by eye with a position error of 1.4 m (first-time)
// or 0.6 m (practised). These come from typical simple-reaction-time figures; real numbers
// must come from playtests.
const P = {
  first: { rt: [0.4, 0.12], aim: 1.4, steer: 1.0, sync: 0.12, seam: 0.5 },
  practised: { rt: [0.3, 0.06], aim: 0.6, steer: 0.45, sync: 0.06, seam: 1 },
};
const HEAR = 0.08 + 0.15;
function mcSpan(p) {
  const s = at(0, Math.floor(urand() * 1e6));
  const tx = laneX(s.layout.spanLane); // the lane was called at the station, in the plan
  s.runner.x = tx;
  // a Bridge aims to finish "THROW" one human chain before the throw window's middle
  const ideal = (spanW[0] + spanW[1]) / 2 - SIM.TUNING.runSpeed * (HEAR + P.practised.rt[0]);
  const callZ = gauss(ideal, p.aim);
  let throwAt = null;
  run(s, (q) => {
    if (throwAt === null && q.runner.z >= callZ) throwAt = q.t + HEAR + Math.max(0.12, gauss(...p.rt));
    if (throwAt !== null && q.t >= throwAt && !q._t) {
      SIM.applyEvent(q, { type: 'span.throw' });
      q._t = 1;
    }
    return steerTo(tx)(q);
  });
  return passed(s, 0);
}
function mcHall(p) {
  // the path is chalked during the plan. A Runner who has learned the hall steers to the
  // seam between the two lanes first (forgiving); a first-timer, half the time, steers
  // straight from lane centre to lane centre when the step is `lead` m away (a 0.15 s target)
  const s = at(1, Math.floor(urand() * 1e6));
  const H = LEVEL.hall;
  const seam = urand() < p.seam;
  const leads = s.layout.hall.map(() => gauss(seam ? 3.2 : 2.6, p.steer));
  run(s, (q) => {
    const r = q.runner;
    let seg = Math.max(0, Math.min(H.segs - 1, Math.floor((r.z - H.z0) / H.segLen)));
    let tx = laneX(q.layout.hall[seg]);
    const nextSeg = seg + 1;
    if (nextSeg < H.segs && r.z >= H.z0 - 1) {
      const dist = H.z0 + nextSeg * H.segLen - r.z;
      const nl = q.layout.hall[nextSeg];
      if (nl !== q.layout.hall[seg] && dist <= leads[nextSeg]) tx = seam ? laneX(q.layout.hall[seg]) + Math.sign(laneX(nl) - tx) * LANE_W * 0.5 : laneX(nl);
    }
    if (r.z < H.z0) tx = laneX(q.layout.hall[0]);
    return { yaw: 0, f: 1, s: Math.max(-1, Math.min(1, (r.x - tx) * 2.5)), jump: false };
  });
  return passed(s, 1);
}
function mcPress(p) {
  // the Bridge counts "3, 2, 1"; the Operator presses on ONE, the Runner goes on ONE
  const s = at(2);
  const tOne = 0.5;
  const tRun = tOne + HEAR + Math.max(0.12, gauss(...p.rt));
  const tPress = tOne + HEAR + Math.max(0.12, gauss(...p.rt)) + gauss(0, p.sync);
  run(s, (q) => {
    if (!q._p && q.t >= tPress) {
      SIM.applyEvent(q, { type: 'press', down: true });
      q._p = 1;
    }
    // the Operator lets go when the Bridge says "through" (or the press overheats)
    if (q._p && q.runner.z > 58.8 && q.press.held) SIM.applyEvent(q, { type: 'press', down: false });
    return q.t >= tRun ? go()(q) : { yaw: 0, f: 0, s: 0, jump: false };
  }, { maxT: 6 });
  return !s.dead && s.runner.z > 59;
}
function mcExit(p) {
  // plan: "ARM" → the Operator arms; the Bridge sees it lit, turns the key and says "GO";
  // the Runner sees the gap himself and jumps
  const s = at(3);
  const tArm = 0.5 + HEAR + Math.max(0.12, gauss(...p.rt));
  const tKey = tArm + Math.max(0.15, gauss(0.5, 0.2));
  const tGo = tKey + Math.max(0, gauss(0.3, 0.3)) + HEAR + Math.max(0.12, gauss(...p.rt));
  const jumpZ = gauss(71.4, p.steer * 0.5);
  run(s, (q) => {
    if (!q._a && q.t >= tArm) {
      SIM.applyEvent(q, { type: 'exit.lever' });
      q._a = 1;
    }
    if (!q._k && q.t >= tKey) {
      SIM.applyEvent(q, { type: 'key', down: true });
      q._k = 1;
    }
    const jump = !q._j && q.runner.z >= jumpZ;
    if (jump) q._j = 1;
    return { yaw: 0, f: q.t >= tGo ? 1 : 0, s: 0, jump };
  }, { maxT: 14 });
  return s.won;
}
console.log('\n  human-chain model (2000 runs each)       first-time   practised');
const mcRes = {};
for (const [name, fn] of Object.entries({ SPAN: mcSpan, HALL: mcHall, PRESS: mcPress, EXIT: mcExit })) {
  const res = {};
  for (const [k, p] of Object.entries(P)) {
    let ok = 0;
    for (let i = 0; i < 2000; i++) ok += fn(p) ? 1 : 0;
    res[k] = ok / 2000;
  }
  mcRes[name] = res;
  console.log(`  ${name.padEnd(40)} ${pct(res.first).padStart(9)}   ${pct(res.practised).padStart(9)}`);
}
const whole = (k) => Object.values(mcRes).reduce((a, r) => a * r[k], 1);
console.log(`  ${'whole level, no deaths'.padEnd(40)} ${pct(whole('first')).padStart(9)}   ${pct(whole('practised')).padStart(9)}`);
for (const name of ['SPAN', 'HALL', 'PRESS']) {
  check(`${name}: a challenge for a first-time team, learnable with practice (35–95% → ≥ 85%)`, mcRes[name].first >= 0.35 && mcRes[name].first <= 0.95 && mcRes[name].practised >= 0.85, `${pct(mcRes[name].first)} → ${pct(mcRes[name].practised)}`);
}
check('EXIT: the finale is a triumph more often than not (≥ 60% → ≥ 85%)', mcRes.EXIT.first >= 0.6 && mcRes.EXIT.practised >= 0.85, `${pct(mcRes.EXIT.first)} → ${pct(mcRes.EXIT.practised)}`);

// ------------------------------------------------------ 5. blind/random play
{
  let ok = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    const s = at(1, 1000 + i);
    let tx = laneX(Math.floor(urand() * 3));
    run(s, (q) => {
      if (urand() < 0.03) tx = laneX(Math.floor(urand() * 3));
      return { yaw: 0, f: 1, s: Math.max(-1, Math.min(1, (q.runner.x - tx) * 2.5)), jump: urand() < 0.04 };
    });
    ok += passed(s, 1) ? 1 : 0;
  }
  check('HALL: a Runner guessing lanes and hopping at random gets through < 15%', ok / N < 0.15, pct(ok / N));
  let hop = 0;
  for (let i = 0; i < 100; i++) hop += passed(run(at(1, 2000 + i), go({ jump: true })), 1) ? 1 : 0;
  check('HALL: holding SPACE (bunny-hopping) gets through < 15%', hop / 100 < 0.15, pct(hop / 100));
  let guess = 0;
  for (let i = 0; i < 300; i++) {
    const s = at(0, 3000 + i);
    const tx = laneX(Math.floor(urand() * 3));
    run(s, (q) => {
      if (q.runner.z > 15 && !q._t) {
        SIM.applyEvent(q, { type: 'span.throw' });
        q._t = 1;
      }
      return steerTo(tx)(q);
    });
    guess += passed(s, 0) ? 1 : 0;
  }
  check('SPAN: perfect throw but the Runner guesses the lane → about 1 in 3', guess / 300 > 0.2 && guess / 300 < 0.45, pct(guess / 300));
}

// ------------------------------------------------ 6. stations, momentum, dice
{
  const s = at(0);
  for (let i = 0; i < 120; i++) SIM.step(s, DT, { yaw: 0, f: 0, s: 1, jump: true });
  check('at a station he holds still until he commits (strafing allowed, no jumping)', Math.abs(s.runner.z - 2) < 1e-6 && s.runner.x < -1 && s.runner.y === 0 && !s.runner.committed);
  for (let i = 0; i < 30; i++) SIM.step(s, DT, { yaw: 0, f: 1, s: 0, jump: false });
  const z1 = s.runner.z;
  for (let i = 0; i < 30; i++) SIM.step(s, DT, { yaw: 0, f: 0, s: 0, jump: false });
  check('once committed, letting go of W does not stop him', s.runner.committed && s.runner.vz > 6.5 && s.runner.z - z1 > 3);
  for (let i = 0; i < 30; i++) SIM.step(s, DT, { yaw: 0, f: -1, s: 0, jump: false });
  const braced = s.runner.vz;
  for (let i = 0; i < 60; i++) SIM.step(s, DT, { yaw: 0, f: -1, s: 0, jump: false });
  check('S braces him to 3 m/s, but only for 1.2 s per section', Math.abs(braced - 3) < 0.05 && s.runner.vz > 6.5 && s.runner.brace === 0, `braced=${braced.toFixed(2)} later=${s.runner.vz.toFixed(2)}`);

  const a = SIM.createState(77);
  const b = SIM.createState(77);
  check('the same seed rolls the same layout (server and client agree)', JSON.stringify(a.layout) === JSON.stringify(b.layout));
  const seen = new Set();
  const d = at(1, 5);
  for (let k = 0; k < 20; k++) {
    seen.add(JSON.stringify(d.layout));
    d.runner.y = -20;
    SIM.step(d, DT, null);
    for (let i = 0; i < 70; i++) SIM.step(d, DT, null);
  }
  check('every death re-rolls the layout (memorising it is useless)', seen.size >= 12 && d.deaths === 20 && d.section === 1, `${seen.size} layouts in 20 deaths`);
  check('a death respawns him standing at his last station, chalk and stamps cleared, ink refilled', !d.dead && d.runner.z === LEVEL.stations[1].z && !d.runner.committed && d.ink === 6 && d.chalk.length === 0);
  let feasible = 0;
  for (let seed = 0; seed < 500; seed++) {
    const L = SIM.createState(seed).layout;
    feasible += L.hall.every((l, i) => i === 0 || Math.abs(l - L.hall[i - 1]) <= 1) && !L.hall.every((l) => l === L.hall[0]) ? 1 : 0;
  }
  check('every rolled hall is passable (one lane per step) and never a straight line', feasible === 500, `${feasible}/500`);
  const tiles = hallTiles(SIM.createState(9).layout);
  check('the hall is 9 tiles, 3 true, 6 lies', tiles.length === 9 && tiles.filter((t) => !t.fake).length === 3);
}

// ----------------------------------------------------------- 7. integrity
{
  const late = (z) => {
    const s = at(0, 11);
    s.runner.x = laneX(s.layout.spanLane);
    let minY = 0;
    run(s, (q) => {
      if (!q._t && q.runner.z >= z) {
        SIM.applyEvent(q, { type: 'span.throw' });
        q._t = 1;
      }
      minY = Math.min(minY, q.runner.y);
      return steerTo(laneX(q.layout.spanLane))(q);
    });
    return { dead: s.dead, minY };
  };
  const tooLate = late(19.6);
  check('a span thrown after he is already falling does not teleport him up', tooLate.dead);
  const r = SIM.createState(3);
  for (let i = 0; i < 6; i++) SIM.applyEvent(r, { type: 'chalk', x: 0, y: 0, z: 10 });
  for (let i = 0; i < 3; i++) SIM.applyEvent(r, { type: 'knock' });
  r.deaths = 4;
  r.won = true;
  r.section = 3;
  SIM.applyEvent(r, { type: 'reset' });
  check('reset is a full new run (ink, knocks, chalk, deaths, win, station)', r.ink === 6 && r.knocks === 3 && r.chalk.length === 0 && r.deaths === 0 && !r.won && r.section === 0 && r.runner.z === LEVEL.start.z);
  const g = SIM.createState();
  SIM.applyEvent(g, { type: 'chalk', x: 'x', y: NaN, z: Infinity, dir: 'evil' });
  SIM.applyEvent(g, { type: 'stamp', icon: 'xxxxxxxx', x: undefined, z: -1e9 });
  const c = g.chalk[0];
  const st = g.stamps[0];
  check('untrusted chalk/stamp payloads are clamped', [c.x, c.y, c.z, st.x, st.z].every(Number.isFinite) && c.dir === 'forward' && st.icon.length <= 2);
  const busy = SIM.createState();
  for (let i = 0; i < 400; i++) {
    busy.t += 0.5;
    SIM.applyEvent(busy, { type: 'stamp', icon: '▲', x: 0, z: 10 });
    if (i < 6) SIM.applyEvent(busy, { type: 'chalk', x: 1.234567, y: 0, z: 33.33333 });
  }
  const bytes = JSON.stringify(SIM.snapshotOf(busy), (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v)).length;
  check('snapshots stay bounded after a long session (< 1.6 KB on the wire)', bytes < 1600, `${bytes} B`);
}

console.log(`\n${fails === 0 ? 'all checks passed' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
