// RELAY 3D — the three private screens. One canvas, up to two viewports, and a
// HUD per role. The Runner's cam, the Operator's board and the Bridge's copy of the board
// are different layer masks of the same scene, so no role *can* see another's information.
import * as THREE from '../vendor/three.module.js';
import { LEVEL, LANE_NAME } from '../../shared/level3d.js';
import * as SIM from '../../shared/sim3d.js';
import { createWorld, LAYER } from './world.js';
import { createNet } from './net.js';
import { createAudio } from './audio.js';
import { createVoice } from './voice.js';

const P = new URLSearchParams(location.search);
const ROLE = ['runner', 'operator', 'bridge'].includes(P.get('role')) ? P.get('role') : 'runner';
const ROOM = (P.get('room') || 'A').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'A';
// demo/automation helpers (autopilot) only exist with ?debug=1; the server also refuses
// them unless it was started with --debug
const DEBUG = P.get('debug') === '1';
const NAME = P.get('name') || '';
// ?assist=1 gives the Bridge distances, ETAs and CALL NOW prompts (a tutorial crutch:
// without it, judging the moment is the Bridge's job)
const ASSIST = P.get('assist') === '1';

// The Bridge is deaf by rule: createAudio('bridge') is a hard-muted no-op.
const audio = createAudio(ROLE);

const PHRASES = ['GO', 'WAIT', 'JUMP NOW', 'LEFT', 'RIGHT', 'BRACE', 'UP', 'ARM', 'THROW', 'ON ONE'];
const PHRASE_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', 'T', 'O'];
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
let votes = { roles: [], need: 2 };
let history = [];
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
    voice?.setPlayers(m.players);
    history = m.history || [];
    status = 'playing';
  },
  onSnapshot: (s) => {
    if (ROLE === 'runner') predict.adopt(s);
    else remote = s;
  },
  onPlayers: (p) => {
    peers = p;
    renderPeers();
    voice?.setPlayers(p);
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
  onVotes: (m) => {
    votes = m;
    renderVotes();
  },
  onReset: (snap) => {
    // a fresh run: adopt everything, including the Runner's own body
    remote = snap;
    local = JSON.parse(JSON.stringify(snap));
    autopilot = false;
    clientGhost.length = 0;
    showRunner = { ...snap.runner };
    toast('RUN AGAIN — fresh run, fresh dice');
  },
  onStatus: (s) => {
    status = s;
    const el = document.querySelector('#netstat');
    if (el) el.textContent = s === 'connected' ? `${ROOM} · ${ROLE}` : s;
  },
});

net.on('history', (m) => {
  history = m.runs || [];
});
// after a win, RUN AGAIN rotates the roles: reload into the next one
net.on('rotate', (m) => {
  if (!['runner', 'operator', 'bridge'].includes(m.role)) return;
  const q = new URLSearchParams(location.search);
  q.set('role', m.role);
  toast(`ROLES ROTATE — you are the ${m.role.toUpperCase()} now`);
  setTimeout(() => location.replace(`play.html?${q}`), 900);
});

// ------------------------------------------------------------------- voice
// Runner: hold SHIFT to talk to the Operator. Bridge: hold SPACE to talk to both.
// M toggles an open mic. The Operator has no mic; the Bridge hears nothing.
const PTT_KEYS = ROLE === 'runner' ? ['ShiftLeft', 'ShiftRight'] : ROLE === 'bridge' ? ['Space'] : [];
const PTT_LABEL = ROLE === 'runner' ? 'SHIFT' : 'SPACE';
const voice = createVoice({ role: ROLE, net, onChange: () => renderVoice() });
voice.start();

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
      l.committed = r.committed;
      l.brace = r.brace;
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
  const unlockAudio = () => {
    audio.unlock();
    voice.resume();
  };
  addEventListener('pointerdown', unlockAudio, { once: true });
  addEventListener('keydown', unlockAudio, { once: true });

  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    if (PTT_KEYS.includes(e.code)) voice.setPtt(true);
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
    onKeyDown(e.code);
  });
  addEventListener('keyup', (e) => {
    keys.delete(e.code);
    if (PTT_KEYS.includes(e.code)) e.preventDefault(); // SPACE must not also click a focused button
    if (PTT_KEYS.includes(e.code) && !PTT_KEYS.some((k) => keys.has(k))) voice.setPtt(false);
    if (e.code === 'KeyK' && ROLE === 'bridge') net.sendEvent({ type: 'key', down: false });
    if (e.code === 'KeyH' && ROLE === 'operator') net.sendEvent({ type: 'press', down: false });
  });
  // a key released while this window is not focused never sends its keyup: without
  // this the Runner keeps running (and the Bridge keeps holding the key) forever
  addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAll();
  });
  canvas.addEventListener('click', (e) => {
    if (ROLE === 'runner') canvas.requestPointerLock?.();
  });
  addEventListener('mousemove', (e) => {
    if (ROLE !== 'runner') return;
    if (document.pointerLockElement !== canvas) return;
    // mouse right turns the view right (-X); he runs down the gantry, so the look is clamped
    input.yaw = Math.max(-1.1, Math.min(1.1, input.yaw - e.movementX * 0.0022));
    pitch = Math.max(-1.0, Math.min(0.9, pitch - e.movementY * 0.0022));
  });
}

function releaseAll() {
  keys.clear();
  input.f = 0;
  input.s = 0;
  input.jump = false;
  if (ROLE === 'runner') net.sendInput(input);
  if (ROLE === 'bridge') net.sendEvent({ type: 'key', down: false });
  if (ROLE === 'operator') net.sendEvent({ type: 'press', down: false });
  voice.setPtt(false);
}

function onKeyDown(code) {
  if (code === 'KeyR') {
    toggleVote();
    return;
  }
  if (code === 'KeyM' && PTT_KEYS.length) {
    voice.toggleOpen();
    return;
  }
  if (ROLE === 'runner' && code === 'KeyQ') {
    fireSonar();
    return;
  }
  if (DEBUG && code === 'KeyP') {
    autopilot = !autopilot;
    net.sendEvent({ type: 'auto', on: autopilot });
    toast(autopilot ? 'autopilot on (demo helper)' : 'autopilot off');
    return;
  }
  if (ROLE === 'operator') {
    if (code === 'KeyB') net.sendEvent({ type: 'span.throw' });
    if (code === 'KeyH') net.sendEvent({ type: 'press', down: true });
    if (code === 'KeyF') net.sendEvent({ type: 'lift.toggle' });
    if (code === 'KeyE') net.sendEvent({ type: 'exit.lever' });
    if (code === 'KeyN') knock();
    if (code === 'Digit7') selectStamp(0);
    if (code === 'Digit8') selectStamp(1);
    if (code === 'Digit9') selectStamp(2);
  }
  if (ROLE === 'bridge') {
    const i = code.startsWith('Digit') ? '12345678'.indexOf(code.slice(5)) : -1;
    if (i >= 0) sendPhrase(PHRASES[i]);
    if (code === 'KeyT') sendPhrase('THROW');
    if (code === 'KeyO') sendPhrase('ON ONE');
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
    z: Math.max(0.5, Math.min(89, r.z + dz)),
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
  stage.append(h('div', { class: 'voicebar', id: 'voicebar', role: 'status', 'aria-live': 'polite' }));
  stage.append(
    h(
      'div',
      { class: 'chrome' },
      h('span', { id: 'netstat', class: 'netstat' }, 'connecting…'),
      h('span', { class: 'peers', id: 'peers' }),
      h('button', { class: 'again', id: 'again', onclick: () => toggleVote() }, 'RUN AGAIN', kbd('R')),
      h('a', { class: 'lobby', href: 'index.html' }, 'lobby'),
    ),
  );

  if (ROLE === 'runner') {
    const ear = h('div', { class: 'ear' });
    const feel = h('div', { class: 'feel' });
    const coach = h('div', { class: 'coach' });
    const banner = h('div', { class: 'banner' });
    const lock = h('div', { class: 'lock' }, 'click to look · W go (no stopping) · A/D steer · S brace · SPACE jump · Q sonar · hold SHIFT to talk to the Operator');
    const station = h('div', { class: 'station' });
    const braceBar = h('i');
    const brace = h('div', { class: 'brace', title: 'S brace — 1.2 s per section' }, h('span', {}, 'BRACE'), h('b', {}, braceBar));
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
      station,
      brace,
      banner,
      lock,
      h('div', { class: 'shoutrow' }, shoutInput),
      coach,
      sonarEl,
    );
    hud.runner = { ear, feel, coach, banner, lock, station, braceBar, sonar: sonarEl, vigDeath, vigWin, shout: pushVoiceShot, selfShots: h('div', { class: 'selfshots' }) };
    camRegion.append(hud.runner.selfShots);
    setTimeout(() => lock.classList.add('fade'), 6000);
  }

  if (ROLE === 'operator') {
    const voice = h('div', { class: 'voice' });
    const shots = h('div', { class: 'shots' });
    const feed = h('div', { class: 'feed' });
    const coach = h('div', { class: 'coach' });
    boardRegion.append(h('div', { class: 'boardlabel' }, 'YOUR BOARD — states, timings, and the LIES in the hall (red: only you see them). No runner.'), coach);
    const holdPress = (down) => () => net.sendEvent({ type: 'press', down });
    const side = h(
      'aside',
      { class: 'side' },
      h('h2', {}, 'CONTROL'),
      h('button', { class: 'btn big', onclick: () => net.sendEvent({ type: 'span.throw' }) }, 'THROW SLIDE BRIDGE', kbd('B')),
      h('button', { class: 'btn big', onpointerdown: holdPress(true), onpointerup: holdPress(false), onpointerleave: holdPress(false) }, 'HOLD THE PRESS UP', kbd('H')),
      h('button', { class: 'btn big', onclick: () => net.sendEvent({ type: 'lift.toggle' }) }, 'LIFT UP / DOWN', kbd('F')),
      h('button', { class: 'btn big', onclick: () => net.sendEvent({ type: 'exit.lever' }) }, 'EXIT LEVER', kbd('E')),
      h('button', { class: 'btn big', onclick: knock }, 'KNOCK', kbd('N'), h('b', { class: 'knocks' }, '3')),
      h('h2', {}, 'STAMP'),
      h(
        'div',
        { class: 'row' },
        ...['▲', '⧗', '✓'].map((ic, i) => h('button', { class: 'btn stamp', dataset: { i: String(i) }, onclick: () => selectStamp(i) }, ic)),
      ),
      h('p', { class: 'hint' }, 'then click your board: the Bridge sees your stamps on his copy, which does NOT show the red lies'),
      h('h2', {}, 'VOICE — the Bridge (you hear them)'),
      voice,
      h('h2', {}, 'EAR — the Runner (you hear them; you cannot answer)'),
      shots,
      h('h2', {}, 'SYSTEM'),
      feed,
      DEBUG ? h('label', { class: 'auto' }, h('input', { type: 'checkbox', onchange: (e) => net.sendEvent({ type: 'auto', on: e.target.checked }) }), ' autopilot (debug)') : null,
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
    boardRegion.append(h('div', { class: 'boardlabel' }, "THE BOARD — states and the Operator's stamps (not the lies: he has to stamp them)"), beat, coach);
    const side = h(
      'aside',
      { class: 'side' },
      h('h2', {}, 'SPEAK — one word at a time'),
      phraseRow,
      h('h2', {}, 'CHALK — 6 marks, on his visor'),
      chalkRow,
      h('p', { class: 'hint' }, 'click his cam or your board to place · ink ', ink, ' · ', kbd('C'), ' cycle · ', kbd('V'), ' ahead'),
      h('h2', {}, 'TWO-MAN RULE'),
      keyBtn,
      h('div', { class: 'keybar' }, keyBar),
      h('p', { class: 'hint' }, 'YOU ARE DEAF — no audio on this screen'),
      h('h2', {}, "OPERATOR'S STAMPS"),
      h('div', { class: 'feed' }, 'no stamps yet'),
      DEBUG ? h('label', { class: 'auto' }, h('input', { type: 'checkbox', onchange: (e) => net.sendEvent({ type: 'auto', on: e.target.checked }) }), ' autopilot (debug)') : null,
    );
    app.append(side);
    hud.bridge = { beat, earSide, coach, ink, keyBar, keyBtn, phraseRow, chalkRow, side, vigDeath, vigWin, feedEl: side.querySelector('.feed') };
  }

  const score = h('div', { class: 'scoreboard', id: 'scoreboard', role: 'status', 'aria-live': 'polite' });
  stage.append(score);
  canvas.addEventListener('click', onCanvasClick, true);
}

function renderScore(s) {
  const el = document.querySelector('#scoreboard');
  if (!el) return;
  el.classList.toggle('on', !!s.won);
  if (!s.won) return;
  const three = peers.length === 3;
  const rows = history
    .slice(-6)
    .map((r) => `<tr><td>#${r.n}</td><td>${r.time.toFixed(1)} s</td><td>${r.deaths} fall${r.deaths === 1 ? '' : 's'}</td><td>R ${esc(r.roles.runner || '—')} · O ${esc(r.roles.operator || '—')} · B ${esc(r.roles.bridge || '—')}</td></tr>`)
    .join('');
  el.innerHTML = `<h2>CLEAR — ${s.wonTime.toFixed(1)} s · ${s.deaths} fall${s.deaths === 1 ? '' : 's'}</h2>
    <table>${rows}</table>
    <p>${three ? '<b>RUN AGAIN</b> (R, two votes): the roles rotate, so everyone plays all three.' : '<b>RUN AGAIN</b> (R) for a fresh roll of the gantry.'}</p>`;
}
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

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
// ------------------------------------------------------------ voice HUD
const ROLE_NAME = { runner: 'RUNNER', operator: 'OPERATOR', bridge: 'BRIDGE' };
let voiceLevel = 0;
function renderVoice() {
  const el = document.querySelector('#voicebar');
  if (!el) return;
  const v = voice.state;
  const rows = [];
  if (ROLE === 'operator') rows.push('<span class="vx dim">MUTE — no mic</span>');
  else {
    const to = v.speaks.map((r) => ROLE_NAME[r]).join(' + ');
    let mic = '';
    if (v.mic === 'on') {
      const live = v.live ? 'live' : '';
      mic = `<span class="vx mic ${live}">${v.live ? '● TALKING' : '○ MIC'} → ${to}</span>` +
        `<i class="meter"><b style="width:${Math.round(Math.min(1, voiceLevel * 3) * 100)}%"></b></i>` +
        `<span class="vx dim">hold ${PTT_LABEL}${v.open ? ' · <b class="openmic">OPEN MIC</b> (M)' : ' · M open mic'}</span>`;
    } else if (v.mic === 'insecure') {
      mic = v.httpsUrl
        ? `<span class="vx warn">voice needs https — <a href="${v.httpsUrl}">open the https address</a></span>`
        : '<span class="vx warn">voice needs https (start the server with https on)</span>';
    } else if (v.mic === 'asking') mic = '<span class="vx dim">allow the microphone…</span>';
    else if (v.mic === 'denied') mic = '<span class="vx warn">mic blocked by the browser — allow it in the address bar</span>';
    else if (v.mic === 'disabled') mic = '<span class="vx dim">mic off (lobby setting) — phrase wheel only</span>';
    else if (v.mic === 'unavailable') mic = '<span class="vx warn">no microphone found</span>';
    rows.push(mic);
  }
  if (ROLE === 'bridge') rows.push('<span class="vx dim">DEAF — no incoming voice</span>');
  else {
    const chips = v.hears.map((r) => {
      const linked = voice.links().some((l) => l.dir === 'in' && l.id.startsWith(r + '>') && l.conn === 'connected');
      return `<span class="chip ${v.talking[r] ? 'talk' : ''} ${linked ? '' : 'off'}">${ROLE_NAME[r]}${v.talking[r] ? ' speaking' : ''}</span>`;
    });
    rows.push(`<span class="vx dim">you hear</span> ${chips.join(' ')}${v.blocked ? ' <span class="vx warn">click to hear voice</span>' : ''}`);
  }
  el.innerHTML = rows.map((r) => `<div>${r}</div>`).join('');
}
async function pollVoiceLevel() {
  if (voice.state.mic !== 'on') return;
  const st = await voice.stats();
  voiceLevel = Math.max(0, ...st.filter((x) => x.dir === 'out').map((x) => x.level));
  renderVoice();
}

function myVote() {
  return votes.roles.includes(ROLE);
}
function toggleVote() {
  net.voteRestart(!myVote());
}
function renderVotes() {
  const el = document.querySelector('#again');
  if (!el) return;
  const n = votes.roles.length;
  el.firstChild.textContent = n ? `RUN AGAIN ${n}/${votes.need}` : 'RUN AGAIN';
  el.classList.toggle('voted', myVote());
  el.title = n ? `voted: ${votes.roles.join(', ')}` : 'two players restart the room';
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
    const cam = camFor(el.dataset.view);
    const p = world.pick(cam, px, py, local);
    if (!p) return;
    if (ROLE === 'bridge') net.sendEvent({ type: 'chalk', ...p, dir: chalkDir });
    if (ROLE === 'operator' && el.dataset.view === 'board') net.sendEvent({ type: 'stamp', icon: stampIcon, x: p.x, z: p.z });
    return;
  }
}

// -------------------------------------------------------------- coach lines
function camFor(view) {
  if (view === 'cam') return world.runnerCam;
  return ROLE === 'bridge' ? world.bridgeBoardCam : world.operatorCam;
}
function stateOf() {
  return ROLE === 'runner' ? local : remote;
}
function nextBeat(s) {
  const r = s.runner;
  for (const b of LEVEL.beats) {
    const d = b.z - r.z;
    if (d < (b.kind === 'hall' ? -18 : -2)) continue;
    const speed = Math.max(0.1, Math.hypot(r.vx, r.vz) || SIM.TUNING.runSpeed);
    return { ...b, dist: d, eta: d / speed, call: d <= b.callLead && d > b.callLead - 4.5 };
  }
  return null;
}
const STATION_TIP = [
  'START. Line up where the Bridge says (A / D), then W. You cannot stop until the next station.',
  'HALL DOOR. Nine floor tiles, six are lies, and they all look the same to you. Follow the chalk; cross between lanes at the seam.',
  'PRESS BAY. Go on the Bridge\'s count: the press is only up while the Operator holds it. Then stand on the lift and wait.',
  'CATWALK. Once you go it falls away behind you. Jump the gap. The door at the end must already be opening.',
];
function coachRunner(s) {
  const r = s.runner;
  if (s.won) return 'CLEAR — you made it out.';
  if (s.dead && s.deathCause === 'crushed') return 'Crushed. The press is only up while the Operator holds it — go on the count.';
  if (s.dead) return 'You fell. Every floor looks the same to you; the gantry re-rolls when you come back.';
  if (!r.committed) return STATION_TIP[s.section] || '';
  if (r.onLift) return 'On the deck. Only the Operator can raise it, and only the Bridge can see you are on it.';
  return 'BLIND: 13 metres of fog, no labels, no timers, no map. S braces you, once, for 1.2 s.';
}
function coachOperator(s) {
  if (s.won) return 'Clear.';
  if (s.span.lockUntil > s.t) return `MOTOR OVERHEAT — locked ${(s.span.lockUntil - s.t).toFixed(1)} s. Two throws inside 8 s.`;
  if (s.span.phase === 'extended') return `SPAN OUT — retracts in ${s.span.timer.toFixed(1)} s.`;
  if (s.press.lockUntil > s.t) return `PRESS OVERHEAT — locked ${(s.press.lockUntil - s.t).toFixed(1)} s.`;
  if (s.press.phase === 'up') return `PRESS UP — it slams in ${(SIM.TUNING.pressMaxHold - s.press.holdT).toFixed(1)} s or when you let go.`;
  if (s.lift.moving) return 'LIFT MOVING…';
  if (s.exit.phase === 'open') return `EXIT OPEN — seals in ${s.exit.stay.toFixed(1)} s.`;
  if (s.exit.armed) return `EXIT ARMED — the Bridge has ${(SIM.TUNING.armWindow - s.exit.armT).toFixed(1)} s to start turning the key (${s.key.hold.toFixed(1)}/${SIM.TUNING.keyHoldTime} s).`;
  if (s.section === 0) return `The span slides out in the ${spanLaneName(s)} lane this time. Throw it on the Bridge's call — you cannot see him.`;
  if (s.section === 1) return 'The RED tiles are lies. Only you see them: stamp ✓ on the true ones (or ▲ on the lies) so the Bridge can chalk his path.';
  if (s.section === 2) return 'Hold H to keep the press up on the Bridge\'s count, at most 1.2 s. Raise the LIFT only when told he is on it.';
  return 'Arm the EXIT when the Bridge asks: an arm with no key in 3 s expires. You cannot see the catwalk falling.';
}
const spanLaneName = (s) => LANE_NAME[s.layout?.spanLane ?? 1];
function coachBridge(s) {
  const b = nextBeat(s);
  if (s.won) return 'Clear. Log the time.';
  if (s.dead) return 'He died. The ghost trail on his cam shows where he really was — was your call stale?';
  if (!b) return "DEAF: no audio, no voice from anyone. Your eyes are his cam and the board.";
  if (b.kind === 'span') return `SPAN: it slides out in the ${spanLaneName(s)} lane — tell him where to stand before he goes. Then call THROW about a second before the edge.`;
  if (b.kind === 'hall') return "DARK HALL: you can't see the lies. Read the Operator's stamps on your board, chalk his path, call LEFT / RIGHT.";
  if (b.kind === 'press') return 'PRESS: count "3, 2, 1" — the Operator lifts on ONE, the Runner goes on ONE.';
  if (b.kind === 'lift') return 'LIFT: you are the only one who can see he is on the deck. Tell the Operator UP.';
  return 'FINALE: ask for ARM, turn the key (K), then GO. The catwalk falls behind him; the door must open before he gets there.';
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
      cam: camFor(el.dataset.view),
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
  document.querySelector('#again')?.classList.toggle('hot', !!s.won);
  renderScore(s);
  pollVoiceLevel();
  const stat = document.querySelector('#netstat');
  if (stat) stat.textContent = `${net.connected ? '●' : '○'} room ${ROOM} · ${ROLE} · ${net.rtt} ms`;

  const ph = s.phrases[s.phrases.length - 1];
  const phraseRecent = ph && s.t - ph.t < 2.5;

  if (ROLE === 'runner' && hud.runner) {
    const { ear, feel, coach, banner, sonar: sonarEl, vigDeath, vigWin } = hud.runner;
    ear.textContent = phraseRecent ? ph.text : '';
    ear.classList.toggle('hot', !!phraseRecent);
    const r = s.runner;
    // shape only: nothing here may leak a state the Runner cannot see
    let f = '';
    if (r.z > LEVEL.exit.z - 1.2 && r.z < LEVEL.exit.z && r.y > 3.5 && s.exit.open < 0.9) f = 'you feel: a bolted slab';
    feel.textContent = f;
    const st = LEVEL.stations[s.section];
    hud.runner.station.innerHTML = !r.committed && !s.dead && !s.won ? `<b>STATION ${s.section + 1} · ${st.name}</b>press <kbd>W</kbd> to go — no stopping after that` : '';
    hud.runner.braceBar.style.width = `${(100 * r.brace) / SIM.TUNING.braceTime}%`;
    coach.textContent = coachRunner(s);
    banner.textContent = s.won ? '' /* the scoreboard says it */ : s.dead ? (s.deathCause === 'crushed' ? 'CRUSHED — respawning' : 'YOU FELL — respawning') : '';
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
    // without ?assist=1 the Bridge gets no distances or prompts: judging the moment is his job
    const now = ASSIST && b && b.call && s.runner.committed && (b.kind === 'span' || b.kind === 'press');
    const where = !s.runner.committed && !s.dead && !s.won ? ` · <span class="hold">HE IS AT STATION ${s.section + 1}</span>` : '';
    beat.innerHTML = b
      ? `<b>${b.label}</b>${ASSIST ? ` — ${b.dist.toFixed(1)} m / ${b.eta.toFixed(2)} s` : ''}${where} ${now ? '<span class="now">◀ CALL NOW</span>' : ''}<em>${b.why}</em>`
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
  DEBUG,
  voice,
  get votes() {
    return votes;
  },
  get history() {
    return history;
  },
  ASSIST,
  get heldKeys() {
    return [...keys];
  },
  get input() {
    return { ...input };
  },
  errors: [],
};

build();
renderVoice();
paintChalkButtons();
selectStamp(0);
bindInput();
requestAnimationFrame(frame);
