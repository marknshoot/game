// Headless test/tuning of the 3D level: no browser, no renderer.
// Plays the level with the demo autopilot and a scripted Operator, and measures
// the same design numbers the 2D prototype measured.
import { LEVEL } from '../game/shared/level3d.js';
import * as SIM from '../game/shared/sim3d.js';

const FIXED = 1 / 60;
let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// A scripted Operator/Bridge: throws the span when the Runner is inside a window,
// raises the lift when he stands on it, arms the exit and holds the key.
function play({ autoOperator = true, auto = true, seconds = 60, throwWindow = [6, 15], seed = {} } = {}) {
  const s = SIM.createState();
  s.runner.auto = auto;
  Object.assign(s, seed);
  const log = [];
  const N = Math.round(seconds / FIXED);
  for (let i = 0; i < N; i++) {
    const r = s.runner;
    if (autoOperator && !s.dead && !s.won) {
      if (s.span.phase === 'out' && r.z >= throwWindow[0] && r.z <= throwWindow[1] && !s._threw) {
        SIM.applyEvent(s, { type: 'span.throw' });
        s._threw = true;
        log.push(`t=${s.t.toFixed(2)} span thrown (runner z=${r.z.toFixed(1)})`);
      }
      if (r.onLift && liftIsDown(s) && !s._liftUp) {
        SIM.applyEvent(s, { type: 'lift.toggle' });
        s._liftUp = true;
        log.push(`t=${s.t.toFixed(2)} lift up (runner z=${r.z.toFixed(1)})`);
      }
      if (r.z > 62 && r.y > 3.4 && !s.exit.armed) {
        SIM.applyEvent(s, { type: 'exit.lever' });
        log.push(`t=${s.t.toFixed(2)} exit armed`);
      }
      const hold = r.z > 62 && r.y > 3.4 && s.exit.armed;
      SIM.applyEvent(s, { type: 'key', down: hold });
    }
    SIM.step(s, FIXED, null);
    if (s.dead && !s._logged) {
      s._logged = true;
      log.push(`t=${s.t.toFixed(2)} DEATH at z=${r.z.toFixed(1)} y=${r.y.toFixed(2)} (cp z=${s.checkpoint.z})`);
    }
    if (s.won) break;
  }
  return { s, log };
}

const liftIsDown = (s) => s.lift.y < LEVEL.lift.down + 0.05;

// ---------------------------------------------------------------- 1. the beats
console.log('=== RELAY 3D — headless play tests ===\n');

{
  // nobody operates anything: the Runner must NOT die, he must stop at the gap
  const s = SIM.createState();
  s.runner.auto = true;
  for (let i = 0; i < 60 * 20; i++) SIM.step(s, FIXED, null);
  check('no bridge thrown → autopilot waits instead of falling in', s.deaths === 0 && s.runner.z < LEVEL.gap.z0 + 0.5, `z=${s.runner.z.toFixed(1)} deaths=${s.deaths}`);
}

{
  // a plain runner who never jumps must die in the phantom floor
  const s = SIM.createState();
  s.span.phase = 'extended';
  s.span.timer = 99; // bridge wedged open for the test
  for (let i = 0; i < 60 * 20; i++) {
    SIM.step(s, FIXED, { yaw: 0, f: 1, s: 0, jump: false });
    if (s.dead) break;
  }
  check('phantom floor kills a Runner who is never told to jump', s.dead === true, `z=${s.runner.z.toFixed(1)}`);
}

{
  const { s, log } = play();
  console.log(log.map((l) => '      ' + l).join('\n'));
  check('full run with Operator + Bridge: completes', s.won === true, `time=${s.wonTime?.toFixed(2)}s z=${s.runner.z.toFixed(1)} y=${s.runner.y.toFixed(2)} deaths=${s.deaths}`);
  check('no deaths on a clean run', s.deaths === 0);
  check('the lift was used', s.stats.lifts >= 1, `lifts=${s.stats.lifts}`);
  check('the two-key rule was satisfied', s.exit.open > 0.9);
}

// ------------------------------------------------- 2. the two-key rule is real
{
  const s = SIM.createState();
  s.runner.auto = true;
  s.span.phase = 'extended';
  s.span.timer = 99;
  for (let i = 0; i < 60 * 40; i++) {
    SIM.applyEvent(s, { type: 'lift.toggle' });
    SIM.applyEvent(s, { type: 'exit.lever' });
    SIM.step(s, FIXED, null);
    if (s.won) break;
  }
  check('Operator alone (lever, no key) cannot finish the level', s.won === false, `z=${s.runner.z.toFixed(1)} won=${s.won}`);
}

// ------------------------------------------- 3. measured windows, as in the 2D build
function throwAt(z) {
  const s = SIM.createState();
  s.runner.auto = true;
  for (let i = 0; i < 60 * 20; i++) {
    if (!s._threw && s.runner.z >= z) {
      SIM.applyEvent(s, { type: 'span.throw' });
      s._threw = true;
    }
    SIM.step(s, FIXED, null);
    if (s.dead) return 'FALL';
    if (s.runner.z > 30) return 'CLEAR';
  }
  return 'STUCK';
}
function jumpAt(z) {
  const s = SIM.createState();
  s.runner.x = 0;
  s.runner.z = 36;
  s.span.phase = 'extended';
  s.span.timer = 99;
  let pressed = false;
  for (let i = 0; i < 60 * 10; i++) {
    const jump = !pressed && s.runner.z >= z;
    if (jump) pressed = true;
    SIM.step(s, FIXED, { yaw: 0, f: 1, s: 0, jump });
    if (s.dead) return 'FALL';
    if (s.runner.z > 52) return 'CLEAR';
  }
  return 'STUCK';
}
function callAt(beatZ, d, action, reaction, startZ) {
  const s = SIM.createState();
  s.runner.z = startZ;
  let calledAt = null;
  let fired = false;
  for (let i = 0; i < 60 * 25; i++) {
    if (calledAt === null && s.runner.z >= beatZ - d) calledAt = s.t;
    let jump = false;
    if (calledAt !== null && !fired && s.t - calledAt >= reaction) {
      if (action === 'throw') SIM.applyEvent(s, { type: 'span.throw' });
      else jump = true;
      fired = true;
    }
    SIM.step(s, FIXED, { yaw: 0, f: 1, s: 0, jump });
    if (s.dead) return 'FALL';
    if (s.runner.z > beatZ + 14) return 'CLEAR';
  }
  return 'STUCK';
}
const window_ = (rows) => {
  const ok = rows.filter(([, r]) => r === 'CLEAR').map(([v]) => v);
  return ok.length ? [Math.min(...ok), Math.max(...ok)] : [NaN, NaN];
};

const tw = window_(Array.from({ length: 16 }, (_, i) => [2 + i, throwAt(2 + i)]));
console.log(`\n  throw window (Operator):   z ∈ [${tw[0]}, ${tw[1]}] m  (${(tw[1] - tw[0] + 1) / SIM.TUNING.runSpeed} s wide)`);
const jrows = [];
for (let z = 39; z <= 45; z += 0.5) jrows.push([z, jumpAt(z)]);
const jw = window_(jrows);
console.log(`  jump window (Runner):      z ∈ [${jw[0]}, ${jw[1]}] m  (${((jw[1] - jw[0]) / SIM.TUNING.runSpeed).toFixed(2)} s wide)`);
const crows = [];
for (let d = 1; d <= 12; d += 0.5) crows.push([d, callAt(LEVEL.phantom.z0, d, 'jump', 0.3, LEVEL.phantom.z0 - 16)]);
const cw = window_(crows);
console.log(`  call window (Bridge):      d ∈ [${cw[0]}, ${cw[1]}] m from the hole  (${((cw[1] - cw[0]) / SIM.TUNING.runSpeed).toFixed(2)} s wide)`);
console.log(`  beat callLeads in level:  ${LEVEL.beats.map((b) => `${b.kind}=${b.callLead}m`).join('  ')}`);

check('throw window exists and is fair (>0.8 s)', tw[1] - tw[0] > 2, `${((tw[1] - tw[0] + 1) / SIM.TUNING.runSpeed).toFixed(2)} s`);
check('jump window exists', jw[1] - jw[0] > 1, `z ${jw[0]}..${jw[1]}`);
check('call window contains the level callLead', LEVEL.beats[1].callLead >= cw[0] && LEVEL.beats[1].callLead <= cw[1], `callLead=${LEVEL.beats[1].callLead} window=[${cw[0]},${cw[1]}]`);

console.log(`\n${fails === 0 ? 'all checks passed' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
