// RELAY 3D — LAN test. Launches a real headless Chromium, opens three independent
// tabs against the server, and checks the relay chain across laptops' worth of
// WebSocket connections. Everything here goes over the network, not BroadcastChannel.
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';

const CDP = `http://127.0.0.1:${process.env.CDP_PORT || '9223'}`;
const BASE = process.env.BASE || 'http://127.0.0.1:8791';
const SHOTS = new URL('../shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

async function newTab(url) {
  const r = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return r.json();
}

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const waiting = new Map();
  const errors = [];
  const logs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url || '')) errors.push(m.params.entry.text);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      waiting.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  // a page that is navigating (role rotation reloads it) may never answer: time out instead
  const ev = async (expr, ms = 30000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
      sleep(ms).then(() => {
        throw new Error('evaluate timed out');
      }),
    ]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  return { ev, send, errors, close: () => ws.close(), id: t.id, url: t.url };
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const press = (t, code) => t.ev(`window.dispatchEvent(new KeyboardEvent('keydown', {code:${JSON.stringify(code)}, bubbles:true, cancelable:true}))`);
const focus = async (t) => {
  await t.send('Page.bringToFront');
  await sleep(150);
};

const ROOM = `T${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
console.log(`room ${ROOM}\n`);

const tabs = {};
for (const role of ['runner', 'operator', 'bridge']) {
  const t = await newTab(`${BASE}/play.html?role=${role}&room=${ROOM}&name=${role}`);
  tabs[role] = await connect(t);
  await sleep(900);
}
const { runner, operator, bridge } = tabs;

// --- boot
for (const [role, t] of Object.entries(tabs)) {
  let ok = false;
  for (let i = 0; i < 45; i++) {
    if (await t.ev('!!window.__relay3d && window.__relay3d.state.t > 0')) {
      ok = true;
      break;
    }
    await sleep(150);
  }
  check(`${role}: client connected to the server and is receiving snapshots`, ok);
}

const webgl = await (async () => {
  // the Runner tab may still be backgrounded/throttled right after boot; bring it
  // up and give the render loop a beat so renderer.info has a completed frame
  await focus(runner);
  let info = null;
  for (let i = 0; i < 30; i++) {
    info = await runner.ev(`(() => {
      const w = window.__relay3d.world;
      return { calls: w.renderer.info.render.calls, tris: w.renderer.info.render.triangles,
               masks: { runner: w.runnerCam.layers.mask, operator: w.operatorCam.layers.mask },
               LAYER: window.__relay3d.LAYER };
    })()`);
    if (info.tris > 500) break;
    await sleep(100);
  }
  return info;
})();
check('three.js is actually drawing the level', webgl.tris > 500 && webgl.calls > 5, `tris=${webgl.tris} calls=${webgl.calls}`);
check(
  "the Runner's cam cannot see the Operator's board (layer isolation)",
  webgl.masks.runner !== webgl.masks.operator && !(webgl.masks.runner & (1 << webgl.LAYER.BOARD)),
  `runner=${webgl.masks.runner} operator=${webgl.masks.operator} board=${1 << webgl.LAYER.BOARD}`,
);

// --- who is in the room
const peers = await runner.ev('window.__relay3d.peers.map(p=>p.role).sort().join(",")');
check('all three roles are present in the room', peers === 'bridge,operator,runner', peers);

// --- strafe direction: at yaw 0 the camera looks down +Z, so screen-right is -X.
//     'D' (s=1) must move the Runner to -X, 'A' (s=-1) back to +X. The Runner tab's
//     render loop is throttled in headless, so drive the authoritative input directly
//     and read the result off the Operator's snapshots.
const serverRunner = () => operator.ev('({ vx: window.__relay3d.state.runner.vx, x: window.__relay3d.state.runner.x })');
await runner.ev('window.__relay3d.__autoSend = window.__relay3d.net.sendInput; window.__relay3d.net.sendInput = () => {}');
const drive = (s) => runner.ev(`window.__relay3d.__autoSend({ yaw: 0, f: 0, s: ${s}, jump: false })`);
let strafeD = { vx: 0, x: 0 };
for (let i = 0; i < 30; i++) {
  await drive(1);
  await sleep(60);
  strafeD = await serverRunner();
  if (strafeD.vx < -1 && strafeD.x < -0.3) break;
}
await drive(0);
await sleep(300);
let strafeA = { vx: 0, x: 0 };
for (let i = 0; i < 30; i++) {
  await drive(-1);
  await sleep(60);
  strafeA = await serverRunner();
  if (strafeA.vx > 1 && strafeA.x > -0.05) break;
}
await drive(0);
await runner.ev('window.__relay3d.net.sendInput = window.__relay3d.__autoSend; delete window.__relay3d.__autoSend');
await sleep(300);
check(
  "strafe: 'D' (s=1) moves screen-right (-X), 'A' (s=-1) moves screen-left (+X)",
  strafeD.vx < -1 && strafeD.x < -0.05 && strafeA.vx > 1 && strafeA.x > strafeD.x,
  `D(vx=${strafeD.vx.toFixed(2)}, x=${strafeD.x.toFixed(2)}) A(vx=${strafeA.vx.toFixed(2)}, x=${strafeA.x.toFixed(2)})`,
);

// --- Operator lever -> authoritative sim
await focus(operator);
await press(operator, 'KeyB');
await sleep(500);
await focus(runner);
const phase = await runner.ev('window.__relay3d.state.span.phase');
check("Operator's lever reaches the Runner over the network", ['moving', 'extended'].includes(phase), `phase=${phase}`);

await focus(operator);
await press(operator, 'KeyF');
await sleep(400);
await focus(runner);
const liftY = await runner.ev('window.__relay3d.state.lift.y');
const liftMoving = await runner.ev('window.__relay3d.state.lift.moving');
check("Operator's lift is authoritative too", liftMoving === true || liftY > -0.34, `y=${liftY}`);

// --- Bridge words -> runner ear + operator ear, and NOT to the bridge's own logic
await focus(bridge);
await press(bridge, 'Digit3');
// the rate limit is server state (phraseCd), mirrored by the buttons' 'cool' class;
// sample it while the 1.2 s window is still up
let bCool = false;
for (let i = 0; i < 20 && !bCool; i++) {
  await sleep(40);
  bCool = await bridge.ev(`window.__relay3d.state.phraseCd > 0 && window.__relay3d.state.phrases.length > 0`);
}
const before = await bridge.ev('window.__relay3d.state.phrases.length');
await press(bridge, 'Digit1'); // a second word inside the window must be dropped
await sleep(300);
const after = await bridge.ev('window.__relay3d.state.phrases.length');
bCool = bCool && after === before;
// the phrase is on screen for ~2.5-3 s; a backgrounded tab only repaints while in
// front, so alternate between the two listeners until both have shown it
let rEar = '';
let oVoice = '';
for (let i = 0; i < 24 && !(rEar.includes('JUMP NOW') && oVoice.includes('JUMP NOW')); i++) {
  // headless tabs paint at ~2 fps: if a 2.5 s word was missed, say it again (rate limit permitting)
  if (i % 6 === 5) {
    await focus(bridge);
    await sleep(1300);
    await press(bridge, 'Digit3');
  }
  if (!rEar.includes('JUMP NOW')) {
    await focus(runner);
    for (let j = 0; j < 6 && !rEar.includes('JUMP NOW'); j++, await sleep(60)) rEar = await runner.ev(`document.querySelector('.ear')?.textContent || ''`);
  }
  if (!oVoice.includes('JUMP NOW')) {
    await focus(operator);
    for (let j = 0; j < 6 && !oVoice.includes('JUMP NOW'); j++, await sleep(60)) oVoice = await operator.ev(`document.querySelector('.voice')?.textContent || ''`);
  }
}
check("Bridge's word reaches the Runner's ear", rEar.includes('JUMP NOW'), `ear="${rEar}"`);
check("Bridge's word reaches the Operator's ear", oVoice.includes('JUMP NOW'), `voice="${oVoice}"`);
check('the Bridge is rate-limited to one word at a time', bCool === true);

// --- Operator stamp -> bridge board only
await focus(operator);
await focus(operator);
await operator.ev(`(() => {
  const cv = document.querySelector('#view');
  const r = document.querySelector('.board-region').getBoundingClientRect();
  cv.dispatchEvent(new MouseEvent('click', { bubbles:true, clientX: r.left + r.width*0.72, clientY: r.top + r.height*0.45 }));
  return true;
})()`);
await sleep(600);
await focus(bridge);
const boardFeed = await bridge.ev(`[...document.querySelectorAll('.feed')].map(e=>e.textContent).join(' | ')`);
const stamps = await bridge.ev('window.__relay3d.state.stamps.length');
check("Operator's stamp reaches the Bridge's board", stamps >= 1, `stamps=${stamps} feed="${boardFeed.slice(0, 90)}"`);

// --- audio channel: Runner + Operator hear the gantry, the Bridge is hard-muted
const audioFlags = await runner.ev('({on: window.__relay3d.audioEnabled, update: typeof window.__relay3d.audio.update === "function"})');
const opAudio = await operator.ev('window.__relay3d.audioEnabled');
const brAudio = await bridge.ev('window.__relay3d.audioEnabled');
check(
  'audio is on for Runner + Operator and hard-muted for the deaf Bridge',
  audioFlags.on === true && audioFlags.update === true && opAudio === true && brAudio === false,
  `runner=${JSON.stringify(audioFlags)} operator=${opAudio} bridge=${brAudio}`,
);

// --- Operator knock -> audio for the Runner/Operator, and the knock is rendered
//     as a short cam shake for the Runner and for the Bridge (who sees his cam)
await focus(runner);
await operator.ev('window.__relay3d.ev({type:"knock"})');
let runnerShake = 0;
for (let i = 0; i < 240 && runnerShake <= 0; i++) { // headless renders at ~2 fps
  if (i === 120) await operator.ev('window.__relay3d.ev({type:"knock"})'); // a second knock, if the first frame was missed
  runnerShake = Math.max(runnerShake, await runner.ev('window.__relay3d.shake'));
  await sleep(30);
}
check('Operator knock shakes the Runner cam', runnerShake > 0, `shake=${runnerShake}`);
// a background tab's render loop is throttled, so give the Bridge its own knock while in front
await bridge.send('Page.bringToFront');
await sleep(200);
await operator.ev('window.__relay3d.ev({type:"knock"})');
let bridgeShake = 0;
for (let i = 0; i < 240 && bridgeShake <= 0; i++) {
  if (i === 120 && (await operator.ev('window.__relay3d.state.knocks')) > 0) await operator.ev('window.__relay3d.ev({type:"knock"})');
  bridgeShake = Math.max(bridgeShake, await bridge.ev('window.__relay3d.shake'));
  await sleep(15);
}
const bridgeFlash = await bridge.ev('document.querySelector(".callnow")?.classList.contains("knock") === true');
check('the deaf Bridge sees the same knock shake, with no UI flash', bridgeShake > 0 && bridgeFlash === false, `shake=${bridgeShake} flash=${bridgeFlash}`);

// --- Runner's shout reaches the operator ONLY (the Bridge is deaf)
await focus(runner);
await runner.ev(`(() => { const i = document.querySelector('.shout'); i.value = 'the span is out, I can hear it'; i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); return true; })()`);
await sleep(600);
await focus(operator);
const opSays = await operator.ev(`document.querySelector('.shots').textContent.includes('span is out')`);
await focus(bridge);
const brSays = await bridge.ev(`document.body.innerText.includes('span is out')`);
check("the Runner's voice reaches the Operator", opSays === true);
check('the Runner\'s voice does NOT reach the deaf Bridge', brSays === false);

// --- Bridge chalk -> runner visor, ink spent
await focus(bridge);
const inkBefore = await bridge.ev('window.__relay3d.state.ink');
await press(bridge, 'KeyV');
await sleep(700);
const chalkN = await bridge.ev('window.__relay3d.state.chalk.length');
const inkAfter = await bridge.ev('window.__relay3d.state.ink');
check('chalk crosses the network and spends the shared ink', chalkN >= 1 && inkAfter === inkBefore - 1, `chalk=${chalkN} ink ${inkBefore}->${inkAfter}`);

// --- two-key exit
// (an arm with no key expires after 3 s, and headless tabs render at ~2 fps, so the key is
//  turned first and the lever pulled right after: the rule is the same either way round)
await focus(operator);
await press(operator, 'KeyE');
await sleep(400);
const armedState = await operator.ev('({armed: window.__relay3d.state.exit.armed, open: window.__relay3d.state.exit.open})');
check('Operator alone arms the exit but cannot open it', armedState.armed === true && armedState.open < 0.05, JSON.stringify(armedState));
await bridge.ev(`window.__relay3d.ev({type:'key', down:true})`);
if (!(await operator.ev('window.__relay3d.state.exit.armed'))) await operator.ev(`window.__relay3d.ev({type:'exit.lever'})`);
await sleep(2900);
const opened = await operator.ev('window.__relay3d.state.exit.open');
await bridge.ev(`window.__relay3d.ev({type:'key', down:false})`);
await sleep(1500);
const sealHolds = await operator.ev('window.__relay3d.state.exit.open');
await sleep(2600);
const closedAgain = await operator.ev('window.__relay3d.state.exit.open');
check('Bridge key + Operator lever opens the exit over the network', opened > 0.9, `open=${opened}`);
check('once open, the seal holds ~2.5 s and then slams shut', sealHolds > 0.9 && closedAgain < 0.2, `open after 1.5 s=${sealHolds}, after 4.1 s=${closedAgain}`);

// --- Phase 0: the demo autopilot is not part of the shipped screens
const autoUi = {};
for (const [role, t] of Object.entries(tabs)) autoUi[role] = await t.ev(`!!document.querySelector('.auto input') || window.__relay3d.DEBUG`);
check('no autopilot control on any screen without ?debug=1', !autoUi.runner && !autoUi.operator && !autoUi.bridge, JSON.stringify(autoUi));
await focus(runner);
await press(runner, 'KeyP');
await sleep(400);
check("the Runner's P key does nothing without ?debug=1", (await operator.ev('window.__relay3d.state.runner.auto')) === false);

// --- Phase 0: a key released while the window is unfocused must not stick.
//     Real CDP keyboard input into the Runner tab, then the window loses focus.
const key = (t, type, code, k, vk) => t.send('Input.dispatchKeyEvent', { type, code, key: k, windowsVirtualKeyCode: vk });
// (at a station he only steers, so hold D: the strafe must stop when focus goes)
await focus(runner);
await key(runner, 'keyDown', 'KeyD', 'd', 68);
await sleep(250);
const heldBefore = await runner.ev('window.__relay3d.heldKeys.includes("KeyD")');
await runner.ev('window.dispatchEvent(new Event("blur"))'); // what the OS does when focus moves away
await sleep(400);
const heldAfter = await runner.ev('({keys: window.__relay3d.heldKeys, s: window.__relay3d.input.s})');
const xA = await operator.ev('window.__relay3d.state.runner.x');
await sleep(800);
const xB = await operator.ev('window.__relay3d.state.runner.x');
await key(runner, 'keyUp', 'KeyD', 'd', 68);
check(
  'losing focus releases held keys (his strafe stops)',
  heldBefore === true && heldAfter.keys.length === 0 && heldAfter.s === 0 && Math.abs(xB - xA) < 0.05,
  `held=${heldBefore} after=${JSON.stringify(heldAfter)} x ${xA.toFixed(2)} -> ${xB.toFixed(2)}`,
);
await focus(operator);
await press(operator, 'KeyE'); // the exit is disarmed after the two-key test: arm it
await sleep(300);
await focus(bridge);
await key(bridge, 'keyDown', 'KeyK', 'k', 75);
await sleep(300);
const keyHeld = await operator.ev('window.__relay3d.state.key.held');
await bridge.ev('document.dispatchEvent(new Event("visibilitychange"))');
await bridge.ev('window.dispatchEvent(new Event("blur"))');
await sleep(400);
const keyAfter = await operator.ev('window.__relay3d.state.key.held');
await key(bridge, 'keyUp', 'KeyK', 'k', 75);
check("losing focus lets go of the Bridge's 2nd key", keyHeld === true && keyAfter === false, `held=${keyHeld} -> ${keyAfter}`);
await focus(operator);
await press(operator, 'KeyE'); // disarm again for the full run
await sleep(300);

// --- a full run over the network, on a fresh roll: the server runs the (debug) autopilot,
//     this script plays the Operator from the Operator's tab and the Bridge from the Bridge's
await operator.ev('window.__relay3d.ev({type:"reset"})');
await sleep(400);
await operator.ev('window.__relay3d.ev({type:"auto", on:true})');
let won = false;
let maxZ = 0;
const flags = {};
for (let i = 0; i < 900 && !won; i++) {
  const st = await operator.ev(`(() => { const s = window.__relay3d.state, r = s.runner;
    return { z: r.z, y: r.y, onLift: r.onLift, committed: r.committed, section: s.section, span: s.span.phase, press: s.press.held,
             liftY: s.lift.y, liftMoving: s.lift.moving, armed: s.exit.armed, won: s.won, dead: s.dead, attempt: s.attempt }; })()`);
  maxZ = Math.max(maxZ, st.z);
  if (st.dead || flags.attempt !== st.attempt) for (const k of Object.keys(flags)) delete flags[k];
  flags.attempt = st.attempt;
  const op = (ev) => operator.ev(`window.__relay3d.ev(${JSON.stringify(ev)})`);
  if (st.section === 0 && st.committed && st.span === 'out' && st.z >= 13.2 && !flags.t) (flags.t = 1), await op({ type: 'span.throw' });
  if (st.section === 2 && st.committed && !flags.p) (flags.p = 1), await op({ type: 'press', down: true });
  if (st.section === 2 && st.z > 58.6 && st.press) await op({ type: 'press', down: false });
  if (st.onLift && st.z > 63 && st.liftY < 0 && !st.liftMoving && !flags.l) (flags.l = 1), await op({ type: 'lift.toggle' });
  if (st.section === 3 && !flags.e) {
    flags.e = 1;
    await op({ type: 'exit.lever' });
    await bridge.ev(`window.__relay3d.ev({type:'key', down:true})`);
  }
  if (st.won) won = true;
  await sleep(25);
}
await bridge.ev(`window.__relay3d.ev({type:'key', down:false})`);
const final = await operator.ev('({won: window.__relay3d.state.won, t: window.__relay3d.state.wonTime, lifts: window.__relay3d.state.stats.lifts, deaths: window.__relay3d.state.deaths})');
check('a full run completes over the network (server-authoritative)', won === true, `${JSON.stringify(final)} maxZ=${maxZ.toFixed(1)}`);

// --- Phase 0: RUN AGAIN after a win. Two of the three players vote and the room restarts.
await focus(runner); // its render loop (and so its DOM) only runs while it is in front
let againHot = false;
for (let i = 0; i < 40 && !againHot; i++) {
  againHot = await runner.ev(`document.querySelector('#again')?.classList.contains('hot')`);
  if (!againHot) await sleep(100);
}
const againAll = [];
for (const t of Object.values(tabs)) againAll.push(await t.ev(`!!document.querySelector('#again')`));
check('every screen has a RUN AGAIN button, lit up after the win', againAll.every(Boolean) && againHot === true, `buttons=${againAll} hot=${againHot}`);

// screenshots of the win first, then restart
await focus(runner);
await sleep(400);
writeFileSync(`${SHOTS}/3d-runner.png`, Buffer.from((await runner.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

await focus(operator);
await press(operator, 'KeyR');
await sleep(400);
const half = await bridge.ev(`document.querySelector('#again').textContent`);
const stillWon = await bridge.ev('window.__relay3d.state.won');
await focus(bridge);
await bridge.ev(`document.querySelector('#again').click()`);
let restarted = null;
for (let i = 0; i < 30; i++) {
  await focus(runner);
  restarted = await runner.ev(`({won: window.__relay3d.state.won, z: window.__relay3d.local.runner.z, ink: window.__relay3d.state.ink, knocks: window.__relay3d.state.knocks, deaths: window.__relay3d.state.deaths, chalk: window.__relay3d.state.chalk.length})`);
  if (!restarted.won) break;
  await sleep(100);
}
check('one vote shows 1/2 and does not restart', half.includes('1/2') && stillWon === true, `button="${half}" won=${stillWon}`);
check(
  'the second vote restarts every screen (Runner back at the start, ink + knocks refilled)',
  restarted.won === false && restarted.z < 2.5 && restarted.ink === 6 && restarted.knocks === 3 && restarted.chalk === 0,
  JSON.stringify(restarted),
);

// --- after a win with three players, RUN AGAIN rotated the roles: every tab reloads as
//     the next one (Runner → Operator → Bridge → Runner), and the room fills up again
await sleep(3500);
const nowRole = {};
for (const [was, t] of Object.entries(tabs)) {
  for (let i = 0; i < 40; i++) {
    nowRole[was] = await t.ev('window.__relay3d?.ROLE || null', 2000).catch(() => null);
    if (nowRole[was] && nowRole[was] !== was) break;
    await sleep(250);
  }
}
check('RUN AGAIN after a win rotates every player to the next role', nowRole.runner === 'operator' && nowRole.operator === 'bridge' && nowRole.bridge === 'runner', JSON.stringify(nowRole));
let full = '';
for (let i = 0; i < 40; i++) {
  full = await tabs.runner.ev('(window.__relay3d?.peers || []).map((p) => p.role).sort().join()', 2000).catch(() => '');
  if (full === 'bridge,operator,runner') break;
  await sleep(250);
}
check('...and all three seats are taken again in the same room', full === 'bridge,operator,runner', full);
const runsLogged = await tabs.runner.ev('window.__relay3d.history.length', 5000).catch(() => 0);
check('the finished run is in the room history shown to everyone', runsLogged >= 1, `runs=${runsLogged}`);
// from here on, the tabs hold their new roles
tabs.runner = tabs.bridge;
tabs.bridge = tabs.operator;
tabs.operator = (Object.values({ runner, operator, bridge }).find((t) => t !== tabs.runner && t !== tabs.bridge));
const rot = { runner: tabs.runner, operator: tabs.operator, bridge: tabs.bridge };

// --- screenshots of the three private screens
await focus(rot.operator);
await sleep(400);
writeFileSync(`${SHOTS}/3d-operator.png`, Buffer.from((await rot.operator.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
await focus(rot.bridge);
await sleep(400);
writeFileSync(`${SHOTS}/3d-bridge.png`, Buffer.from((await rot.bridge.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
await focus(rot.runner);
await sleep(600);
writeFileSync(`${SHOTS}/3d-runner.png`, Buffer.from((await rot.runner.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
console.log('\nscreenshots -> shots/3d-{runner,operator,bridge}.png');

const allErrors = [
  ...runner.errors.map((e) => `runner: ${e}`),
  ...operator.errors.map((e) => `operator: ${e}`),
  ...bridge.errors.map((e) => `bridge: ${e}`),
];
check('no page errors on any of the three screens', allErrors.length === 0, allErrors.slice(0, 4).join(' | '));

for (const t of Object.values(tabs)) t.close();
for (const t of Object.values(tabs)) await fetch(`${CDP}/json/close/${t.id}`, { method: 'PUT' }).catch(() => {});

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
