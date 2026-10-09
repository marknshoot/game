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
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
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
await sleep(600);
await focus(runner);
const rEar = await runner.ev(`document.querySelector('.ear')?.textContent || ''`);
await focus(operator);
const oVoice = await operator.ev(`document.querySelector('.voice')?.textContent || ''`);
await focus(bridge);
const bCool = await bridge.ev(`document.querySelector('.btn.phr')?.classList.contains('cool')`);
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
for (let i = 0; i < 40 && runnerShake <= 0; i++) {
  runnerShake = Math.max(runnerShake, await runner.ev('window.__relay3d.shake'));
  await sleep(30);
}
check('Operator knock shakes the Runner cam', runnerShake > 0, `shake=${runnerShake}`);
await bridge.send('Page.bringToFront');
let bridgeShake = 0;
for (let i = 0; i < 40 && bridgeShake <= 0; i++) {
  bridgeShake = Math.max(bridgeShake, await bridge.ev('window.__relay3d.shake'));
  await sleep(20);
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
await focus(operator);
await press(operator, 'KeyE');
await sleep(500);
const armedState = await runner.ev('({armed: window.__relay3d.state.exit.armed, open: window.__relay3d.state.exit.open})');
check('Operator alone arms the exit but cannot open it', armedState.armed === true && armedState.open < 0.05, JSON.stringify(armedState));
await focus(bridge);
await bridge.ev(`window.__relay3d.ev({type:'key', down:true})`);
await sleep(2900);
const opened = await runner.ev('window.__relay3d.state.exit.open');
await bridge.ev(`window.__relay3d.ev({type:'key', down:false})`);
await sleep(1500);
const closedAgain = await runner.ev('window.__relay3d.state.exit.open');
check('Bridge key + Operator lever opens the exit over the network', opened > 0.9, `open=${opened}`);
check('releasing the key closes the door again (hold-to-keep-open)', closedAgain < 0.2, `open=${closedAgain}`);

// --- a full run over the network: the Operator's levers are driven from this
//     script (standing in for a human) while the server runs the autopilot.
await focus(operator);
await operator.ev('window.__relay3d.ev({type:"auto", on:true})');
let won = false;
let maxZ = 0;
let threw = false;
let lastLift = 0;
let armed = false;
for (let i = 0; i < 260; i++) {
  const st = await operator.ev('({z: window.__relay3d.state.runner.z, y: window.__relay3d.state.runner.y, onLift: window.__relay3d.state.runner.onLift, span: window.__relay3d.state.span.phase, liftY: window.__relay3d.state.lift.y, armed: window.__relay3d.state.exit.armed, won: window.__relay3d.state.won, deaths: window.__relay3d.state.deaths})');
  maxZ = Math.max(maxZ, st.z);
  if (!threw && st.span === 'out' && st.z >= 5 && st.z <= 13) {
    await operator.ev('window.__relay3d.ev({type:"span.throw"})');
    threw = true;
  }
  // stand-in for a human Operator who is being told what the Bridge can see:
  // raise it when he is on the deck, bring it back down when he is waiting next to it
  const now = Date.now();
  if (now - lastLift > 900) {
    if (st.onLift && st.liftY < 0) {
      await operator.ev('window.__relay3d.ev({type:"lift.toggle"})');
      lastLift = now;
    } else if (!st.onLift && st.liftY > -0.1 && st.z > 47 && st.z < 51.6) {
      await operator.ev('window.__relay3d.ev({type:"lift.toggle"})');
      lastLift = now;
    }
  }
  // the lever is a toggle: only touch it if it is actually unarmed
  if (st.z > 61.5 && st.y > 3.4 && !st.armed) {
    await operator.ev('window.__relay3d.ev({type:"exit.lever"})');
  }
  await operator.ev(`window.__relay3d.ev({type:'key', down:${st.z > 61.5 && st.y > 3.4 && (st.armed || armed)}})`);
  if (st.armed) armed = true;
  if (st.won) {
    won = true;
    break;
  }
  await sleep(150);
}
const final = await operator.ev('({won: window.__relay3d.state.won, t: window.__relay3d.state.wonTime, lifts: window.__relay3d.state.stats.lifts, deaths: window.__relay3d.state.deaths})');
check('a full run completes over the network (server-authoritative)', won === true, `${JSON.stringify(final)} maxZ=${maxZ.toFixed(1)}`);

// --- screenshots of the three private screens
await focus(runner);
await sleep(400);
writeFileSync(`${SHOTS}/3d-runner.png`, Buffer.from((await runner.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
await focus(operator);
await sleep(400);
writeFileSync(`${SHOTS}/3d-operator.png`, Buffer.from((await operator.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
await focus(bridge);
await sleep(400);
writeFileSync(`${SHOTS}/3d-bridge.png`, Buffer.from((await bridge.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
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
