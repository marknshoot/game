// RELAY 3D — the three private screens. One canvas, up to two viewports, and a
// HUD per role. The Runner's cam and the Operator's board are separate layers of
// the same scene, so neither role *can* see the other's information.
import * as THREE from '../vendor/three.module.js';
import { LEVEL } from '../../shared/level3d.js';
import * as SIM from '../../shared/sim3d.js';
import { createWorld, LAYER } from './world.js';
import { createNet } from './net.js';
import { createAudio } from './audio.js';

const P = new URLSearchParams(location.search);
const ROLE = ['runner', 'operator', 'bridge'].includes(P.get('role')) ? P.get('role') : 'runner';
const ROOM = (P.get('room') || 'A').toUpperCase();
const NAME = P.get('name') || '';

// The Bridge is deaf by rule: createAudio('bridge') is a hard-muted no-op.
const audio = createAudio(ROLE);

const PHRASES = ['GO', 'WAIT', 'JUMP NOW', 'STOP', 'LEFT', 'RIGHT', 'THROW', 'ON ONE'];
const PHRASE_KEYS = ['1', '2', '3', '4', '5', '6', 'T', 'O'];
const CHALK_DIRS = ['forward', 'left', 'right', 'down'];
const SONAR_CD = 3.5;

const h = (tag, props = {}, ...kids) => {
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
};
const kbd = (t) => h('kbd', {}, t);

// ---------------------------------------------------------------- net + state
let remote = SIM.createState();
let local = SIM.createState(); // prediction copy (Runner only)
let sidebarRtt = 0;
const clientGhost = [];
let peers = [];
let status = 'connecting';

addEventListener('error', (e) => (window.__relay3d?.errors || []).push(`${e.message} @${e.lineno}:${e.colno}`));
const canvas = document.createElement('canvas');
canvas.id = 'view';
const world = createWorld(canvas);

const net = createNet({
  room: ROOM,
  role: ROLE,
  name: NAME,
  onWelcome: (m) => {
    remote = m.snapshot;
    if (ROLE === 'runner') Object.assign(local, m.snapshot);
    status = 'playing';
  },
  onSnapshot: (s) => {
    if (ROLE === 'runner') predict.adopt(s);
    else remote = s;
  },
  onPlayers: (p) => {
    peers = p;
    renderPeers();
  },
  onError: (m) => {
    if (m.code === 'role_taken') {
      document.body.innerHTML = `<div class="takeover"><h1>${m.role} is already taken in room ${ROOM}</h1>
      <p>${m.players.map((p) => `${p.role}: ${p.name}`).join(' · ') || ''}</p>
      <p><a href="index.html">back to the lobby</a></p></div>`;
    }
  },
  onSay: (m) => {
    if (ROLE === 'operator') {
      pushVoiceShot(m.from, m.text);
      audio.say(m.text, 'runner'); // the Runner's shout reaches the Operator's ears
    }
  },
  onStatus: (s) => {
    status = s;
    const el = document.querySelector('#netstat');
    if (el) el.textContent = s === 'connected' ? `${ROOM} · ${ROLE}` : s;
  },
});

// ---------------------------------------------------- prediction for the Runner
const predict = {
  correct: 0,
  adopt(snap) {
    // copy everything that is server-owned, keep the locally predicted body
    const keep = { ...local.runner };
    const next = JSON.parse(JSON.stringify(snap));
    delete next.runner;
    Object.assign(local, next, { runner: keep });
    const r = snap.runner;
    const l = local.runner;
    const err = Math.hypot(r.x - l.x, r.y - l.y, r.z - l.z);
    if (err > 2.5 || r.dead !== l.dead) {
      local.runner = { ...r };
      predict.correct++;
    } else {
      l.x += (r.x - l.x) * 0.22;
      l.y += (r.y - l.y) * 0.3;
      l.z += (r.z - l.z) * 0.22;
      l.ground = r.ground;
      l.onLift = r.onLift;
      l.dead = r.dead;
      l.vx += (r.vx - l.vx) * 0.2;
      l.vz += (r.vz - l.vz) * 0.2;
    }
  },
};

// --------------------------------------------------------------------- input
const keys = new Set();
const input = { f: 0, s: 0, jump: false, yaw: 0 };
let pitch = -0.06;
let chalkDir = 'forward';
let stampIcon = '▲';
let autopilot = false;

function bindInput() {
  // browsers only allow audio after a gesture: unlock on the first one
  const unlockAudio = () => audio.unlock();
  addEventListener('pointerdown', unlockAudio, { once: true });
  addEventListener('keydown', unlockAudio, { once: true });

  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
    onKeyDown(e.code);
  });
  addEventListener('keyup', (e) => {
    keys.delete(e.code);
    if (e.code === 'KeyK') net.sendEvent({ type: 'key', down: false });
  });
  canvas.addEventListener('click', (e) => {
    if (ROLE === 'runner') canvas.requestPointerLock?.();
  });
  addEventListener('mousemove', (e) => {
    if (ROLE !== 'runner') return;
    if (document.pointerLockElement !== canvas) return;
    input.yaw -= e.movementX * 0.0022; // mouse right turns the view right (-X)
    pitch = Math.max(-1.0, Math.min(0.9, pitch - e.movementY * 0.0022));
  });
}

function onKeyDown(code) {
  if (ROLE === 'runner' && code === 'KeyQ') {
    fireSonar();
    return;
  }
  if (code === 'KeyP') {
    autopilot = !autopilot;
    net.sendEvent({ type: 'auto', on: autopilot });
    toast(autopilot ? 'autopilot on (demo helper)' : 'autopilot off');
    return;
  }
  if (ROLE === 'operator') {
    if (code === 'KeyB') net.sendEvent({ type: 'span.throw' });
    if (code === 'KeyF') net.sendEvent({ type: 'lift.toggle' });
    if (code === 'KeyE') net.sendEvent({ type: 'exit.lever' });
    if (code === 'KeyN') knock();
    if (code === 'Digit7') selectStamp(0);
    if (code === 'Digit8') selectStamp(1);
    if (code === 'Digit9') selectStamp(2);
  }
  if (ROLE === 'bridge') {
    const i = '123456'.indexOf(code.replace('Digit', ''));
    if (i >= 0) sendPhrase(PHRASES[i]);
    if (code === 'KeyT') sendPhrase(PHRASES[6]);
    if (code === 'KeyO') sendPhrase(PHRASES[7]);
    if (code === 'KeyK') net.sendEvent({ type: 'key', down: true });
    if (code === 'KeyC') {
      chalkDir = CHALK_DIRS[(CHALK_DIRS.indexOf(chalkDir) + 1) % CHALK_DIRS.length];
      paintChalkButtons();
    }
    if (code === 'KeyV') quickChalk();
  }
}

function knock() {
  net.sendEvent({ type: 'knock' });
}
function sendPhrase(text) {
  net.sendEvent({ type: 'phrase', text });
  updatePhraseCd();
}
function fireSonar() {
  if (ROLE !== 'runner' || sonarCd > 0 || local.dead || local.won) return;
  const r = local.runner;
  world.triggerSonar(r.x, r.y + 0.9, r.z);
  audio.sonar();
  sonarCd = SONAR_CD;
}
function quickChalk() {
  const r = stateOf().runner;
  const dx = Math.sin(input.yaw) * 2.6;
  const dz = Math.cos(input.yaw) * 2.6;
  net.sendEvent({
    type: 'chalk',
    x: Math.max(-3.4, Math.min(3.4, r.x + dx)),
    y: 0,
    z: Math.max(0.5, Math.min(68, r.z + dz)),
    dir: chalkDir,
  });
}

// ------------------------------------------------------------------ HUD build
function build() {
  const app = document.querySelector('#app');
  app.className = `role-${ROLE}`;
  const stage = h('div', { class: 'stage' }, canvas);
  const camRegion = h('div', { class: 'region cam-region', dataset: { view: 'cam' } });
  const boardRegion = h('div', { class: 'region board-region', dataset: { view: 'board' } });
  stage.append(camRegion, boardRegion);
  app.append(stage);

  // --- always-on chrome
  stage.append(
    h(
      'div',
      { class: 'chrome' },
      h('span', { id: 'netstat', class: 'netstat' }, 'connecting…'),
      h('span', { class: 'peers', id: 'peers' }),
      h('a', { class: 'lobby', href: 'index.html' }, 'lobby'),
    ),
  );

  if (ROLE === 'runner') {
    const ear = h('div', { class: 'ear' });
    const feel = h('div', { class: 'feel' });
    const coach = h('div', { class: 'coach' });
    const banner = h('div', { class: 'banner' });
    const lock = h('div', { class: 'lock' }, 'click to look around · WASD move · SPACE jump · Q sonar · sound on');
    const vigDeath = h('div', { class: 'vignette vignette-death' });
    const vigWin = h('div', { class: 'vignette vignette-win' });
    const sonarEl = h('div', { class: 'sonar ready' }, '[Q] SONAR');
    const shoutInput = h('input', { class: 'shout', placeholder: 'shout (only the Operator hears you)  ⏎' });
    shoutInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && shoutInput.value.trim()) {
        net.say(shoutInput.value.trim());
        pushVoiceShot('you', shoutInput.value.trim(), true);
        shoutInput.value = '';
      }
      e.stopPropagation();
    });
    camRegion.append(
      vigDeath,
      vigWin,
      h('div', { class: 'crosshair' }),
      ear,
      feel,
      banner,
      lock,
      h('div', { class: 'shoutrow' }, shoutInput),
      coach,
      sonarEl,
    );
    hud.runner = { ear, feel, coach, banner, lock, sonar: sonarEl, vigDeath, vigWin, shout: pushVoiceShot, selfShots: h('div', { class: 'selfshots' }) };
    camRegion.append(hud.runner.selfShots);
    setTimeout(() => lock.classList.add('fade'), 6000);
  }

  if (ROLE === 'operator') {
    const voice = h('div', { class: 'voice' });
    const shots = h('div', { class: 'shots' });
    const feed = h('div', { class: 'feed' });
    const coach = h('div', { class: 'coach' });
    boardRegion.append(h('div', { class: 'boardlabel' }, 'YOUR BOARD — state, hazards, timings. No runner.'), coach);
    const side = h(
      'aside',
      { class: 'side' },
      h('h2', {}, 'CONTROL'),
      h('button', { class: 'btn big', onclick: () => net.sendEvent({ type: 'span.throw' }) }, 'THROW SLIDE BRIDGE', kbd('B')),
      h('button', { class: 'btn big', onclick: () => net.sendEvent({ type: 'lift.toggle' }) }, 'LIFT UP / DOWN', kbd('F')),
      h('button', { class: 'btn big', onclick: () => net.sendEvent({ type: 'exit.lever' }) }, 'EXIT LEVER', kbd('E')),
      h('button', { class: 'btn big', onclick: knock }, 'KNOCK', kbd('N'), h('b', { class: 'knocks' }, '3')),
      h('h2', {}, 'STAMP'),
      h(
        'div',
        { class: 'row' },
        ...['▲', '⧗', '✓'].map((ic, i) => h('button', { class: 'btn stamp', dataset: { i: String(i) }, onclick: () => selectStamp(i) }, ic)),
      ),
      h('p', { class: 'hint' }, 'then click your board to drop it in front of the Bridge'),
      h('h2', {}, 'VOICE — the Bridge (you hear them)'),
      voice,
      h('h2', {}, 'EAR — the Runner (you hear them; you cannot answer)'),
      shots,
      h('h2', {}, 'SYSTEM'),
      feed,
      h('label', { class: 'auto' }, h('input', { type: 'checkbox', onchange: (e) => net.sendEvent({ type: 'auto', on: e.target.checked }) }), ' autopilot (demo)'),
    );
    app.append(side);
    hud.operator = { voice, shots, feed, coach, side };
  }

  if (ROLE === 'bridge') {
    const beat = h('div', { class: 'callnow' }, 'NEXT: —');
    const earSide = h('div', { class: 'feed' });
    const coach = h('div', { class: 'coach' });
    const ink = h('b', {}, '6');
    const keyBar = h('i');
    const keyBtn = h(
      'button',
      {
        class: 'btn big keybtn',
        onpointerdown: () => net.sendEvent({ type: 'key', down: true }),
        onpointerup: () => net.sendEvent({ type: 'key', down: false }),
        onpointerleave: () => net.sendEvent({ type: 'key', down: false }),
      },
      'HOLD 2nd KEY',
      kbd('K'),
    );
    const phraseRow = h('div', { class: 'row' });
    PHRASES.forEach((p, i) => phraseRow.append(h('button', { class: 'btn phr', onclick: () => sendPhrase(p) }, p, kbd(PHRASE_KEYS[i]))));
    const chalkRow = h('div', { class: 'row' });
    CHALK_DIRS.forEach((d) =>
      chalkRow.append(
        h(
          'button',
          {
            class: 'btn dir',
            dataset: { dir: d },
            onclick: () => {
              chalkDir = d;
              paintChalkButtons();
            },
          },
          d === 'forward' ? '↑' : d === 'down' ? '↓' : d === 'left' ? '←' : '→',
        ),
      ),
    );
    earSide.classList.add('stampfeed');
    const vigDeath = h('div', { class: 'vignette vignette-death' });
    const vigWin = h('div', { class: 'vignette vignette-win' });
    camRegion.append(vigDeath, vigWin, h('div', { class: 'boardlabel' }, "RUNNER'S CAM — what he sees, fogged to ~13 m"), earSide);
    boardRegion.append(h('div', { class: 'boardlabel' }, "OPERATOR'S BOARD — state and hazards"), beat, coach);
    const side = h(
      'aside',
      { class: 'side' },
      h('h2', {}, 'SPEAK — one word at a time'),
      phraseRow,
      h('h2', {}, 'CHALK — 6 marks, on his visor'),
      chalkRow,
      h('p', { class: 'hint' }, 'click his cam to place · ink ', ink, ' · ', kbd('C'), ' cycle · ', kbd('V'), ' ahead'),
      h('h2', {}, 'TWO-MAN RULE'),
      keyBtn,
      h('div', { class: 'keybar' }, keyBar),
      h('p', { class: 'hint' }, 'YOU ARE DEAF — no audio on this screen'),
      h('h2', {}, "OPERATOR'S STAMPS"),
      h('div', { class: 'feed' }, 'no stamps yet'),
      h('label', { class: 'auto' }, h('input', { type: 'checkbox', onchange: (e) => net.sendEvent({ type: 'auto', on: e.target.checked }) }), ' autopilot (demo)'),
    );
    app.append(side);
    hud.bridge = { beat, earSide, coach, ink, keyBar, keyBtn, phraseRow, chalkRow, side, vigDeath, vigWin, feedEl: side.querySelector('.feed') };
  }

  canvas.addEventListener('click', onCanvasClick, true);
}

let hud = {};
function toast(msg) {
  const t = document.querySelector('#toast') || document.body.appendChild(h('div', { id: 'toast', class: 'toast' }));
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('on'), 2200);
}
function pushVoiceShot(from, text, self = false) {
  const el = self ? document.querySelector('.selfshots') : document.querySelector('.shots');
  if (!el) return;
  el.append(h('div', { class: 'shot' }, h('b', {}, from + ':'), ' ' + text));
  while (el.children.length > 4) el.removeChild(el.firstChild);
}

function renderPeers() {
  const el = document.querySelector('#peers');
  if (!el) return;
  const want = ['runner', 'operator', 'bridge'];
  el.innerHTML = want
    .map((r) => {
      const p = peers.find((x) => x.role === r);
      return `<span class="${p ? 'on' : 'off'}">${r}${p ? ': ' + p.name : ''}</span>`;
    })
    .join(' · ');
}
function selectStamp(i) {
  stampIcon = ['▲', '⧗', '✓'][i];
  for (const b of document.querySelectorAll('.btn.stamp')) b.classList.toggle('on', b.dataset.i === String(i));
}
function paintChalkButtons() {
  if (!hud.bridge) return;
  for (const b of hud.bridge.chalkRow.querySelectorAll('.btn.dir')) b.classList.toggle('on', b.dataset.dir === chalkDir);
}
function updatePhraseCd() {
  if (!hud.bridge) return;
  for (const b of hud.bridge.phraseRow.querySelectorAll('.btn')) b.classList.add('cool');
}

function onCanvasClick(e) {
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const regions = [...document.querySelectorAll('.region[data-view]')];
  for (const el of regions) {
    const r = el.getBoundingClientRect();
    if (px < r.left - rect.left || px > r.right - rect.left || py < r.top - rect.top || py > r.bottom - rect.top) continue;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const local = { x: (r.left - rect.left) * dpr, y: (r.top - rect.top) * dpr, w: r.width * dpr, h: r.height * dpr };
    const cam = el.dataset.view === 'cam' ? world.runnerCam : world.operatorCam;
    const p = world.pick(cam, px, py, local);
    if (!p) return;
    if (ROLE === 'bridge' && el.dataset.view === 'cam') net.sendEvent({ type: 'chalk', ...p, dir: chalkDir });
    if (ROLE === 'operator' && el.dataset.view === 'board') net.sendEvent({ type: 'stamp', icon: stampIcon, x: p.x, z: p.z });
    return;
  }
}

// -------------------------------------------------------------- coach lines
function stateOf() {
  return ROLE === 'runner' ? local : remote;
}
function nextBeat(s) {
  const r = s.runner;
  for (const b of LEVEL.beats) {
    const d = b.z - r.z;
    if (d < -2) continue;
    const speed = Math.max(0.1, Math.hypot(r.vx, r.vz) || SIM.TUNING.runSpeed);
    return { ...b, dist: d, eta: d / speed, call: d <= b.callLead && d > b.callLead - 4.5 };
  }
  return null;
}
function coachRunner(s) {
  const r = s.runner;
  if (s.won) return 'CLEAR — you made it out.';
  if (s.dead) return 'You fell. To you the world is only shape: the floor at z44 is a lie, the span at z18 is only there if someone throws it.';
  const d = LEVEL.gap.z0 - r.z;
  if (d > -1 && d < 6 && s.span.phase === 'out') return 'FEEL: a dead slide-out span at z18. Only the OPERATOR can throw it, and only the BRIDGE can tell them where you are.';
  if (r.z > 44.4 && r.z < 60) return 'Underfoot: concrete. Trust the Bridge about what is not there.';
  if (r.z > 50 && r.z < 56.5 && r.y < 1) return 'A deck at z51. It only moves if the OPERATOR moves it, and it only moves at the right moment if the BRIDGE can see you standing on it.';
  if (r.z > 60 && r.z < 64) return 'The exit is a slab until both keys are satisfied. You cannot see which. Wait for the Bridge.';
  return 'BLIND: 13 metres of fog, no labels, no timers, no map. Everything you know comes from one voice.';
}
function coachOperator(s) {
  if (s.won) return 'Clear.';
  if (s.span.lockUntil > s.t) return `MOTOR OVERHEAT — locked ${(s.span.lockUntil - s.t).toFixed(1)}s. Two throws inside 8 s.`;
  if (s.span.phase === 'extended') return `SPAN OUT — retracts in ${s.span.timer.toFixed(1)}s.`;
  if (s.lift.moving) return `LIFT MOVING to ${(s.lift.target - LEVEL.lift.down).toFixed(1)} m…`;
  if (s.exit.armed && s.exit.open < 0.9) return `EXIT ARMED — the Bridge must hold the 2nd key (${s.key.hold.toFixed(1)}/${SIM.TUNING.keyHoldTime}s).`;
  if (s.knocks === 0) return 'No knocks left. Stamps only.';
  return 'You are MUTE and you cannot see the Runner. Stamps and KNOCKs are your voice; lever timing is your handwriting.';
}
function coachBridge(s) {
  const b = nextBeat(s);
  if (s.won) return 'Clear. Log the time.';
  if (s.dead) return 'He died. The ghost trail on his cam shows where he actually was — was your last call stale?';
  if (!b) return 'DEAF: no audio, no voice from anyone. Your eyes are his cam and the Operator\'s board.';
  if (b.kind === 'span') return `SPAN (${b.label}): 0.7 s to slide out + the Operator's reaction. Call THROW about a second before he reaches the edge.`;
  if (b.kind === 'pit') return `PHANTOM FLOOR (${b.label}): he CANNOT see it. Say JUMP when he is ~${b.callLead.toFixed(1)} m out.`;
  if (b.kind === 'lift') return `LIFT (${b.label}): you are the only one who can see that he is standing on it. Tell the Operator to raise it, and tell him to WAIT.`;
  return `TWO-KEY EXIT (${b.label}): the Operator arms it, you hold the key until he is through. He cannot see the door's state.`;
}

// ------------------------------------------------------------------- the loop
function viewsFor() {
  const stageRect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  const out = [];
  for (const el of document.querySelectorAll('.region[data-view]')) {
    const r = el.getBoundingClientRect();
    const w = Math.round(r.width * dpr);
    const h = Math.round(r.height * dpr);
    if (w < 8 || h < 8) continue;
    out.push({
      el,
      x: Math.round((r.left - stageRect.left) * dpr),
      y: Math.round((stageRect.bottom - r.bottom) * dpr),
      w,
      h,
      cam: el.dataset.view === 'cam' ? world.runnerCam : world.operatorCam,
    });
  }
  return out;
}

let last = performance.now();
let sendAcc = 0;
let domAcc = 0;
let showRunner = { x: 0, y: 0, z: 2, yaw: 0, vx: 0, vy: 0, vz: 0 };
let stepAcc = 0.33;
let sonarCd = 0;
let shake = 0;
let lastPhraseT = null;
let lastKnockT = null;
let lastDead = null;
let lastWon = null;

function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;

  const s = stateOf();
  world.resize();
  sonarCd = Math.max(0, sonarCd - dt);

  // one-shot edges: new phrase -> speech; new knock -> audio + camera shake.
  // The Bridge is deaf, so it only gets the visual shake on the Runner's cam.
  const ph = s.phrases[s.phrases.length - 1];
  if (lastPhraseT === null) lastPhraseT = ph ? ph.t : -1;
  else if (ph && ph.t !== lastPhraseT) {
    lastPhraseT = ph.t;
    if (ROLE !== 'bridge') audio.say(ph.text, 'bridge');
  }
  const k = s.knockFx[s.knockFx.length - 1];
  if (lastKnockT === null) lastKnockT = k ? k.t : -1;
  else if (k && k.t !== lastKnockT) {
    lastKnockT = k.t;
    if (ROLE !== 'bridge') audio.knock();
    if (ROLE !== 'operator') shake = 0.35;
  }
  if (lastDead === null) {
    lastDead = s.dead;
    lastWon = s.won;
  } else {
    if (s.dead && !lastDead && ROLE !== 'bridge') audio.death();
    if (s.won && !lastWon && ROLE !== 'bridge') audio.win();
    lastDead = s.dead;
    lastWon = s.won;
  }

  // ---- runner: step the local prediction sim with the local input
  if (ROLE === 'runner') {
    input.f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    input.s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    input.jump = keys.has('Space');
    const turn = (keys.has('ArrowLeft') ? 1 : 0) - (keys.has('ArrowRight') ? 1 : 0);
    if (turn) input.yaw += turn * 2.2 * dt;
    acc += dt;
    let steps = 0;
    while (acc >= FIX) {
      const wasGround = local.runner.ground;
      const vyBefore = local.runner.vy;
      SIM.step(local, FIX, { yaw: input.yaw, f: input.f, s: input.s, jump: input.jump });
      if (!wasGround && local.runner.ground) audio.land(Math.abs(vyBefore));
      acc -= FIX;
      steps++;
      if (steps > 8) break;
    }
    if (local.runner.ground && Math.hypot(local.runner.vx, local.runner.vz) > 2) {
      stepAcc += dt;
      if (stepAcc >= 0.33) {
        stepAcc = 0;
        audio.footstep();
      }
    } else stepAcc = 0.33;
    sendAcc += dt;
    if (sendAcc > 1 / 30) {
      sendAcc = 0;
      net.sendInput(input);
    }
    showRunner = local.runner;
    trackGhost(local.runner, dt);
  } else {
    // ---- others: smooth the 30 Hz snapshot so the world does not stutter
    const r = remote.runner;
    const k = Math.min(1, dt * 14);
    showRunner.x += (r.x - showRunner.x) * k;
    showRunner.y += (r.y - showRunner.y) * k;
    showRunner.z += (r.z - showRunner.z) * k;
    showRunner.yaw += (r.yaw - showRunner.yaw) * Math.min(1, dt * 10);
    const far = Math.hypot(r.x - showRunner.x, r.y - showRunner.y, r.z - showRunner.z);
    if (far > 2.5 || remote.dead) {
      Object.assign(showRunner, r);
    }
    trackGhost(showRunner, dt);
  }

  const view = { runner: showRunner, pitch: ROLE === 'runner' ? pitch : 0, ghost: clientGhost, shake };
  world.update(s, view, dt);
  audio.update(s, view, dt);
  if (shake > 0) shake = Math.max(0, shake - Math.min(dt, 0.05));

  const views = viewsFor();
  world.render(views.map((v) => ({ x: v.x, y: v.y, w: v.w, h: v.h, camera: v.cam })));

  domAcc += dt;
  if (domAcc > 0.1) {
    domAcc = 0;
    updateDom(s);
  }
  requestAnimationFrame(frame);
}
let acc = 0;
const FIX = 1 / 60;

function trackGhost(r, dt) {
  clientGhost.push({ x: r.x, y: r.y, z: r.z, t: performance.now() / 1000 });
  while (clientGhost.length && performance.now() / 1000 - clientGhost[0].t > 6) clientGhost.shift();
}

// --------------------------------------------------------------------- DOM/UI
const lastPhrase = { text: '', at: 0 };
function updateDom(s) {
  sidebarRtt = net.rtt;
  const stat = document.querySelector('#netstat');
  if (stat) stat.textContent = `${net.connected ? '●' : '○'} room ${ROOM} · ${ROLE} · ${net.rtt} ms`;

  const ph = s.phrases[s.phrases.length - 1];
  const phraseRecent = ph && s.t - ph.t < 2.5;

  if (ROLE === 'runner' && hud.runner) {
    const { ear, feel, coach, banner, sonar: sonarEl, vigDeath, vigWin } = hud.runner;
    ear.textContent = phraseRecent ? ph.text : '';
    ear.classList.toggle('hot', !!phraseRecent);
    const r = s.runner;
    let f = '';
    if (r.z > 15 && r.z < 18.6 && s.span.phase === 'out') f = 'you feel: a dead slide-out span';
    if (r.z > 61 && r.z < 64 && s.exit.open < 0.9) f = 'you feel: a bolted slab';
    if (r.z > 43.5 && r.z < 44.2 && r.y < 0.4) f = 'you feel: solid concrete';
    feel.textContent = f;
    coach.textContent = coachRunner(s);
    banner.textContent = s.won ? 'CLEAR ' + s.wonTime.toFixed(2) + 's' : s.dead ? 'YOU FELL — respawning' : '';
    banner.className = 'banner ' + (s.won ? 'win' : s.dead ? 'die' : '');
    vigDeath.classList.toggle('on', !!s.dead);
    vigWin.classList.toggle('on', !!s.won);
    sonarEl.textContent = sonarCd > 0 ? `[Q] SONAR ${sonarCd.toFixed(1)}s` : '[Q] SONAR';
    sonarEl.classList.toggle('ready', sonarCd <= 0);
    sonarEl.classList.toggle('charging', sonarCd > 0);
    hud.runner.lock.style.display = document.pointerLockElement === canvas ? 'none' : '';
  }

  if (ROLE === 'operator' && hud.operator) {
    const { voice, feed, coach } = hud.operator;
    const say = s.phrases[s.phrases.length - 1];
    voice.textContent = say && s.t - say.t < 3 ? `(Bridge) ${say.text}` : '';
    feed.textContent = [s.fx.filter((x) => s.t - x.t < 4).map((x) => x.text).join(' · ')].join(' ');
    coach.textContent = coachOperator(s);
    const k = document.querySelector('.knocks');
    if (k) k.textContent = String(s.knocks);
    const chk = document.querySelector('.auto input');
    if (chk && chk.checked !== !!s.runner.auto) chk.checked = !!s.runner.auto;
  }

  if (ROLE === 'bridge' && hud.bridge) {
    const { beat, earSide, coach, ink, keyBar, keyBtn, feedEl, vigDeath, vigWin } = hud.bridge;
    const b = nextBeat(s);
    const now = b && b.call && b.kind !== 'exit' && b.kind !== 'lift';
    beat.innerHTML = b
      ? `<b>${b.label}</b> — ${b.dist.toFixed(1)} m / ${b.eta.toFixed(2)} s ${now ? '<span class="now">◀ CALL NOW</span>' : ''}<em>${b.why}</em>`
      : 'NEXT: —';
    beat.classList.toggle('call', !!now);
    earSide.textContent = s.stamps.length
      ? s.stamps
          .slice(-3)
          .map((x) => `${x.icon} z${x.z.toFixed(0)} (${(s.t - x.t).toFixed(1)}s)`)
          .join('   ')
      : 'no stamps yet';
    coach.textContent = coachBridge(s);
    vigDeath.classList.toggle('on', !!s.dead);
    vigWin.classList.toggle('on', !!s.won);
    ink.textContent = String(s.ink);
    keyBar.style.width = Math.min(100, (s.key.hold / SIM.TUNING.keyHoldTime) * 100) + '%';
    keyBtn.classList.toggle('ready', s.exit.armed && s.exit.open < 0.9);
    keyBtn.classList.toggle('done', s.exit.open > 0.9);
    for (const btn of hud.bridge.phraseRow.querySelectorAll('.btn')) btn.classList.toggle('cool', s.phraseCd > 0);
    if (feedEl) feedEl.textContent = s.stamps.length ? s.stamps.slice(-4).map((x) => `${x.icon} @ z${x.z.toFixed(0)}`).join('  ') : 'no stamps yet';
  }
}

// -------------------------------------------------------------------- startup
// debug/automation handle (used by test/lan3d.mjs; harmless in play)
window.__relay3d = {
  ROLE,
  ROOM,
  get state() {
    return stateOf();
  },
  get remote() {
    return remote;
  },
  get local() {
    return local;
  },
  get peers() {
    return peers;
  },
  world,
  net,
  audio,
  get audioEnabled() {
    return audio.enabled;
  },
  get shake() {
    return shake;
  },
  sonar: () => fireSonar(),
  get sonarCooldown() {
    return sonarCd;
  },
  THREE,
  LAYER,
  ev: (ev) => net.sendEvent(ev),
  say: (t) => net.say(t),
  view: () => showRunner,
  errors: [],
};

build();
paintChalkButtons();
selectStamp(0);
bindInput();
requestAnimationFrame(frame);
