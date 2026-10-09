// RELAY prototype — three private screens, one chain of communication.
import { LEVEL, gridLabel } from './level.js';
import * as SIM from './sim.js';
import * as R from './render.js';
import { createNet } from './net.js';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'net' ? 'net' : 'solo';
const role = params.get('role') || 'runner';
const room = params.get('room') || 'a';

const PHRASES = ['GO', 'WAIT', 'JUMP NOW', 'STOP', 'LEFT', 'RIGHT', 'THROW', 'ON ONE'];
const PHRASE_KEYS = ['1', '2', '3', '4', '5', '6', 'T', 'O'];
const CHALK_DIRS = ['right', 'up', 'down', 'left'];

export const state = SIM.createState();
const input = { left: false, right: false, jump: false };
let chalkDir = 'right';
let dotMenu = 0;
let banner = { text: '', t: -99 };
let toastMsg = '';
let toastUntil = 0;

const activeRoles = mode === 'solo' ? ['runner', 'operator', 'bridge'] : [role];
const panels = {};

// ---------------------------------------------------------------- DOM helper
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) e.append(kid);
  return e;
}
const canvas = (cls) => h('canvas', { class: cls });

// ------------------------------------------------------------------ transport
let net = null;
let hostLike = mode === 'solo';

function emit(ev) {
  if (mode === 'solo' || (net && net.isHost)) SIM.applyEvent(state, ev);
  else if (net) net.sendEvent(ev);
}

if (mode === 'net') {
  net = createNet(role, room, {
    onEvent: (ev) => {
      if (net.isHost) SIM.applyEvent(state, ev);
    },
    onSnapshot: (s) => SIM.adopt(state, s),
    onRemoteKey: (code, down) => applyKey(code, down),
    onHostChange: (isHost) => {
      toast(isHost ? 'You own the simulation' : 'Synced to host');
    },
  });
  hostLike = net.isHost;
}

function toast(msg) {
  toastMsg = msg;
  toastUntil = performance.now() + 2600;
  const t = document.querySelector('#toast');
  if (t) t.textContent = msg;
}

// --------------------------------------------------------------------- panels
function buildRunner() {
  const cam = canvas('cam');
  const feel = h('div', { class: 'feel' });
  const ticker = h('div', { class: 'ticker' });
  const feel2 = h('div', { class: 'sub-line' });
  const coach = h('div', { class: 'coach' });
  const bannerEl = h('div', { class: 'banner' });
  const root = h(
    'section',
    { class: 'panel runner' },
    h('header', {}, h('span', { class: 'badge blind' }, 'RUNNER'), h('b', {}, 'BLIND'), h('span', { class: 'sub' }, 'shapes only · no labels · no state · no map')),
    h('div', { class: 'stage' }, cam, h('div', { class: 'camlabel' }, "RUNNER'S VIEW"), feel),
    h('div', { class: 'ear' }, h('span', { class: 'lab' }, "EAR — the Bridge's voice (the only words you get)"), ticker, feel2),
    coach,
    h('div', { class: 'row keys' }, h('kbd', {}, 'A'), ' ', h('kbd', {}, 'D'), ' run  ·  ', h('kbd', {}, 'SPACE'), ' jump  ·  ', h('kbd', {}, 'P'), ' autopilot (demo)'),
    bannerEl,
  );
  return { root, refs: { cam, feel, ticker, feel2, coach, banner: bannerEl } };
}

function buildOperator() {
  const map = canvas('map');
  const ticker = h('div', { class: 'ticker' });
  const feed = h('div', { class: 'feed' });
  const coach = h('div', { class: 'coach' });
  const knocksEl = h('b', { class: 'knocks' }, '3');
  const leverBtn = h('button', { class: 'btn lever', onclick: () => emit({ type: 'span.throw' }) }, 'THROW SLIDE BRIDGE', h('kbd', {}, 'B'));
  const exitBtn = h('button', { class: 'btn lever', onclick: () => emit({ type: 'exit.lever' }) }, 'EXIT LEVER', h('kbd', {}, 'E'));
  const knockBtn = h('button', { class: 'btn lever', onclick: () => emit({ type: 'knock' }) }, 'KNOCK', h('kbd', {}, 'N'));
  const stampBtns = ['▲', '⧗', '✓'].map((ic, i) =>
    h('button', { class: 'btn stamp', dataset: { i: String(i) }, onclick: () => selectStamp(i) }, ic),
  );
  const root = h(
    'section',
    { class: 'panel operator' },
    h('header', {}, h('span', { class: 'badge mute' }, 'OPERATOR'), h('b', {}, 'MUTE'), h('span', { class: 'sub' }, 'you cannot speak · you cannot see the runner')),
    h('div', { class: 'stage' }, map, h('div', { class: 'camlabel' }, 'YOUR BOARD — click to stamp a location')),
    h('div', { class: 'row levers' }, leverBtn, exitBtn, knockBtn, knocksEl),
    h('div', { class: 'row stamps' }, h('span', { class: 'lab' }, 'STAMP:'), ...stampBtns, h('span', { class: 'hint' }, 'then click the board')),
    h('div', { class: 'ear' }, h('span', { class: 'lab' }, 'VOICE — the Bridge (you hear them, they cannot hear you)'), ticker),
    h('div', { class: 'row fxrow' }, feed),
    coach,
  );
  return { root, refs: { map, ticker, feed, coach, knocks: knocksEl, leverBtn, exitBtn, knockBtn, stampBtns } };
}

function buildBridge() {
  const cam = canvas('cam');
  const map = canvas('map small');
  const beatEl = h('div', { class: 'callnow' }, 'NEXT: —');
  const phraseRow = h('div', { class: 'row phrases' });
  const feed = h('div', { class: 'feed' });
  const inkEl = h('b', {}, '6');
  const coach = h('div', { class: 'coach' });
  const keyBar = h('i');
  const camlabel = h('div', { class: 'camlabel' }, "RUNNER'S CAM (what he sees)");
  const camStage = h('div', { class: 'stage' }, cam, camlabel);
  const mapStage = h('div', { class: 'stage small' }, map, h('div', { class: 'camlabel' }, "OPERATOR'S BOARD"));
  const phraseBtns = PHRASES.map((p, i) =>
    h('button', { class: 'btn phr', dataset: { i: String(i) }, onclick: () => emit({ type: 'phrase', text: p }) }, p, h('kbd', {}, PHRASE_KEYS[i])),
  );
  phraseRow.append(...phraseBtns);
  const chalkBtns = CHALK_DIRS.map((d) =>
    h('button', { class: 'btn dir', dataset: { dir: d }, onclick: () => { chalkDir = d; } }, d === 'up' ? '↑' : d === 'down' ? '↓' : d === 'right' ? '→' : '←'),
  );
  const keyBtn = h(
    'button',
    {
      class: 'btn keybtn',
      onpointerdown: () => emit({ type: 'key', down: true }),
      onpointerup: () => emit({ type: 'key', down: false }),
      onpointerleave: () => emit({ type: 'key', down: false }),
    },
    'HOLD 2nd KEY (two-man rule)',
    h('kbd', {}, 'K'),
  );
  const root = h(
    'section',
    { class: 'panel bridge' },
    h('header', {}, h('span', { class: 'badge deaf' }, 'BRIDGE'), h('b', {}, 'DEAF'), h('span', { class: 'sub' }, 'you hear nothing · you speak for everyone · you hold the key')),
    h('div', { class: 'split' }, camStage, mapStage),
    h('div', { class: 'row beat' }, beatEl),
    phraseRow,
    h('div', { class: 'row chalk' }, h('span', { class: 'lab' }, 'CHALK'), ...chalkBtns, h('span', {}, 'ink '), inkEl, h('span', { class: 'hint' }, 'click the cam to place · C cycle · V quick')),
    h('div', { class: 'row keyrow' }, keyBtn, h('div', { class: 'keybar' }, keyBar)),
    h('div', { class: 'row board' }, h('span', { class: 'lab' }, "OPERATOR'S STAMPS"), feed),
    coach,
  );
  return { root, refs: { cam, map, beat: beatEl, feed, ink: inkEl, coach, keyBar, phraseBtns, chalkBtns, keyBtn } };
}

const BUILDERS = { runner: buildRunner, operator: buildOperator, bridge: buildBridge };

function build() {
  const app = document.querySelector('#app');
  app.className = mode === 'solo' ? 'solo' : 'single';
  for (const r of activeRoles) {
    const p = BUILDERS[r]();
    panels[r] = p;
    app.append(p.root);
  }
  if (mode === 'solo') {
    app.prepend(
      h(
        'div',
        { class: 'demohead' },
        '1-PERSON DEMO — one screen, three private views. In real play each player only ever sees their own panel. The panels cannot talk to each other: only the Bridge\'s words and the Operator\'s stamps cross over.',
      ),
    );
  }
  const toastEl = h('div', { id: 'toast' });
  document.body.append(toastEl);
}

// ------------------------------------------------------------------- stamps
let stampIcon = '▲';
function selectStamp(i) {
  stampIcon = ['▲', '⧗', '✓'][i];
  for (const b of panels.operator?.refs.stampBtns || []) {
    b.classList.toggle('on', b.dataset.i === String(i));
  }
}

// --------------------------------------------------------------------- input
function applyKey(code, down) {
  const roles = activeRoles;
  const has = (r) => roles.includes(r);

  // movement keys are always accepted: whichever tab owns the sim must be able
  // to receive the Runner's input, even if the Runner's tab is not the host.
  switch (code) {
    case 'ArrowLeft':
    case 'KeyA':
      input.left = down;
      return;
    case 'ArrowRight':
    case 'KeyD':
      input.right = down;
      return;
    case 'Space':
    case 'KeyW':
      input.jump = down;
      return;
  }

  switch (code) {
    case 'KeyB':
      if (has('operator') && down) emit({ type: 'span.throw' });
      break;
    case 'KeyE':
      if (has('operator') && down) emit({ type: 'exit.lever' });
      break;
    case 'KeyN':
      if (has('operator') && down) emit({ type: 'knock' });
      break;
    case 'Digit7':
    case 'Digit8':
    case 'Digit9':
      if (has('operator') && down) selectStamp(Number(code.slice(5)) - 7);
      break;
    case 'Digit1':
    case 'Digit2':
    case 'Digit3':
    case 'Digit4':
    case 'Digit5':
    case 'Digit6':
      if (has('bridge') && down) emit({ type: 'phrase', text: PHRASES[Number(code.slice(5)) - 1] });
      break;
    case 'KeyT':
      if (has('bridge') && down) emit({ type: 'phrase', text: PHRASES[6] });
      break;
    case 'KeyO':
      if (has('bridge') && down) emit({ type: 'phrase', text: PHRASES[7] });
      break;
    case 'KeyK':
      if (has('bridge')) emit({ type: 'key', down });
      break;
    case 'KeyC':
      if (has('bridge') && down) {
        chalkDir = CHALK_DIRS[(CHALK_DIRS.indexOf(chalkDir) + 1) % CHALK_DIRS.length];
      }
      break;
    case 'KeyV':
      if (has('bridge') && down) emit({ type: 'chalk', x: state.runner.x + 3, y: 0, dir: chalkDir });
      break;
    case 'KeyP':
      if (down) emit({ type: 'auto', on: !state.runner.auto });
      break;
  }
}

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (['Space', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (mode === 'net' && !net.isHost && role === 'runner' && ['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'Space', 'KeyW'].includes(e.code)) {
    net.sendKey(e.code, true);
  }
  applyKey(e.code, true);
});
window.addEventListener('keyup', (e) => {
  if (mode === 'net' && !net.isHost && role === 'runner') net.sendKey(e.code, false);
  applyKey(e.code, false);
});

// -------------------------------------------------------------------- render
const domBuffers = {
  ticker: (s) => {
    const last = s.phrases[s.phrases.length - 1];
    if (!last) return '';
    const age = s.t - last.t;
    if (age > 2.5) return '';
    return last.text;
  },
  stamps: (s) => {
    const out = [];
    for (let i = s.stamps.length - 1; i >= 0 && out.length < 3; i--) {
      const st = s.stamps[i];
      const age = s.t - st.t;
      if (age > 6) continue;
      out.push(`${st.icon} ${gridLabel(st.x)}  (${age.toFixed(1)}s)`);
    }
    return out.reverse().join('   ');
  },
  fx: (s) => {
    const out = [];
    for (let i = s.fx.length - 1; i >= 0 && out.length < 2; i--) {
      const f = s.fx[i];
      if (s.t - f.t > 4) continue;
      out.push(f.text);
    }
    return out.reverse().join(' · ');
  },
};

function feelLine(s) {
  const r = s.runner;
  const hz = LEVEL.housing;
  if (r.x > hz.x - 1.5 && r.x < hz.x + hz.w + 2 && s.span.phase === 'out') {
    return 'FEEL: a slide-out span in the housing — RETRACTED.';
  }
  if (r.x > LEVEL.exit.x - 4 && !s.exit.open) return 'FEEL: a bolted slab. It will not move.';
  if (r.x > LEVEL.camo.x0 - 2 && r.x < LEVEL.camo.x0 && !s.dead) return 'FEEL: solid concrete underfoot.';
  return '';
}

function coachRunner() {
  const s = state;
  const r = s.runner;
  if (s.won) return 'CLEAR — you are through the door.';
  if (s.dead) return `You fell. Only shape is real to you; the floor at D4 was a lie. Last thing you were told: "${domBuffers.ticker(s) || '—'}".`;
  if (s.exit.open && r.x > LEVEL.exit.x - 6) return 'Run. The door is open.';
  if (!s.started) return 'Hold D / → to run. Everything you can see is shape only: no labels, no colours, no timer.';
  const d = LEVEL.gap.x0 - r.x;
  if (d > 0 && d < 7 && s.span.phase === 'out') return 'FEEL that dead span. Only the OPERATOR can throw it — say it out loud, only they can hear you.';
  if (r.x > 6 && r.x < 16 && s.span.phase !== 'out') return 'You can hear the span out. You cannot see if it is safe. Trust the call.';
  if (r.x > LEVEL.camo.x0 - 14 && r.x < LEVEL.camo.x0) return 'Underfoot: concrete, as far as you can feel. (You cannot tell. That is the whole point.)';
  if (r.x > LEVEL.exit.x - 6 && !s.exit.open) return 'The door is a slab. You cannot see whether it is armed. Wait for the Bridge.';
  return 'BLIND: no map, no labels, no door states. Everything you know comes from the Bridge.';
}

function coachOperator() {
  const s = state;
  const sp = s.span;
  if (s.won) return 'Clear.';
  if (sp.lockUntil > s.t) return `MOTOR OVERHEAT — locked out for ${(sp.lockUntil - s.t).toFixed(1)}s. Two throws inside 8 s.`;
  if (sp.phase === 'extended') return `SPAN IS OUT — auto-retracts in ${sp.timer.toFixed(1)}s.`;
  if (sp.phase === 'moving') return 'Span sliding…';
  if (s.exit.armed && !s.exit.open) return `EXIT ARMED — the Bridge must hold the 2nd key (${s.key.hold.toFixed(1)}/${SIM.TUNING.keyHoldTime}s).`;
  if (s.stats.throws === 0 && s.runner.x > 8) return 'You cannot see him. The BRIDGE is your only pair of eyes. Wait for the call.';
  if (s.knocks === 0) return 'No knocks left. Stamps only.';
  return 'You are MUTE. Stamps and KNOCKS are your voice — and lever timing is your handwriting.';
}

function coachBridge() {
  const s = state;
  const b = R.nextBeat(s);
  if (s.won) return 'Clear. Log the time.';
  if (s.dead) return 'He died. Replay is on the cam — was the last call stale?';
  if (!b) return 'DEAF: no audio, no voice from anyone. Your eyes are the runner cam and the Operator\'s board.';
  if (b.kind === 'span') return `SPAN (${b.label}): 0.7 s to slide out + the Operator's reaction. Call THROW ~1 s before he reaches the edge.`;
  if (b.kind === 'pit') return `PHANTOM FLOOR (${b.label}): he CANNOT see it. Say JUMP when he is ~${b.callLead.toFixed(1)} m out — his reaction costs ~0.3 s.`;
  return `TWO-KEY EXIT (${b.label}): the Operator arms it, you hold the 2nd key. He cannot see the door, so talk him through the wait.`;
}

function renderPanel(r, dt) {
  const p = panels[r];
  if (!p) return;
  const s = state;

  if (r === 'runner' || r === 'bridge') {
    const cv = r === 'runner' ? p.refs.cam : p.refs.cam;
    const { ctx, w, h, dpr } = R.setupCanvas(cv);
    const cam = R.makeCam(w, h, s, 30);
    p.refs.lastCam = cam;
    p.refs.dpr = dpr;
    R.drawWorld(ctx, s, cam, { vignette: true, ghost: r === 'bridge' });
  }
  if (r === 'operator' || r === 'bridge') {
    const cv = r === 'operator' ? p.refs.map : p.refs.map;
    const { ctx, w, h, dpr } = R.setupCanvas(cv);
    p.refs.lastMap = { w, h, dpr };
    R.drawSchematic(ctx, s, { noRunnerNote: r === 'operator' });
  }
}

function updateDom() {
  const s = state;
  const tick = domBuffers.ticker(s);
  const fx = domBuffers.fx(s);
  const toastEl = document.querySelector('#toast');
  if (toastEl) {
    toastEl.textContent = performance.now() < toastUntil ? toastMsg : '';
    toastEl.classList.toggle('on', performance.now() < toastUntil);
  }

  if (panels.runner) {
    const { refs } = panels.runner;
    refs.ticker.textContent = tick;
    refs.ticker.classList.toggle('hot', !!tick);
    refs.feel.textContent = feelLine(s);
    refs.feel2.textContent = fx;
    refs.coach.textContent = coachRunner();
    const b = s.won ? 'CLEAR ' + s.wonTime.toFixed(2) + 's' : s.dead ? 'YOU FELL — respawning' : '';
    refs.banner.textContent = b;
    refs.banner.className = 'banner ' + (s.won ? 'win' : s.dead ? 'die' : '');
  }
  if (panels.operator) {
    const { refs } = panels.operator;
    refs.ticker.textContent = tick;
    refs.ticker.classList.toggle('hot', !!tick);
    refs.feed.textContent = fx;
    refs.coach.textContent = coachOperator();
    refs.knocks.textContent = `knocks ${s.knocks}`;
    refs.leverBtn.disabled = s.span.lockUntil > s.t || s.span.phase !== 'out';
    refs.exitBtn.disabled = s.exit.open || s.exit.armed;
    refs.knockBtn.disabled = s.knocks <= 0;
  }
  if (panels.bridge) {
    const { refs } = panels.bridge;
    const b = R.nextBeat(s);
    if (b) {
      const now = b.call && b.kind !== 'exit';
      refs.beat.innerHTML = `<b>${b.label}</b> — ${b.dist.toFixed(1)} m / ${b.eta.toFixed(2)} s ${now ? '<span class="now">◀ CALL NOW</span>' : ''}<em>${b.why}</em>`;
      refs.beat.classList.toggle('call', now);
      refs.beat.classList.toggle('far', !now);
    } else {
      refs.beat.textContent = 'NEXT: —';
    }
    refs.feed.textContent = domBuffers.stamps(state) || 'no stamps yet';
    refs.ink.textContent = String(s.ink);
    refs.coach.textContent = coachBridge();
    refs.keyBar.style.width = Math.min(100, (s.key.hold / SIM.TUNING.keyHoldTime) * 100) + '%';
    refs.keyBtn.classList.toggle('ready', s.exit.armed && !s.exit.open);
    refs.keyBtn.classList.toggle('done', s.exit.open);
    for (const btn of refs.phraseBtns) btn.classList.toggle('cool', s.phraseCd > 0);
    for (const btn of refs.chalkBtns) btn.classList.toggle('on', btn.dataset.dir === chalkDir);
    const k = s.knockFx[s.knockFx.length - 1];
    const knockAge = k ? s.t - k.t : 99;
    refs.cam.parentElement.classList.toggle('knock', knockAge < 0.8);
  }
}

// ---------------------------------------------------------------------- loop
let last = performance.now();
let acc = 0;
let domAcc = 0;
const FIXED = 1 / 60;

function frame(now) {
  try {
    frameInner(now);
  } catch (err) {
    (window.__relayErrors ||= []).push(`frame: ${err && err.message}`);
  }
  requestAnimationFrame(frame);
}

function frameInner(now) {
  if (window.__relay) window.__relay.frames = (window.__relay.frames || 0) + 1;
  const dt = Math.min(0.2, (now - last) / 1000);
  last = now;

  for (const r of activeRoles) renderPanel(r, dt);

  domAcc += dt;
  if (domAcc > 0.08) {
    domAcc = 0;
    updateDom();
  }
}

// The simulation runs on a timer, NOT on requestAnimationFrame: browsers suspend
// rAF in background or occluded tabs, which would freeze the game for everybody
// else while the Runner's window is not the focused one.
let lastSim = performance.now();
function stepSim() {
  const now = performance.now();
  const dt = Math.min(1.5, (now - lastSim) / 1000); // hidden/throttled windows can tick ~1/s
  lastSim = now;
  if (window.__relay) window.__relay.simTicks = (window.__relay.simTicks || 0) + 1;

  const owns = mode === 'solo' || (net && net.isHost);
  if (owns) {
    acc += dt;
    let steps = 0;
    while (acc >= FIXED && steps < 90) {
      SIM.step(state, FIXED, input);
      acc -= FIXED;
      steps++;
    }
    if (state.dead || state.won) {
      const lastFx = state.fx[state.fx.length - 1];
      if (mode === 'solo' && lastFx && state.t - lastFx.t < 1.5 && lastFx.text !== toastMsg) toast(lastFx.text);
    }
  }

  if (mode === 'net' && net.isHost) {
    net.tick(dt, state, (s) => {
      const c = JSON.parse(JSON.stringify(s));
      c.ghost = [];
      return c;
    });
  }
}
setInterval(stepSim, 1000 / 60);

window.addEventListener('error', (e) => {
  (window.__relayErrors ||= []).push(`${e.message} @${e.lineno}:${e.colno}`);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && mode === 'net') {
    toast('This window is hidden — browsers throttle hidden windows. Keep all three visible.');
  }
});

build();
selectStamp(0);
// place the chalk from a click on the runner's cam
if (panels.bridge) {
  panels.bridge.refs.cam.addEventListener('click', (e) => {
    const cam = panels.bridge.refs.lastCam;
    const dpr = panels.bridge.refs.dpr || 1;
    const rect = e.target.getBoundingClientRect();
    const px = (e.clientX - rect.left) * ((e.target.width) / rect.width);
    const py = (e.clientY - rect.top) * ((e.target.height) / rect.height);
    const wpt = cam.toWorld(px, py);
    emit({ type: 'chalk', x: wpt.x, y: Math.max(0, Math.round(wpt.y * 2) / 2), dir: chalkDir });
  });
}
if (panels.operator) {
  panels.operator.refs.map.addEventListener('click', (e) => {
    const cv = panels.operator.refs.map;
    const rect = e.target.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (cv.width / rect.width);
    const pad = 14;
    const x0 = -5;
    const x1 = LEVEL.endX + 2;
    const scale = (cv.width - pad * 2) / (x1 - x0);
    const wx = x0 + (px - pad) / scale;
    emit({ type: 'stamp', icon: stampIcon, x: wx });
  });
}

// expose for the console / automated tests
window.__relay = { state, SIM, emit, R, LEVEL, panels, input, net, mode, role, activeRoles };
requestAnimationFrame(frame);
