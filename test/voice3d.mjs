// RELAY 3D — real voice, in real browsers. Three Chrome tabs with Chrome's fake microphone
// (a periodic beep) talk over real WebRTC, signaled by the server. The Bridge joins through
// the https LAN address, the way a second laptop would. Checks that audio actually flows
// along the three allowed links, only while push-to-talk is held, and nowhere else.
//
//   Chrome needs: --use-fake-ui-for-media-stream --use-fake-device-for-media-stream
//                 --autoplay-policy=no-user-gesture-required --ignore-certificate-errors
import { setTimeout as sleep } from 'node:timers/promises';
import os from 'node:os';

const CDP = `http://127.0.0.1:${process.env.CDP_PORT || '9224'}`;
const BASE = process.env.BASE || 'http://127.0.0.1:8792';
const HTTPS_PORT = process.env.HTTPS_PORT || '9792';
const LAN = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

async function tab(url, preload = '') {
  const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const wait = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) {
      wait.get(m.id)(m);
      wait.delete(m.id);
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  if (preload) await send('Page.addScriptToEvaluateOnNewDocument', { source: preload });
  await send('Page.navigate', { url });
  const key = (type, code, key, vk) => send('Input.dispatchKeyEvent', { type, code, key, windowsVirtualKeyCode: vk });
  return { send, ev, key, errors, id: t.id, front: () => send('Page.bringToFront') };
}
const until = async (fn, ms = 8000, step = 150) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
};

// count every getUserMedia call: the mute Operator's page must never make one
const GUM_SPY = `(() => { window.__gum = 0; const md = navigator.mediaDevices; if (!md) return;
  const orig = md.getUserMedia.bind(md); md.getUserMedia = (c) => { window.__gum++; return orig(c); }; })();`;

const ROOM = `VB${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
const httpsBase = LAN ? `https://${LAN}:${HTTPS_PORT}` : `https://127.0.0.1:${HTTPS_PORT}`;
console.log(`room ${ROOM}   bridge via ${httpsBase}\n`);

const R = await tab(`${BASE}/play.html?role=runner&room=${ROOM}`, GUM_SPY);
const O = await tab(`${BASE}/play.html?role=operator&room=${ROOM}`, GUM_SPY);
const B = await tab(`${httpsBase}/play.html?role=bridge&room=${ROOM}`, GUM_SPY);
const tabs = { runner: R, operator: O, bridge: B };

const vs = (t) => t.ev(`(() => { const v = window.__relay3d?.voice; if (!v) return null;
  return { mic: v.state.mic, live: v.state.live, talking: v.state.talking, links: v.links(), secure: isSecureContext, gum: window.__gum,
           audios: document.querySelectorAll('audio[data-voice]').length, bar: document.querySelector('#voicebar')?.innerText || '' }; })()`);
const stats = (t) => t.ev(`window.__relay3d.voice.stats()`);
const energyIn = async (t, from) => {
  const s = await stats(t);
  const r = s.find((x) => x.dir === 'in' && x.id.startsWith(from + '>'));
  return r ? { energy: r.energy || 0, bytes: r.bytes, direction: r.direction, jitterMs: r.jitterMs } : null;
};

// Chrome holds getUserMedia for a hidden tab; each speaker brings his own window up once
for (const t of [R, B]) {
  await t.front();
  await until(async () => (await vs(t))?.mic === 'on', 6000, 200);
}

// --------------------------------------------------------------- links up
const want = { runner: ['bridge>runner:in', 'runner>operator:out'], operator: ['bridge>operator:in', 'runner>operator:in'], bridge: ['bridge>operator:out', 'bridge>runner:out'] };
const sig = (v) => (v?.links || []).filter((l) => l.conn === 'connected').map((l) => `${l.id}:${l.dir}`).sort().join();
const up = await until(async () => {
  for (const [r, t] of Object.entries(tabs)) if (sig(await vs(t)) !== want[r].join()) return false;
  return true;
}, 20000, 300);
const V = {};
for (const [r, t] of Object.entries(tabs)) V[r] = await vs(t);
check('the Bridge page on the https LAN address is a secure context (mic allowed)', V.bridge.secure === true && V.bridge.mic === 'on', `secure=${V.bridge.secure} mic=${V.bridge.mic}`);
check('exactly the three allowed links connect over real WebRTC', up, Object.entries(V).map(([r, v]) => `${r}[${sig(v)}]`).join(' '));
check('the mute Operator never asks for a microphone', V.operator.mic === 'none' && V.operator.gum === 0, `mic=${V.operator.mic} getUserMedia calls=${V.operator.gum}`);
check('the deaf Bridge has no incoming voice and no audio element', V.bridge.audios === 0 && !V.bridge.links.some((l) => l.dir === 'in'), `audios=${V.bridge.audios}`);
check('Runner plays one voice (Bridge), Operator plays two (Bridge, Runner)', V.runner.audios === 1 && V.operator.audios === 2, `runner=${V.runner.audios} operator=${V.operator.audios}`);
const dirs = {
  rIn: (await energyIn(R, 'bridge'))?.direction,
  oIn: (await energyIn(O, 'runner'))?.direction,
  bOut: (await stats(B)).map((x) => x.direction),
};
check('negotiated directions are one-way (sendonly at the speaker, recvonly at the listener)', dirs.rIn === 'recvonly' && dirs.oIn === 'recvonly' && dirs.bOut.every((d) => d === 'sendonly'), JSON.stringify(dirs));

// --------------------------------------------------------------- PTT
// Energy at the listener over a window of time: a held key carries the fake mic's beep,
// a released one sends silence.
async function energyOver(t, from, ms) {
  const a = (await energyIn(t, from)).energy;
  await sleep(ms);
  return (await energyIn(t, from)).energy - a;
}
const quietR = await energyOver(R, 'bridge', 2500);
const quietO = await energyOver(O, 'runner', 1500);
check('push-to-talk: nothing is heard while nobody holds the key', quietR < 1e-4 && quietO < 1e-4, `runner hears ${quietR.toExponential(1)}, operator hears runner ${quietO.toExponential(1)}`);

await B.front();
await B.key('keyDown', 'Space', ' ', 32);
await sleep(300);
const lit = { r: (await vs(R)).talking, o: (await vs(O)).talking, bLive: (await vs(B)).live };
const loudR = await energyOver(R, 'bridge', 2500);
// a background tab's receive stats can lag: take the best of up to three windows
let loudO = 0;
for (let i = 0; i < 3 && loudO <= 1e-3; i++) loudO = Math.max(loudO, await energyOver(O, 'bridge', 1500));
await B.key('keyUp', 'Space', ' ', 32);
check('the Bridge holds SPACE: his light comes on for both listeners', lit.bLive && lit.r.bridge === true && lit.o.bridge === true, JSON.stringify(lit));
check('...and his voice reaches the Runner and the Operator', loudR > 1e-3 && loudO > 1e-3, `runner ${loudR.toExponential(1)}, operator ${loudO.toExponential(1)}`);
const jitter = (await energyIn(R, 'bridge')).jitterMs;
check('voice delay on the LAN is low (jitter buffer < 150 ms)', jitter > 0 && jitter < 150, `${jitter} ms (+ ~20 ms Opus frame, + network)`);
// the Bridge's SPACE is push-to-talk only: it must not have held the key or chalked
const bs = await B.ev('({chalk: __relay3d.state.chalk.length, key: __relay3d.state.key.held})');
check("the Bridge's SPACE is only push-to-talk (no key, no chalk)", bs.chalk === 0 && bs.key === false, JSON.stringify(bs));
await sleep(900); // let the jitter buffer drain the last of the beep
const after = await energyOver(R, 'bridge', 1500);
check('releasing SPACE silences him again', after < 1e-4 && (await vs(R)).talking.bridge === false, after.toExponential(1));

await R.front();
await R.key('keyDown', 'ShiftLeft', 'Shift', 16);
await sleep(300);
const rLit = { o: (await vs(O)).talking.runner, b: (await vs(B)).talking.runner };
let rLoud = 0;
for (let i = 0; i < 3 && rLoud <= 1e-3; i++) rLoud = Math.max(rLoud, await energyOver(O, 'runner', 1500));
// blur while holding: the key-up never arrives; losing focus must release the mic
await R.ev('window.dispatchEvent(new Event("blur"))');
await sleep(400);
const rBlur = { live: (await vs(R)).live, light: (await vs(O)).talking.runner };
await R.key('keyUp', 'ShiftLeft', 'Shift', 16);
check("the Runner holds SHIFT: the Operator sees his light and hears him", rLit.o === true && rLoud > 1e-3, `light=${rLit.o} energy=${rLoud.toExponential(1)}`);
check("the deaf Bridge gets no light for the Runner", rLit.b === undefined || rLit.b === false);
check('losing focus while talking closes the mic', rBlur.live === false && rBlur.light === false, JSON.stringify(rBlur));

await R.key('keyDown', 'KeyM', 'm', 77);
await R.key('keyUp', 'KeyM', 'm', 77);
await sleep(300);
const open = await energyOver(O, 'runner', 2000);
const openBar = (await vs(R)).bar;
await R.key('keyDown', 'KeyM', 'm', 77);
await R.key('keyUp', 'KeyM', 'm', 77);
await sleep(300);
check('M toggles an open mic (and the HUD says so)', open > 1e-3 && /OPEN MIC/.test(openBar) && (await vs(R)).live === false, `energy=${open.toExponential(1)}`);

// --------------------------------------------------------------- reconnect
// the Bridge reloads his tab (new id): the Runner and Operator get his voice back
await B.send('Page.reload');
await sleep(300);
await B.front(); // Chrome holds getUserMedia until the tab is visible; a player reloading is looking at it
const back = await until(async () => sig(await vs(R)) === want.runner.join() && sig(await vs(O)) === want.operator.join() && sig(await vs(B)) === want.bridge.join(), 20000, 400);
if (!back) console.log('      bridge after reload:', JSON.stringify(await vs(B)), await B.ev('document.body.innerText.slice(0,200)'));
check('a Bridge who reloads is heard again without anyone else doing anything', back, `runner[${sig(await vs(R))}] operator[${sig(await vs(O))}]`);

// --------------------------------------------------------------- insecure page
if (LAN) {
  const P = await tab(`http://${LAN}:${new URL(BASE).port}/play.html?role=runner&room=${ROOM}X`);
  await P.front();
  // the link needs /config.json (the https port): wait for the anchor, not just the text
  await until(async () => (await vs(P))?.bar?.includes('https') && (await P.ev(`!!document.querySelector('#voicebar a')`)), 15000);
  const pv = await vs(P);
  if (pv?.mic !== 'insecure') console.log('      http page voice state:', JSON.stringify(pv), JSON.stringify(P.errors));
  const href = await P.ev(`document.querySelector('#voicebar a')?.href || ''`);
  check('on plain http over the LAN the HUD explains and links the https address', pv.mic === 'insecure' && href.startsWith(`https://${LAN}:${HTTPS_PORT}/play.html`), href);
  await fetch(`${CDP}/json/close/${P.id}`, { method: 'PUT' }).catch(() => {});
}

const errs = Object.entries(tabs).flatMap(([r, t]) => t.errors.map((e) => `${r}: ${e}`));
check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
for (const t of Object.values(tabs)) await fetch(`${CDP}/json/close/${t.id}`, { method: 'PUT' }).catch(() => {});

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
