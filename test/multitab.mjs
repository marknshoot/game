// Three real browser tabs, one game: verifies host election and the relay chain
// across windows (which is how the game is actually played).
import { setTimeout as sleep } from 'node:timers/promises';

const CDP = `http://127.0.0.1:${process.env.CDP_PORT || '9222'}`;
const BASE = process.env.BASE || 'http://127.0.0.1:8099';

async function newTab(url) {
  const r = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const t = await r.json();
  return t;
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const waiting = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result.value;
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  return { ws, ev, errors, close: () => ws.close(), send };
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const tabs = [];
for (const role of ['runner', 'operator', 'bridge']) {
  const t = await newTab(`${BASE}/play.html?mode=net&role=${role}&room=test`);
  tabs.push(await connect(t));
  await sleep(700);
}
const [runner, operator, bridge] = tabs;

for (const [i, t] of tabs.entries()) {
  for (let k = 0; k < 40; k++) {
    if (await t.ev('!!window.__relay')) break;
    await sleep(100);
  }
}

const hostOf = async (t) => t.ev('window.__relay.net ? window.__relay.net.isHost : null');
check('Runner tab owns the simulation', (await hostOf(runner)) === true);
check('Operator tab is a client', (await hostOf(operator)) === false);
check('Bridge tab is a client', (await hostOf(bridge)) === false);

const press = (t, code) =>
  t.ev(`window.dispatchEvent(new KeyboardEvent('keydown', {code:${JSON.stringify(code)}, bubbles:true}))`);

// Chromium throttles hidden tabs, so real play means visible windows. Bring a tab
// forward before inspecting it, like a player looking at that screen.
const focus = async (t) => {
  await t.send('Page.bringToFront');
  await sleep(120);
};

// --- Operator -> world: the throw must appear in the Runner's tab
await press(operator, 'KeyB');
await sleep(400);
await focus(runner);
const phaseInRunner = await runner.ev('window.__relay.state.span.phase');
check('Operator lever crosses into the Runner\'s simulation', ['moving', 'extended'].includes(phaseInRunner), `phase=${phaseInRunner}`);

// --- Bridge -> words: the phrase must appear in both other tabs
await press(bridge, 'Digit1');
await sleep(400);
await focus(operator);
const oTicker = await operator.ev('document.querySelector(".panel.operator .ticker").textContent');
await focus(runner);
const rPhrase = await runner.ev('window.__relay.state.phrases.at(-1)?.text');
check('Bridge words reach the Runner\'s tab', rPhrase === 'GO', `phrase=${rPhrase}`);
check('Bridge words reach the Operator\'s tab', oTicker.includes('GO'), `ticker="${oTicker}"`);

// --- Operator stamp -> bridge board only
await operator.ev(`(() => {
  const cv = document.querySelector('.panel.operator canvas.map');
  const r = cv.getBoundingClientRect();
  cv.dispatchEvent(new MouseEvent('click', {clientX: r.left + r.width*0.75, clientY: r.top + r.height*0.7, bubbles:true}));
  return true;
})()`);
await sleep(500);
await focus(bridge);
const feed = await bridge.ev('document.querySelector(".panel.bridge .feed").textContent');
check('Operator stamp reaches the Bridge\'s board', feed.trim().length > 2, `feed="${feed.trim()}"`);
await focus(runner);
const runnerText = await runner.ev('document.querySelector(".panel.runner").textContent');
check('Runner\'s screen never contains Operator stamps', !/▲\s*[A-L]/.test(runnerText));

// --- Bridge knock -> rumble on the bridge only
await press(operator, 'KeyN');
await sleep(500);
await focus(operator);
check('Knock counts down on the Operator', (await operator.ev('window.__relay.state.knocks')) === 2);

// --- the Bridge's chalk appears in the world view
await focus(bridge);
const inkBefore = await bridge.ev('window.__relay.state.ink');
await press(bridge, 'KeyV');
// the Runner's window owns the simulation: give it foreground so the host is not throttled
await focus(runner);
await sleep(600);
await focus(bridge);
check('Bridge chalk is spent from the shared ink pool', (await bridge.ev('window.__relay.state.ink')) === inkBefore - 1);
await focus(runner);
check('Chalk exists in the Runner\'s world state', (await runner.ev('window.__relay.state.chalk.length')) >= 1);

// --- host failover: kill the Runner tab, the Operator must take over
const operatorHostBefore = await hostOf(operator);
await fetch(`${CDP}/json/close/${(await fetch(`${CDP}/json/list`).then((r) => r.json())).find((t) => t.url.includes('role=runner'))?.id}`, { method: 'PUT' });
runner.close();
for (let i = 0; i < 40; i++) {
  if (await hostOf(operator)) break;
  await sleep(250);
}
const opHost = await hostOf(operator);
const brHost = await hostOf(bridge);
check('Simulation survives the Runner tab dying (somebody owns it)', opHost === true || brHost === true, `operator=${opHost} bridge=${brHost}`);
await focus(operator);
const t1 = await operator.ev('window.__relay.state.t');
await sleep(900);
const t2 = await operator.ev('window.__relay.state.t');
check('New host keeps time advancing', t2 > t1, `${t1.toFixed(2)} -> ${t2.toFixed(2)}`);

// --- the events still worked in the tab that died
check('no page errors in any tab', tabs.every((t) => t.errors.filter((e) => !/favicon/.test(e)).length === 0), [runner, operator, bridge].flatMap((t) => t.errors).slice(0, 3).join(' | '));

for (const t of [operator, bridge]) t.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
