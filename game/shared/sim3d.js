// RELAY 3D — authoritative simulation. Deterministic, no three.js, no DOM.
// Runs identically in Node (server) and in the browser (prediction).
import { LEVEL, hallTiles, spanX, laneX } from './level3d.js';

export const TUNING = {
  runSpeed: 6.6,
  braceSpeed: 3.0, // S: the only way to slow down, and only for braceTime per section
  braceTime: 1.2,
  strafeSpeed: 4.6,
  accel: 45,
  strafeAccel: 40,
  friction: 55,
  gravity: 42,
  jumpV: 14.6,
  coyote: 0.1,
  jumpBuffer: 0.12,
  radius: 0.36,
  height: 1.7,
  eye: 1.55,

  spanTravel: 0.7,
  spanHold: 1.2,
  spanRetract: 0.5,
  motorWindow: 8.0,
  motorMax: 2,
  motorLock: 6.0,

  pressRise: 0.3,
  pressSlam: 0.15,
  pressMaxHold: 1.2,
  pressLock: 2.0,

  liftTravel: 1.6,
  keyHoldTime: 1.5,
  armWindow: 3.0, // an armed exit that nobody turns the key on disarms itself
  doorSlide: 0.9,
  doorStay: 2.5, // once open, the seal holds this long and then slams shut

  respawnDelay: 1.0,
  phraseCd: 1.2,
  chalkInk: 6,
  knocks: 3,
  // retained for older callers; the start line is a station now
  startZ: 2.01,
};

const EPS = 1e-4;
const LEDGE = 0.15; // how far below a top surface the feet may be and still land on it

// ------------------------------------------------------------------ layout
// mulberry32 on s.seed: the same seed rolls the same layout on server and client
function rand(s) {
  let t = (s.seed = (s.seed + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export function rollLayout(s) {
  const spanLane = Math.floor(rand(s) * 3);
  // one safe lane per hall segment; neighbours at most one lane apart (he has ~0.9 s per
  // segment), and never the same lane three times (a Runner who just runs straight dies)
  let hall;
  for (let i = 0; i < 50; i++) {
    hall = [Math.floor(rand(s) * 3)];
    for (let k = 1; k < LEVEL.hall.segs; k++) {
      const step = Math.floor(rand(s) * 3) - 1;
      hall.push(Math.max(0, Math.min(2, hall[k - 1] + step)));
    }
    if (!hall.every((l) => l === hall[0])) break;
  }
  return { spanLane, hall };
}

export function createState(seed) {
  const st0 = LEVEL.stations[0];
  const s = {
    t: 0,
    seed: (seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0,
    attempt: 0,
    started: false,
    startTime: 0,
    dead: false,
    deathCause: '',
    respawnIn: 0,
    deaths: 0,
    won: false,
    wonTime: 0,
    section: 0,
    checkpoint: { z: st0.z, y: st0.y },
    layout: null,
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
      committed: false,
      brace: TUNING.braceTime,
    },
    input: { yaw: 0, f: 0, s: 0, jump: false },

    span: { phase: 'out', timer: 0, throws: [], lockUntil: 0 },
    press: { phase: 'down', y: 0, timer: 0, held: false, holdT: 0, lockUntil: 0 },
    lift: { y: LEVEL.lift.down, target: LEVEL.lift.down, moving: false },
    exit: { phase: 'shut', armed: false, armT: 0, open: 0, stay: 0 },
    key: { held: false, hold: 0 },
    collapse: { active: false, z: LEVEL.collapse.z0, wait: 0 },

    ink: TUNING.chalkInk,
    knocks: TUNING.knocks,
    phraseCd: 0,

    chalk: [],
    phrases: [],
    stamps: [],
    knockFx: [],
    fx: [],
    players: {},

    stats: { phrases: 0, chalk: 0, knocks: 0, throws: 0, lifts: 0, presses: 0 },
  };
  s.layout = rollLayout(s);
  return s;
}

// ---------------------------------------------------------------- collisions
const box = (x0, x1, y0, y1, z0, z1, kind) => ({ x0, x1, y0, y1, z0, z1, kind });

export function spanExtent(s) {
  const sp = s.span;
  if (sp.phase === 'moving') return 1 - Math.max(0, sp.timer) / TUNING.spanTravel;
  if (sp.phase === 'extended') return 1;
  if (sp.phase === 'retracting') return Math.max(0, sp.timer) / TUNING.spanRetract;
  return 0;
}

export function pressBox(s) {
  const P = LEVEL.press;
  return box(P.x0, P.x1, s.press.y, s.press.y + P.h, P.z0, P.z1, 'press');
}

export function catwalkRuns(s) {
  const C = LEVEL.catwalk;
  const front = s.collapse.active ? s.collapse.z : -Infinity;
  const out = [];
  for (const [z0, z1] of C.segs) {
    const a = Math.max(z0, front);
    if (a < z1) out.push(box(C.x0, C.x1, C.y - 0.3, C.y, a, z1, 'catwalk'));
  }
  return out;
}

export function solidsOf(s) {
  const out = [];
  for (const b of LEVEL.boxes) if (b.kind !== 'deco') out.push(b);
  // the slide bridge, on the side it was rolled on
  const ext = spanExtent(s);
  if (ext > 0) {
    const sp = LEVEL.span;
    const [x0, x1] = spanX(s.layout);
    out.push(box(x0, x1, sp.y, sp.y + sp.h, sp.z0, sp.z0 + (sp.z1 - sp.z0) * ext, 'span'));
  }
  // the hall: only the true tiles have colliders
  for (const t of hallTiles(s.layout)) if (!t.fake) out.push(box(t.x0, t.x1, t.y0, t.y1, t.z0, t.z1, 'tile'));
  // the press is solid only while it is fully up (a ceiling to bonk); moving, it crushes
  if (s.press.phase === 'up') out.push(pressBox(s));
  const L = LEVEL.lift;
  out.push(box(L.x0, L.x1, s.lift.y, s.lift.y + 0.35, L.z0, L.z1, 'lift'));
  out.push(...catwalkRuns(s));
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
    case 'press': {
      const p = s.press;
      if (ev.down) {
        p.held = true;
        if (p.lockUntil > now) return fx(s, 'PRESS LOCKED', 'bad');
        if (p.phase === 'down') {
          p.phase = 'rising';
          p.timer = TUNING.pressRise;
          s.stats.presses++;
        }
      } else {
        p.held = false;
        if (p.phase === 'rising' || p.phase === 'up') slam(s);
      }
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
      if (s.exit.phase !== 'shut') return;
      s.exit.armed = !s.exit.armed;
      s.exit.armT = 0;
      fx(s, s.exit.armed ? 'EXIT ARMED — the key, within 3 s' : 'EXIT DISARMED', s.exit.armed ? 'ok' : 'muted');
      return;
    }
    case 'key': {
      s.key.held = !!ev.down;
      if (!ev.down && s.exit.phase === 'shut') s.key.hold = 0;
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
      const dir = ['forward', 'left', 'right', 'down'].includes(ev.dir) ? ev.dir : 'forward';
      s.chalk.push({ x: num(ev.x, -4, 4), y: num(ev.y, -1, 8), z: num(ev.z, -6, 90), dir });
      return;
    }
    case 'stamp': {
      s.stamps.push({ icon: String(ev.icon || '?').slice(0, 2), x: num(ev.x, -4, 4), z: num(ev.z, -6, 90), t: now });
      if (s.stamps.length > 12) s.stamps.shift();
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
      resetState(s);
      return;
    }
  }
}

// a new run with a fresh roll; `seed` keeps the dice going between runs
export function resetState(s) {
  const seed = s.seed;
  for (const k of Object.keys(s)) delete s[k];
  Object.assign(s, createState(seed));
}

function num(v, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0;
}

function fx(s, text, kind) {
  s.fx.push({ text, t: s.t, kind: kind || 'muted' });
  if (s.fx.length > 40) s.fx.shift();
}

function slam(s) {
  s.press.phase = 'slamming';
  s.press.timer = TUNING.pressSlam * (s.press.y / LEVEL.press.upY);
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

  // --- press: rises while held, overheats after 1.5 s, slams when let go
  const p = s.press;
  const P = LEVEL.press;
  if (p.phase === 'rising') {
    p.timer -= dt;
    p.y = P.upY * Math.min(1, 1 - p.timer / TUNING.pressRise);
    if (p.timer <= 0) {
      p.phase = 'up';
      p.y = P.upY;
      p.holdT = 0;
    }
  } else if (p.phase === 'up') {
    p.holdT += dt;
    if (!p.held) slam(s);
    else if (p.holdT >= TUNING.pressMaxHold) {
      slam(s);
      p.lockUntil = s.t + TUNING.pressLock;
      fx(s, 'PRESS OVERHEAT — slammed, locked 2 s', 'warn');
    }
  } else if (p.phase === 'slamming') {
    p.timer -= dt;
    p.y = Math.max(0, P.upY * (p.timer / TUNING.pressSlam));
    if (p.timer <= 0) {
      p.phase = 'down';
      p.y = 0;
    }
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

  // --- two-key exit: arm (expires), key 1.5 s, slide open, hold 2.5 s, slam shut
  const ex = s.exit;
  if (ex.phase === 'shut') {
    if (ex.armed && s.key.held) {
      s.key.hold += dt;
      if (s.key.hold >= TUNING.keyHoldTime) {
        ex.phase = 'opening';
        fx(s, 'EXIT OPEN — 2.5 s seal', 'ok');
      }
    } else if (ex.armed) {
      ex.armT += dt;
      if (ex.armT >= TUNING.armWindow) {
        ex.armed = false;
        fx(s, 'ARM EXPIRED — no key in 3 s', 'warn');
      }
    }
  } else if (ex.phase === 'opening') {
    ex.open = Math.min(1, ex.open + dt / TUNING.doorSlide);
    if (ex.open >= 1) {
      ex.phase = 'open';
      ex.stay = TUNING.doorStay;
    }
  } else if (ex.phase === 'open') {
    ex.stay -= dt;
    if (ex.stay <= 0) {
      ex.phase = 'closing';
      ex.armed = false;
      fx(s, 'EXIT SEALING', 'warn');
    }
  } else if (ex.phase === 'closing') {
    ex.open = Math.max(0, ex.open - dt / TUNING.doorSlide);
    if (ex.open <= 0) {
      ex.phase = 'shut';
      s.key.hold = 0;
    }
  }

  // --- the catwalk falls away behind him
  const C = LEVEL.collapse;
  if (s.collapse.active) {
    if (s.collapse.wait > 0) s.collapse.wait -= dt;
    else s.collapse.z = Math.min(C.end, s.collapse.z + C.speed * dt);
  }

  // --- movement: forced momentum. At a station he stands still until he commits (W);
  // committed, he runs at runSpeed and only steers, jumps, or braces (S) for a moment.
  const want = r.auto ? autopilot(s) : s.input;
  const T = TUNING;
  r.yaw = r.auto ? 0 : Math.max(-1.2, Math.min(1.2, Number(want.yaw) || 0));
  if (!r.committed && (want.f || 0) > 0.5 && r.ground) commit(s);

  let target = 0;
  if (r.committed) {
    target = T.runSpeed;
    if ((want.f || 0) < -0.5 && r.brace > 0) {
      target = T.braceSpeed;
      r.brace = Math.max(0, r.brace - dt);
    }
  }
  const dv = target - r.vz;
  const rate = (target >= r.vz ? T.accel : T.friction) * dt;
  r.vz += Math.max(-rate, Math.min(rate, dv));

  const st = Math.max(-1, Math.min(1, Number(want.s) || 0));
  const tvx = -st * T.strafeSpeed; // 'D' (s = +1) moves screen-right, which is -X
  const dvx = tvx - r.vx;
  const rx = (st !== 0 ? T.strafeAccel : T.friction) * dt;
  r.vx += Math.max(-rx, Math.min(rx, dvx));

  if (r.committed && want.jump) r.buffer = T.jumpBuffer;
  r.buffer = Math.max(0, r.buffer - dt);
  r.coyote = Math.max(0, r.coyote - dt);
  if (r.buffer > 0 && r.coyote > 0) {
    r.vy = T.jumpV;
    r.buffer = 0;
    r.coyote = 0;
    r.ground = false;
  }

  // --- integrate + collide, axis by axis
  const solids = solidsOf(s);

  // Y. A surface only catches the Runner if his feet were above it last frame (with a
  // small ledge allowance), and only bumps his head if he was below it. A solid that
  // moved INTO him (a span sliding out under a Runner who is already falling) does not
  // teleport him onto its top: he stays embedded and falls out.
  r.vy -= T.gravity * dt;
  if (r.vy < -45) r.vy = -45;
  const prevY = r.y;
  r.y += r.vy * dt;
  r.ground = false;
  r.onLift = false;
  let a = aabbOf(r);
  for (const c of solids) {
    if (!hit(a, c)) continue;
    if (r.vy <= 0 && prevY >= c.y1 - LEDGE) {
      r.y = c.y1;
      r.vy = 0;
      r.ground = true;
      a = aabbOf(r);
    } else if (r.vy > 0 && prevY + T.height <= c.y0 + LEDGE) {
      r.y = c.y0 - T.height;
      r.vy = 0;
      a = aabbOf(r);
    }
  }
  // riding the lift deck: a proximity + support test (the deck sits flush with the floor)
  {
    const L = LEVEL.lift;
    const top = liftTop(s);
    const pad = T.radius * 0.6;
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
  if (r.ground) r.coyote = T.coyote;

  // X (solids he was already embedded in before this move are left alone, see Y)
  let before = aabbOf(r);
  r.x += r.vx * dt;
  a = aabbOf(r);
  for (const c of solids) {
    if (!hit(a, c) || hit(before, c)) continue;
    if (r.vx > 0) r.x = c.x0 - T.radius - EPS;
    else if (r.vx < 0) r.x = c.x1 + T.radius + EPS;
    r.vx = 0;
    a = aabbOf(r);
  }

  // Z
  before = aabbOf(r);
  r.z += r.vz * dt;
  a = aabbOf(r);
  for (const c of solids) {
    if (!hit(a, c) || hit(before, c)) continue;
    if (r.vz > 0) r.z = c.z0 - T.radius - EPS;
    else if (r.vz < 0) r.z = c.z1 + T.radius + EPS;
    r.vz = 0;
    a = aabbOf(r);
  }

  const wx = LEVEL.corridor.wallX - T.radius;
  if (r.x < -wx) r.x = -wx;
  if (r.x > wx) r.x = wx;

  // --- stations: a committed Runner who reaches the next one is braked to a stand
  for (let i = s.section + 1; i < LEVEL.stations.length; i++) {
    const stn = LEVEL.stations[i];
    if (r.committed && r.ground && r.z >= stn.z && r.z < stn.z + 3 && r.y >= stn.y - 0.3) {
      r.vz = 0;
      r.committed = false;
      r.brace = T.braceTime;
      s.section = i;
      s.checkpoint = { z: stn.z, y: stn.y };
      fx(s, `STATION ${i + 1} — ${stn.name}`, 'ok');
      break;
    }
  }

  // --- hazards
  if (s.press.phase !== 'up' && hit(aabbOf(r), pressBox(s))) die(s, 'crushed');
  else if (r.y + T.height < LEVEL.killY) die(s, 'fell');
  if (!s.dead && r.z > LEVEL.win.z && r.y > LEVEL.win.y) {
    s.won = true;
    s.wonTime = s.t - s.startTime;
  }

  s.ghost.push({ x: r.x, y: r.y, z: r.z, t: s.t });
  while (s.ghost.length && s.t - s.ghost[0].t > 6) s.ghost.shift();

  s.t += dt;
}

function commit(s) {
  const r = s.runner;
  r.committed = true;
  if (!s.started) {
    s.started = true;
    s.startTime = s.t;
  }
  if (s.section === 3) {
    s.collapse.active = true;
    s.collapse.z = LEVEL.collapse.z0;
    s.collapse.wait = LEVEL.collapse.delay;
  }
}

function die(s, cause) {
  if (s.dead) return;
  s.dead = true;
  s.deathCause = cause;
  s.deaths++;
  s.respawnIn = TUNING.respawnDelay;
}

// back to the last station, with a fresh roll of the dice: memorising a layout is useless
function respawn(s) {
  const stn = LEVEL.stations[s.section];
  const r = s.runner;
  s.dead = false;
  Object.assign(r, { x: 0, y: stn.y, z: stn.z, vx: 0, vy: 0, vz: 0, ground: true, onLift: false, buffer: 0, coyote: 0, committed: false, brace: TUNING.braceTime });
  s.span.phase = 'out';
  s.span.timer = 0;
  Object.assign(s.press, { phase: 'down', y: 0, timer: 0, holdT: 0 });
  const up = s.section >= 3;
  s.lift = { y: up ? LEVEL.lift.up : LEVEL.lift.down, target: up ? LEVEL.lift.up : LEVEL.lift.down, moving: false };
  s.exit = { phase: 'shut', armed: false, armT: 0, open: 0, stay: 0 };
  s.key.hold = 0;
  s.collapse = { active: false, z: LEVEL.collapse.z0, wait: 0 };
  s.chalk = [];
  s.stamps = [];
  s.ink = TUNING.chalkInk;
  s.knocks = TUNING.knocks;
  s.attempt++;
  s.layout = rollLayout(s);
  s.ghost = [];
  fx(s, 'THE GANTRY RECONFIGURES', 'warn');
}

// Demo autopilot (debug servers only): steers by the layout, which a human Runner cannot
// see. It commits when it is lined up; the other two roles still have to do their jobs.
function autopilot(s) {
  const r = s.runner;
  const want = { yaw: 0, f: 0, s: 0, jump: false };
  let tx = 0;
  const H = LEVEL.hall;
  if (s.section === 0) {
    tx = laneX(s.layout.spanLane);
  } else if (s.section === 1) {
    const seg = Math.max(0, Math.min(H.segs - 1, Math.floor((r.z + 2.2 - H.z0) / H.segLen)));
    tx = r.z < H.z1 - 0.5 ? laneX(s.layout.hall[seg]) : 0;
  }
  want.s = Math.max(-1, Math.min(1, (r.x - tx) * 2.5));
  if (Math.abs(r.x - tx) < 0.5 && !r.committed) want.f = 1;
  const edge = LEVEL.catwalk.segs[0][1];
  if (r.y > 3.5 && edge - r.z < 1.1 && edge - r.z > -0.3 && r.ground) want.jump = true;
  return want;
}

// What goes over the wire 30 times a second. The event logs are trimmed to what a client
// can still show (recent phrases / fx / stamps / knocks); the server-only fields are dropped.
export function snapshotOf(s) {
  const recent = (list, n, age) => list.filter((x) => s.t - x.t < age).slice(-n);
  return {
    ...s,
    ghost: [],
    players: {},
    span: { phase: s.span.phase, timer: s.span.timer, lockUntil: s.span.lockUntil },
    press: { ...s.press },
    exit: { ...s.exit },
    collapse: { ...s.collapse },
    layout: { spanLane: s.layout.spanLane, hall: [...s.layout.hall] },
    phrases: s.phrases.slice(-2),
    fx: recent(s.fx, 6, 4),
    stamps: s.stamps.slice(-8),
    knockFx: s.knockFx.slice(-1),
    runner: { ...s.runner },
    input: { ...s.input },
  };
}
