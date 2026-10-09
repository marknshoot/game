// RELAY prototype — authoritative simulation. Pure, deterministic, fixed dt.
import { LEVEL } from './level.js';

export const TUNING = {
  runSpeed: 6.6,
  accel: 45,
  friction: 55,
  gravity: 42,
  jumpV: 14.6,
  coyote: 0.1,
  jumpBuffer: 0.12,
  runnerW: 0.7,
  runnerH: 1.7,

  spanTravel: 0.7, // s for the slide bridge to reach full extension
  spanHold: 2.6, // s it stays out before auto-retracting
  spanRetract: 0.5,
  motorWindow: 8.0, // throws inside this window count against the motor
  motorMax: 2,
  motorLock: 6.0,

  keyHoldTime: 1.5, // two-man rule
  startLine: 4,
  respawnDelay: 1.0,
};

const EPS = 1e-4;
const clone = (o) => JSON.parse(JSON.stringify(o));

export function createState() {
  return {
    t: 0,
    started: false,
    startTime: 0,
    dead: false,
    respawnIn: 0,
    deaths: 0,
    won: false,
    wonTime: 0,
    ghost: [], // last 6 s of runner positions, for the replay
    checkpoint: LEVEL.spawnX,

    runner: { x: LEVEL.spawnX, y: 0, vx: 0, vy: 0, ground: true, face: 1, coyote: 0, buffer: 0, jumping: false },
    input: { left: false, right: false, jump: false },

    span: { phase: 'out', timer: 0, throws: [], lockUntil: 0 },
    exit: { armed: false, open: false },
    key: { held: false, hold: 0 },

    ink: 6,
    knocks: 3,
    phraseCd: 0,

    chalk: [], // {x, y, dir}
    phrases: [], // {text, t}
    stamps: [], // {icon, x, t}
    knockFx: [], // {t}
    fx: [], // {text, t, kind}

    stats: { phrases: 0, chalk: 0, knocks: 0, throws: 0 },
  };
}

export function solidsOf(s) {
  const out = LEVEL.solids.slice();
  if (s.span.phase === 'extended' || s.span.phase === 'retracting') {
    out.push({ x: LEVEL.span.x, y: LEVEL.span.y, w: LEVEL.span.w, h: LEVEL.span.h, kind: 'span' });
  }
  if (!s.exit.open) {
    out.push({ x: LEVEL.exit.x, y: 0, w: LEVEL.exit.w, h: LEVEL.exit.h, kind: 'door' });
  }
  out.push({ x: LEVEL.backWall, y: 0, w: 1, h: 4, kind: 'wall' });
  return out;
}

const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export function runnerRect(r) {
  return { x: r.x - TUNING.runnerW / 2, y: r.y, w: TUNING.runnerW, h: TUNING.runnerH };
}

export function applyEvent(s, ev) {
  if (!ev || !ev.type) return;
  const now = s.t;
  switch (ev.type) {
    case 'span.throw': {
      if (s.span.lockUntil > now) return pushFx(s, 'MOTOR LOCKED', 'bad');
      if (s.span.phase === 'out') {
        s.span.phase = 'moving';
        s.span.timer = TUNING.spanTravel;
        s.span.throws = s.span.throws.filter((t) => now - t < TUNING.motorWindow);
        s.span.throws.push(now);
        s.stats.throws++;
        if (s.span.throws.length >= TUNING.motorMax) {
          s.span.lockUntil = now + TUNING.motorLock;
          pushFx(s, 'MOTOR OVERHEAT', 'warn');
        }
      } else {
        pushFx(s, 'BRIDGE BUSY', 'muted');
      }
      return;
    }
    case 'exit.lever': {
      if (s.exit.open) return;
      if (!s.exit.armed) {
        s.exit.armed = true;
        pushFx(s, 'EXIT ARMED — WAITING FOR 2nd KEY', 'ok');
      }
      return;
    }
    case 'exit.unarm': {
      s.exit.armed = false;
      return;
    }
    case 'key': {
      s.key.held = !!ev.down;
      if (!ev.down) s.key.hold = 0;
      return;
    }
    case 'phrase': {
      if (s.phraseCd > 0) return;
      s.phraseCd = 1.2;
      s.phrases.push({ text: ev.text, t: now });
      s.stats.phrases++;
      return;
    }
    case 'chalk': {
      if (s.ink <= 0) return;
      s.ink--;
      s.stats.chalk++;
      s.chalk.push({ x: ev.x, y: ev.y, dir: ev.dir || 'right' });
      return;
    }
    case 'stamp': {
      s.stamps.push({ icon: ev.icon, x: ev.x, t: now });
      return;
    }
    case 'knock': {
      if (s.knocks <= 0) return;
      s.knocks--;
      s.stats.knocks++;
      s.knockFx.push({ t: now });
      return;
    }
    case 'auto': {
      s.runner.auto = !!ev.on;
      pushFx(s, s.runner.auto ? 'AUTOPILOT ON (demo)' : 'AUTOPILOT OFF', 'muted');
      return;
    }
    case 'reset': {
      const keep = { ink: s.ink, knocks: s.knocks, deaths: s.deaths, stats: s.stats, chalk: s.chalk, phrases: s.phrases, stamps: s.stamps };
      const fresh = createState();
      Object.assign(s, fresh, keep);
      return;
    }
  }
}

function pushFx(s, text, kind) {
  s.fx.push({ text, t: s.t, kind: kind || 'muted' });
  if (s.fx.length > 40) s.fx.shift();
}

export function step(s, dt, input) {
  if (s.dead) {
    s.respawnIn -= dt;
    if (s.respawnIn <= 0) respawn(s);
    s.t += dt;
    return;
  }
  if (s.won) {
    s.t += dt;
    return;
  }

  if (input) s.input = input;

  // clock starts at the line
  if (!s.started && s.runner.x >= TUNING.startLine) {
    s.started = true;
    s.startTime = s.t;
  }

  const r = s.runner;

  // --- timers
  s.phraseCd = Math.max(0, s.phraseCd - dt);

  // --- span state machine
  const sp = s.span;
  if (sp.phase === 'moving') {
    sp.timer -= dt;
    if (sp.timer <= 0) {
      sp.phase = 'extended';
      sp.timer = TUNING.spanHold;
    }
  } else if (sp.phase === 'extended') {
    sp.timer -= dt;
    if (sp.timer <= 0) {
      sp.phase = 'retracting';
      sp.timer = TUNING.spanRetract;
    }
  } else if (sp.phase === 'retracting') {
    sp.timer -= dt;
    if (sp.timer <= 0) sp.phase = 'out';
  }

  // --- two-man key
  if (s.key.held && s.exit.armed && !s.exit.open) {
    s.key.hold += dt;
    if (s.key.hold >= TUNING.keyHoldTime) {
      s.exit.open = true;
      pushFx(s, 'EXIT OPEN', 'ok');
    }
  }

  // --- runner control (may be overridden by autopilot)
  const dir = (s.input.right ? 1 : 0) - (s.input.left ? 1 : 0);
  if (r.auto) {
    autopilot(s);
  } else {
    if (dir !== 0) {
      r.vx += dir * TUNING.accel * dt;
      r.face = dir;
    } else {
      const fr = TUNING.friction * dt;
      if (Math.abs(r.vx) <= fr) r.vx = 0;
      else r.vx -= Math.sign(r.vx) * fr;
    }
    if (Math.abs(r.vx) > TUNING.runSpeed) r.vx = Math.sign(r.vx) * TUNING.runSpeed;
    if (s.input.jump) r.buffer = TUNING.jumpBuffer;
  }

  r.buffer = Math.max(0, r.buffer - dt);
  r.coyote = Math.max(0, r.coyote - dt);

  if (r.buffer > 0 && r.coyote > 0) {
    r.vy = TUNING.jumpV;
    r.buffer = 0;
    r.coyote = 0;
    r.ground = false;
    r.jumping = true;
  }

  // --- vertical first, then horizontal (order matters: resolving X while
  //     overlapping a floor tile would shove the Runner sideways out of the floor)
  r.vy -= TUNING.gravity * dt;
  if (r.vy < -40) r.vy = -40;
  r.y += r.vy * dt;
  const solids = solidsOf(s);

  // vertical collision
  r.ground = false;
  let box = runnerRect(r);
  for (const b of solids) {
    if (overlaps(box, b)) {
      if (r.vy <= 0) {
        r.y = b.y + b.h;
        r.vy = 0;
        r.ground = true;
        r.jumping = false;
      } else {
        r.y = b.y - TUNING.runnerH;
        r.vy = 0;
      }
      box = runnerRect(r);
    }
  }
  if (r.ground) r.coyote = TUNING.coyote;

  // horizontal collision
  r.x += r.vx * dt;
  box = runnerRect(r);
  for (const b of solids) {
    if (overlaps(box, b)) {
      if (r.vx > 0) r.x = b.x - TUNING.runnerW / 2 - EPS;
      else if (r.vx < 0) r.x = b.x + b.w + TUNING.runnerW / 2 + EPS;
      r.vx = 0;
      box = runnerRect(r);
    }
  }
  if (r.x < -3.5) r.x = -3.5;

  // --- checkpoints
  for (const c of LEVEL.checkpoints) {
    if (r.x >= c.at && c.at > s.checkpoint) s.checkpoint = c.at;
  }

  // --- death by pit
  if (r.y + TUNING.runnerH < LEVEL.killY) die(s, 'fell');

  // --- win
  if (s.exit.open && r.x >= LEVEL.exit.x + 0.6) {
    s.won = true;
    s.wonTime = s.t - s.startTime;
  }

  // --- ghost ring buffer for the blame replay
  s.ghost.push({ x: r.x, y: r.y, t: s.t });
  while (s.ghost.length && s.t - s.ghost[0].t > 6) s.ghost.shift();

  s.t += dt;
}

function die(s, _why) {
  s.dead = true;
  s.deaths++;
  s.respawnIn = TUNING.respawnDelay;
}

function respawn(s) {
  s.dead = false;
  s.runner = { x: s.checkpoint, y: 0, vx: 0, vy: 0, ground: true, face: 1, coyote: 0, buffer: 0, jumping: false };
  s.span.phase = 'out';
  s.span.timer = 0;
  s.key.hold = 0;
  s.ghost = [];
  s.deadAt = null;
}

// --- demo autopilot: runs right and jumps at the right spots.
// Used by the solo panel so one person can drive the Operator/Bridge and still see the loop.
function autopilot(s) {
  const r = s.runner;
  r.vx = TUNING.runSpeed;
  r.face = 1;

  const jumpAt = [LEVEL.gap.x0 - 1.6, LEVEL.camo.x0 - 1.6];
  for (const jx of jumpAt) {
    const d = jx - r.x;
    if (d < 0.5 && d > -0.5 && r.ground) {
      r.vy = TUNING.jumpV;
      r.ground = false;
      r.coyote = 0;
      break;
    }
  }
}

export function serialize(s) {
  return JSON.stringify(s);
}
export function adopt(target, snapshot) {
  Object.assign(target, clone(snapshot));
  return target;
}
