// Headless play-test over the Chrome DevTools Protocol. No npm deps needed
// (Node 22+ has a global WebSocket and fetch).
//
//   1. chromium --headless=new --remote-debugging-port=9222 ... play.html?mode=solo
//   2. node test/browser.mjs
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || '9222';
const OUT = new URL('../shots/', import.meta.url).pathname;

// always open a fresh tab: leftover tabs from other test runs must not be reused
const room = `solo-${Math.random().toString(36).slice(2, 7)}`;
const page = await (
  await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`http://127.0.0.1:8099/play.html?mode=solo&room=${room}`)}`, { method: 'PUT' })
).json();

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let id = 0;
const waiting = new Map();
const errors = [];
const logs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) {
    const { resolve, reject } = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const txt = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
    logs.push(`${msg.params.type}: ${txt}`);
    if (msg.params.type === 'error') errors.push(txt);
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    errors.push(`${msg.params.entry.url || ''} ${msg.params.entry.text}`.trim());
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    waiting.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

const evalJS = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(600);

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const key = (code, type = 'keydown') =>
  evalJS(`window.dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, {code: ${JSON.stringify(code)}, bubbles:true}))`);

// ---------------------------------------------------------------- boot
for (let i = 0; i < 40; i++) {
  if (await evalJS('!!window.__relay && !!document.querySelector(".panel.runner")')) break;
  await sleep(100);
}
check('app boots, three panels exist', (await evalJS('document.querySelectorAll(".panel").length')) === 3);

// ---------------------------------------------------- the relay itself
await key('Digit3'); // the Bridge says "JUMP NOW"
await sleep(120);
const runnerEar = await evalJS('document.querySelector(".panel.runner .ticker").textContent');
const opVoice = await evalJS('document.querySelector(".panel.operator .ticker").textContent');
const bridgeBoard = await evalJS('document.querySelector(".panel.bridge .beat").textContent');
check('Bridge words reach the Runner\'s ear', runnerEar.includes('JUMP NOW'), `ear="${runnerEar}"`);
check('Bridge words reach the Operator\'s ear', opVoice.includes('JUMP NOW'), `voice="${opVoice}"`);
check('Bridge sees a next-beat countdown', /GAP/.test(bridgeBoard), bridgeBoard.replace(/\s+/g, ' ').slice(0, 60));

// operator stamp -> bridge board only
await evalJS(`(() => {
  const cv = document.querySelector('.panel.operator canvas.map');
  const r = cv.getBoundingClientRect();
  cv.dispatchEvent(new MouseEvent('click', {clientX: r.left + r.width*0.3, clientY: r.top + r.height*0.7, bubbles:true}));
})()`);
await sleep(150);
const boardFeed = await evalJS('document.querySelector(".panel.bridge .feed").textContent');
check('Operator stamp appears on the Bridge\'s board', boardFeed.length > 2, `feed="${boardFeed}"`);
const runnerSawStamp = await evalJS('document.querySelector(".panel.runner").textContent.includes("▲")');
check('Runner never sees the Operator\'s stamps', !runnerSawStamp);

// knock -> shake on the bridge's cam only
await evalJS('window.__relay.emit({type:"knock"})');
await sleep(100);
const knocked = await evalJS('document.querySelectorAll(".panel.bridge .stage.knock").length');
check('Knock reaches the Bridge (rumble)', knocked === 1 && (await evalJS('window.__relay.state.knocks')) === 2);

// -------------------------------------------------------------- the run
await key('KeyP'); // demo autopilot
await sleep(150);
check('autopilot engages', await evalJS('window.__relay.state.runner.auto === true'));

// wait until the runner is inside the call window for the gap, then throw
for (let i = 0; i < 200; i++) {
  const x = await evalJS('window.__relay.state.runner.x');
  if (x > 7 && x < 15) break;
  if (await evalJS('window.__relay.state.dead')) break;
  await sleep(50);
}
const xAtThrow = await evalJS('window.__relay.state.runner.x');
await key('KeyB'); // operator throws the slide bridge
await sleep(80);
check('throw accepted (span moving/extended)', ['moving', 'extended'].includes(await evalJS('window.__relay.state.span.phase')), `x=${xAtThrow.toFixed(1)} phase=${await evalJS('window.__relay.state.span.phase')}`);

// did he get across?
let crossed = false;
for (let i = 0; i < 200; i++) {
  const x = await evalJS('window.__relay.state.runner.x');
  if (x > 30) { crossed = true; break; }
  if (await evalJS('window.__relay.state.dead')) break;
  await sleep(50);
}
check('Runner crosses the gap on the thrown span', crossed, `deaths=${await evalJS('window.__relay.state.deaths')}`);

// the phantom floor: warn him in time (this is what a human Bridge would do)
for (let i = 0; i < 300; i++) {
  const x = await evalJS('window.__relay.state.runner.x');
  if (x > 39 && x < 42.2) break;
  if (await evalJS('window.__relay.state.dead')) break;
  await sleep(25);
}
await key('Digit3'); // "JUMP NOW"
let survivedPit = false;
for (let i = 0; i < 200; i++) {
  const st = await evalJS('({x: window.__relay.state.runner.x, dead: window.__relay.state.dead})');
  if (st.x > 50) { survivedPit = true; break; }
  if (st.dead) break;
  await sleep(50);
}
check('Camo pit cleared when the Bridge calls JUMP in time', survivedPit, `deaths=${await evalJS('window.__relay.state.deaths')}`);

// two-key exit
for (let i = 0; i < 300; i++) {
  if ((await evalJS('window.__relay.state.runner.x')) > 56) break;
  await sleep(50);
}
await key('KeyE'); // operator arms
await sleep(100);
check('exit armed by the Operator alone is not enough', (await evalJS('window.__relay.state.exit.armed === true && window.__relay.state.exit.open === false')));
await key('KeyK'); // bridge holds the second key
let won = false;
for (let i = 0; i < 100; i++) {
  if (await evalJS('window.__relay.state.won')) { won = true; break; }
  await sleep(60);
}
await key('KeyK', 'keyup');
check('two-key rule: Bridge key + Operator lever opens the exit', won);
const stats = await evalJS('({won: window.__relay.state.won, t: window.__relay.state.wonTime, deaths: window.__relay.state.deaths, phrases: window.__relay.state.stats.phrases, ink: window.__relay.state.ink})');
check('level completed with no deaths', stats.won && stats.deaths === 0, JSON.stringify(stats));

// --------------------------------------------------------------- shots
await sleep(200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${OUT}relay-after-win.png`, Buffer.from(shot.data, 'base64'));
console.log(`\nscreenshot -> shots/relay-after-win.png`);

check('no page errors', errors.filter((e) => !/favicon/.test(e)).length === 0, errors.filter((e) => !/favicon/.test(e)).slice(0, 4).join(' | '));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
ws.close();
await fetch(`http://127.0.0.1:${PORT}/json/close/${page.id}`, { method: 'PUT' }).catch(() => {});
process.exit(failed.length ? 1 : 0);
