// Headless tuning harness — no browser. Runs the sim directly and measures the
// numbers the design is built on: commit distance, throw window, call window.
import { LEVEL } from '../prototype/js/level.js';
import * as SIM from '../prototype/js/sim.js';

const FIXED = 1 / 60;
const GAP = LEVEL.gap.x0;
const PIT = LEVEL.camo.x0;
const RUN = SIM.TUNING.runSpeed;

function fresh({ x = 2, vx = 0 } = {}) {
  const s = SIM.createState();
  s.runner.x = x;
  s.runner.vx = vx;
  return s;
}

// ---- 1. the throw window for the slide bridge -------------------------------
// The Operator throws when the Runner is at x. Does he get across?
function throwAt(x) {
  const s = fresh();
  let thrown = false;
  for (let i = 0; i < 60 * 20; i++) {
    if (!thrown && s.runner.x >= x) {
      SIM.applyEvent(s, { type: 'span.throw' });
      thrown = true;
    }
    SIM.step(s, FIXED, { left: false, right: true, jump: false });
    if (s.dead) return 'FALL';
    if (s.runner.x > 30) return s.span.phase === 'out' ? 'CLEAR (span was gone)' : 'CLEAR';
  }
  return 'STUCK';
}

// ---- 2. the jump window over the phantom floor ------------------------------
function jumpAt(x) {
  const s = fresh({ x: 36, vx: RUN });
  let pressed = false;
  for (let i = 0; i < 60 * 8; i++) {
    let jump = false;
    if (!pressed && s.runner.x >= x) { jump = true; pressed = true; }
    SIM.step(s, FIXED, { left: false, right: true, jump });
    if (s.dead) return 'FALL';
    if (s.runner.x > 52) return 'CLEAR';
  }
  return 'STUCK';
}

// ---- 3. the CALL window: the Bridge speaks when the Runner is d m away, the
//         Runner reacts after `reaction` seconds. Does the call land in time?
function callWindow({ beatX, reaction, action, throwLead = 0 }) {
  const s = fresh({ x: beatX - 40, vx: RUN });
  let called = null;
  let acted = false;
  for (let i = 0; i < 60 * 20; i++) {
    if (called === null && s.runner.x >= beatX - callWindowD) called = s.t;
    const ready = called !== null && s.t - called >= reaction;
    if (ready && !acted) {
      if (action === 'throw') {
        SIM.applyEvent(s, { type: 'span.throw' });
        acted = true;
      } else if (action === 'jump') {
        // hold the key until he actually leaves the ground
        if (s.runner.y < 0.05) act(s);
      }
    }
    SIM.step(s, FIXED, { left: false, right: true, jump: holding });
    if (s.dead) return 'FALL';
    if (s.runner.x > beatX + 12) return 'CLEAR';
  }
  return 'STUCK';
}
let holding = false;
function act() {
  holding = true;
}

function sweepThrow() {
  const rows = [];
  for (let x = 2; x <= 18; x += 1) rows.push([x, throwAt(x)]);
  return rows;
}

function sweepJump() {
  const rows = [];
  for (let x = 39; x <= 45; x += 0.5) rows.push([x, jumpAt(x)]);
  return rows;
}

// call lead sweep -- measured with a modelled human reaction
function sweepCall(beatX, action, reaction, throwLead = 0) {
  const rows = [];
  const startX = beatX === PIT ? beatX - 16 : beatX - 16;
  for (let d = 1; d <= 14; d += 0.5) {
    const r = callWindowAt(beatX, d, action, reaction, startX);
    rows.push([d, r]);
  }
  return rows;
}

function callWindowAt(beatX, d, action, reaction, startX) {
  const s = fresh({ x: startX, vx: RUN });
  let calledAt = null;
  let fired = false;
  let jumpHeld = false;
  for (let i = 0; i < 60 * 20; i++) {
    if (calledAt === null && s.runner.x >= beatX - d) calledAt = s.t;
    if (calledAt !== null && !fired && s.t - calledAt >= reaction) {
      if (action === 'throw') {
        SIM.applyEvent(s, { type: 'span.throw' });
        fired = true;
      } else if (action === 'jump') {
        jumpHeld = true; // one frame only: a single human press
        fired = true;
      }
    }
    SIM.step(s, FIXED, { left: false, right: true, jump: jumpHeld });
    jumpHeld = false;
    if (s.dead) return 'FALL';
    if (s.runner.x > beatX + 14) return 'CLEAR';
  }
  return 'STUCK';
}

const fmtSweep = (rows, unit = 'm') => {
  let best = [];
  let cur = [];
  const out = rows.map(([x, r]) => {
    if (r.startsWith('CLEAR')) {
      cur.push(x);
    } else if (cur.length) {
      if (cur.length > best.length) best = cur;
      cur = [];
    }
    return `${unit === 'm' ? 'x' : 'd'}=${String(x).padStart(4)} ${r === 'FALL' ? '✗' : r === 'STUCK' ? '·' : '✓'}`;
  });
  if (cur.length > best.length) best = cur;
  return { lines: out, window: best };
};

console.log('RELAY — measured beat windows (headless)\n');

const T = fmtSweep(sweepThrow());
console.log('1) SLIDE BRIDGE — Operator throws when the Runner is at x:');
console.log('   ' + T.lines.join('\n   '));
console.log(`   → throw window: x ∈ [${T.window[0]}, ${T.window[T.window.length - 1]}] m  (${(T.window.length / RUN).toFixed(2)} s wide)\n`);

const J = fmtSweep(sweepJump());
console.log('2) PHANTOM FLOOR — Runner presses jump at x (he cannot see the hole):');
console.log('   ' + J.lines.join('\n   '));
console.log(`   → jump window: x ∈ [${J.window[0]}, ${J.window[J.window.length - 1]}] m  (${(J.window.length / RUN).toFixed(2)} s wide)`);
console.log(`   → commit point: x = ${PIT - J.window.length - 0.35} m (past this he cannot reach the far edge)\n`);

console.log('3) THE CALL — Bridge speaks when the Runner is d m from the Phantom Floor,');
console.log('   Runner reacts 0.30 s later (human reaction on the phrase wheel):');
const C1 = fmtSweep(sweepCall(PIT, 'jump', 0.3));
console.log('   ' + C1.lines.join('\n   '));
console.log(`   → useful call window: d ∈ [${C1.window[0]}, ${C1.window[C1.window.length - 1]}] m\n`);

console.log('4) THE CALL — Bridge says THROW when the Runner is d m from the gap,');
console.log('   Operator reacts 0.25 s later:');
const C2 = fmtSweep(sweepCall(GAP, 'throw', 0.25));
console.log('   ' + C2.lines.join('\n   '));
console.log(`   → useful call window: d ∈ [${C2.window[0]}, ${C2.window[C2.window.length - 1]}] m\n`);

console.log('5) WHOLE LEVEL, played by the demo autopilot:');
{
  const s = SIM.createState();
  s.runner.auto = true;
  let thrown = false;
  for (let i = 0; i < 60 * 30; i++) {
    if (!thrown && s.runner.x >= 12) {
      SIM.applyEvent(s, { type: 'span.throw' });
      thrown = true;
    }
    if (s.runner.x >= 50 && !s.exit.armed) SIM.applyEvent(s, { type: 'exit.lever' });
    if (s.runner.x >= 55) SIM.applyEvent(s, { type: 'key', down: !s.exit.open });
    SIM.step(s, FIXED, null);
    if (s.won) break;
  }
  console.log(`   won=${s.won} time=${s.wonTime ? s.wonTime.toFixed(2) : '-'}s deaths=${s.deaths}\n`);
}

console.log('Design rule: an action window must be wider than (Bridge latency + the other');
console.log('player reaction + travel time), or the beat feels unfair instead of funny.');
