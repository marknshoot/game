// RELAY 3D — authoritative simulation. Deterministic, no three.js, no DOM.
// Runs identically in Node (server) and in the browser (prediction).
import { LEVEL } from './level3d.js';

export const TUNING = {
  runSpeed: 6.6,
  accel: 45,
  friction: 55,
  gravity: 42,
  jumpV: 14.6,
  coyote: 0.1,
  jumpBuffer: 0.12,
  radius: 0.36,
  height: 1.7,
  eye: 1.55,

  spanTravel: 0.7,
  spanHold: 2.6,
  spanRetract: 0.5,
  motorWindow: 8.0,
  motorMax: 2,
  motorLock: 6.0,

  liftTravel: 1.6,
  keyHoldTime: 1.5,
  startZ: 4,
  respawnDelay: 1.0,
  phraseCd: 1.2,
  chalkInk: 6,
  knocks: 3,
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
    checkpoint: { z: LEVEL.start.z, y: LEVEL.start.y },
    ghost: [],

    runner: {
      x: LEVEL.start.x,
      y: LEVEL.start.y,
      z: LEVEL.start.z,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      ground: true,
      coyote: 0,
      buffer: 0,
      auto: false,
      onLift: false,
    },
    input: { yaw: 0, f: 0, s: 0, jump: false },

    span: { phase: 'out', timer: 0, throws: [], lockUntil: 0 },
    lift: { y: LEVEL.lift.down, target: LEVEL.lift.down, moving: false },
    exit: { armed: false, open: 0 }, // open: 0..1 (door slides up)
    key: { held: false, hold: 0 },

    ink: TUNING.chalkInk,
    knocks: TUNING.knocks,
    phraseCd: 0,

    chalk: [],
    phrases: [],
    stamps: [],
    knockFx: [],
    fx: [],
    players: {},

    stats: { phrases: 0, chalk: 0, knocks: 0, throws: 0, lifts: 0 },
  };
}

// ---------------------------------------------------------------- collisions
const box = (x0, x1, y0, y1, z0, z1, kind) => ({ x0, x1, y0, y1, z0, z1, kind });

export function solidsOf(s) {
  const out = [];
  for (const b of LEVEL.boxes) {
    if (b.kind === 'wall' || b.kind === 'floor' || b.kind === 'lip' || b.kind === 'catwalk' || b.kind === 'rail') out.push(b);
  }
  // dynamic: slide bridge
  if (s.span.phase === 'extended' || s.span.phase === 'moving' || s.span.phase === 'retracting') {
    let ext = 1;
    if (s.span.phase === 'moving') ext = 1 - Math.max(0, s.span.timer) / TUNING.spanTravel;
    if (s.span.phase === 'retracting') ext = Math.max(0, s.span.timer) / TUNING.spanRetract;
    const sp = LEVEL.span;
    out.push(box(sp.x0, sp.x1, sp.y, sp.y + sp.h, sp.z0, sp.z0 + (sp.z1 - sp.z0) * ext, 'span'));
  }
  // dynamic: lift platform (0.35 m thick deck, top surface at s.lift.y + 0.35)
  const L = LEVEL.lift;
  out.push(box(L.x0, L.x1, s.lift.y, s.lift.y + 0.35, L.z0, L.z1, 'lift'));
  // dynamic: exit door (blocks the catwalk until both keys)
  if (s.exit.open < 0.9) {
    const e = LEVEL.exit;
    out.push(box(e.x0, e.x1, e.y0, e.y1, e.z, e.z + 0.4, 'door'));
  }
  return out;
}

export function liftTop(s) {
  return s.lift.y + 0.35;
}

function aabbOf(r) {
  const T = TUNING;
  return { x0: r.x - T.radius, x1: r.x + T.radius, y0: r.y, y1: r.y + T.height, z0: r.z - T.radius, z1: r.z + T.radius };
}

const hit = (a, c) => a.x0 < c.x1 && a.x1 > c.x0 && a.y0 < c.y1 && a.y1 > c.y0 && a.z0 < c.z1 && a.z1 > c.z0;

// -------------------------------------------------------------------- events
export function applyEvent(s, ev) {
  if (!ev || !ev.type) return;
  const now = s.t;
  switch (ev.type) {
    case 'span.throw': {
      if (s.span.lockUntil > now) return fx(s, 'MOTOR LOCKED', 'bad');
      if (s.span.phase === 'out') {
        s.span.phase = 'moving';
        s.span.timer = TUNING.spanTravel;
        s.span.throws = s.span.throws.filter((t) => now - t < TUNING.motorWindow);
        s.span.throws.push(now);
        s.stats.throws++;
        if (s.span.throws.length >= TUNING.motorMax) {
          s.span.lockUntil = now + TUNING.motorLock;
          fx(s, 'MOTOR OVERHEAT — locked 6 s', 'warn');
        }
      } else fx(s, 'MOTOR BUSY', 'muted');
      return;
    }
    case 'lift.toggle': {
      if (s.lift.moving) return fx(s, 'LIFT MOVING', 'muted');
      const up = s.lift.y < (LEVEL.lift.up + LEVEL.lift.down) * 0.5;
      s.lift.target = up ? LEVEL.lift.up : LEVEL.lift.down;
      s.lift.moving = true;
      s.stats.lifts++;
      fx(s, up ? 'LIFT RISING' : 'LIFT LOWERING', 'ok');
      return;
    }
    case 'exit.lever': {
      if (s.exit.open > 0) return;
      if (!s.exit.armed) {
        s.exit.armed = true;
        fx(s, 'EXIT ARMED — needs the second key', 'ok');
      } else {
        s.exit.armed = false;
        fx(s, 'EXIT DISARMED', 'muted');
      }
      return;
    }
    case 'key': {
      s.key.held = !!ev.down;
      if (!ev.down) s.key.hold = 0;
      return;
    }
    case 'phrase': {
      if (s.phraseCd > 0) return;
      s.phraseCd = TUNING.phraseCd;
      s.phrases.push({ text: String(ev.text || '').slice(0, 16), t: now });
      if (s.phrases.length > 30) s.phrases.shift();
      s.stats.phrases++;
      return;
    }
    case 'chalk': {
      if (s.ink <= 0) return fx(s, 'NO CHALK LEFT', 'warn');
      s.ink--;
      s.stats.chalk++;
      s.chalk.push({ x: ev.x, y: ev.y, z: ev.z, dir: ev.dir || 'forward' });
      return;
    }
    case 'stamp': {
      s.stamps.push({ icon: String(ev.icon || '?'), x: ev.x, z: ev.z, t: now });
      if (s.stamps.length > 20) s.stamps.shift();
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
      fx(s, s.runner.auto ? 'AUTOPILOT ON' : 'AUTOPILOT OFF', 'muted');
      return;
    }
    case 'reset': {
      const keep = { ink: s.ink, knocks: s.knocks, deaths: s.deaths, stats: s.stats, chalk: s.chalk, players: s.players };
      Object.assign(s, createState(), keep);
      return;
    }
  }
}

function fx(s, text, kind) {
  s.fx.push({ text, t: s.t, kind: kind || 'muted' });
  if (s.fx.length > 40) s.fx.shift();
}

// ---------------------------------------------------------------------- step
export function step(s, dt, input) {
  if (input) s.input = input;

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

  const r = s.runner;
  if (!s.started && r.z >= TUNING.startZ) {
    s.started = true;
    s.startTime = s.t;
  }

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

  // --- lift
  if (s.lift.moving) {
    const speed = (LEVEL.lift.up - LEVEL.lift.down) / TUNING.liftTravel;
    const before = s.lift.y;
    if (s.lift.y < s.lift.target) s.lift.y = Math.min(s.lift.target, s.lift.y + speed * dt);
    else s.lift.y = Math.max(s.lift.target, s.lift.y - speed * dt);
    const dy = s.lift.y - before;
    if (dy !== 0 && r.onLift) r.y += dy;
    if (Math.abs(s.lift.y - s.lift.target) < 1e-4) s.lift.moving = false;
  }

  // --- two-key rule + door slide
  if (s.key.held && s.exit.armed && s.exit.open === 0) {
    s.key.hold += dt;
    if (s.key.hold >= TUNING.keyHoldTime) {
      fx(s, 'EXIT OPEN', 'ok');
    }
  }
  const wantOpen = s.key.held && s.exit.armed && s.key.hold >= TUNING.keyHoldTime;
  s.exit.open = Math.max(0, Math.min(1, s.exit.open + (wantOpen ? dt / 0.9 : -dt / 0.9)));

  // --- movement
  if (r.auto) autopilot(s, dt);

  let f = s.input.f || 0;
  let st = s.input.s || 0;
  if (!r.auto) {
    const len = Math.hypot(f, st);
    if (len > 1) {
      f /= len;
      st /= len;
    }
    const yaw = s.input.yaw || 0;
    // camera forward is (sin yaw, 0, cos yaw) and camera right is
    // (-cos yaw, 0, sin yaw): 'D' (st = +1) must move to screen-right (-X)
    const dirX = Math.sin(yaw) * f - Math.cos(yaw) * st;
    const dirZ = Math.cos(yaw) * f + Math.sin(yaw) * st;
    const moving = Math.abs(f) + Math.abs(st) > 0.01;
    if (moving) {
      r.vx += dirX * TUNING.accel * dt;
      r.vz += dirZ * TUNING.accel * dt;
      r.yaw = yaw;
    } else {
      const fr = TUNING.friction * dt;
      for (const k of ['vx', 'vz']) {
        if (Math.abs(r[k]) <= fr) r[k] = 0;
        else r[k] -= Math.sign(r[k]) * fr;
      }
    }
    const sp2 = Math.hypot(r.vx, r.vz);
    if (sp2 > TUNING.runSpeed) {
      r.vx = (r.vx / sp2) * TUNING.runSpeed;
      r.vz = (r.vz / sp2) * TUNING.runSpeed;
    }
    if (s.input.jump) r.buffer = TUNING.jumpBuffer;
  }

  r.buffer = Math.max(0, r.buffer - dt);
  r.coyote = Math.max(0, r.coyote - dt);
  if (r.buffer > 0 && r.coyote > 0) {
    r.vy = TUNING.jumpV;
    r.buffer = 0;
    r.coyote = 0;
    r.ground = false;
  }

  // --- integrate + collide, axis by axis
  const solids = solidsOf(s);

  // Y
  r.vy -= TUNING.gravity * dt;
  if (r.vy < -45) r.vy = -45;
  r.y += r.vy * dt;
  r.ground = false;
  r.onLift = false;
  let a = aabbOf(r);
  for (const c of solids) {
    if (!hit(a, c)) continue;
    if (r.vy <= 0) {
      r.y = c.y1;
      r.vy = 0;
      r.ground = true;
      if (c.kind === 'lift') r.onLift = true;
      a = aabbOf(r);
    } else {
      r.y = c.y0 - TUNING.height;
      r.vy = 0;
      a = aabbOf(r);
    }
  }
  // riding the lift deck: a proximity + support test instead of relying on the
  // AABB to "rest" exactly on it (which fails when the deck sits flush with the floor)
  r.onLift = false;
  {
    const L = LEVEL.lift;
    const top = liftTop(s);
    const pad = TUNING.radius * 0.6;
    if (
      r.z > L.z0 - pad && r.z < L.z1 + pad &&
      r.x > L.x0 - pad && r.x < L.x1 + pad &&
      r.vy <= 0.001 && r.y <= top + 0.22 && r.y > top - 0.8
    ) {
      r.y = top;
      r.vy = 0;
      r.ground = true;
      r.onLift = true;
    }
  }
  if (r.ground) r.coyote = TUNING.coyote;

  // X
  r.x += r.vx * dt;
  a = aabbOf(r);
  for (const c of solids) {
    if (!hit(a, c)) continue;
    if (r.vx > 0) r.x = c.x0 - TUNING.radius - EPS;
    else if (r.vx < 0) r.x = c.x1 + TUNING.radius + EPS;
    r.vx = 0;
    a = aabbOf(r);
  }

  // Z
  r.z += r.vz * dt;
  a = aabbOf(r);
  for (const c of solids) {
    if (!hit(a, c)) continue;
    if (r.vz > 0) r.z = c.z0 - TUNING.radius - EPS;
    else if (r.vz < 0) r.z = c.z1 + TUNING.radius + EPS;
    r.vz = 0;
    a = aabbOf(r);
  }

  // keep inside the corridor
  const wx = LEVEL.corridor.wallX - TUNING.radius;
  if (r.x < -wx) r.x = -wx;
  if (r.x > wx) r.x = wx;

  // checkpoints (the catwalk one needs height, or a Runner walking below it would skip the lift)
  for (const c of LEVEL.checkpoints) {
    if (r.z >= c.z && r.y >= c.y - 0.3 && c.z > s.checkpoint.z) s.checkpoint = { z: c.z, y: c.y };
  }

  if (r.y + TUNING.height < LEVEL.killY) die(s);
  if (r.z > LEVEL.win.z && r.y > LEVEL.win.y) {
    s.won = true;
    s.wonTime = s.t - s.startTime;
  }

  s.ghost.push({ x: r.x, y: r.y, z: r.z, t: s.t });
  while (s.ghost.length && s.t - s.ghost[0].t > 6) s.ghost.shift();

  s.t += dt;
}

function die(s) {
  s.dead = true;
  s.deaths++;
  s.respawnIn = TUNING.respawnDelay;
}

function respawn(s) {
  const c = s.checkpoint;
  s.dead = false;
  s.runner.x = LEVEL.start.x;
  s.runner.y = c.y;
  s.runner.z = c.z;
  s.runner.vx = s.runner.vy = s.runner.vz = 0;
  s.runner.ground = true;
  s.runner.onLift = false;
  s.runner.buffer = s.runner.coyote = 0;
  s.span.phase = 'out';
  s.span.timer = 0;
  s.key.hold = 0;
  s.ghost = [];
}

// Demo autopilot: straight down the gantry, jumping the holes, riding the lift.
// It waits for the world to be right instead of guessing, because the point of the
// demo is that the other two roles still have to do their jobs.
function autopilot(s, dt) {
  const r = s.runner;
  const L = LEVEL.lift;
  r.yaw = 0;
  r.vx *= 1 - Math.min(0.9, 6 * dt);
  r.vz = TUNING.runSpeed;

  // 1. do not sprint into the gap while the bridge is not out
  const dGap = LEVEL.gap.z0 - r.z;
  if (dGap > -0.4 && dGap < 2.8 && r.y < 0.6) {
    if (s.span.phase !== 'extended') r.vz = 0;
  }

  // 2. jump the phantom floor
  const dPit = LEVEL.phantom.z0 - r.z;
  if (dPit < 1.7 && dPit > -0.6 && r.ground) jump(r);

  // 3. the lift: get on when it is down, wait on it while it rises, step off at the top
  if (r.z > L.z0 - 1.0 && r.z < L.z1 - 0.4) {
    if (r.onLift) {
      r.vz = 0;
      r.x *= 1 - Math.min(0.9, 6 * dt);
      if (liftTop(s) > L.up + 0.3 - 0.25) r.vz = TUNING.runSpeed;
    } else if (liftTop(s) > 0.4) {
      r.vz = 0; // wait for the Operator to bring it back down
    }
  }

  // 4. jump the catwalk gap (measured to the NEAR edge of the hole, not the far one)
  const nearEdge = LEVEL.catwalk.segs[0][1];
  const dCw = nearEdge - r.z;
  if (r.y > 3.5 && dCw < 1.2 && dCw > -0.8 && r.ground) jump(r);
}

function jump(r) {
  r.vy = TUNING.jumpV;
  r.ground = false;
  r.coyote = 0;
}

export function snapshotOf(s) {
  const c = JSON.parse(JSON.stringify(s));
  c.ghost = [];
  return c;
}
