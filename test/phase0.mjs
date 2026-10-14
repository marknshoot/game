// RELAY 3D — Phase 0 integrity checks, over real WebSockets against a NON-debug server.
// The rules of the game (who may act, who may speak) are server rules, so they are
// tested at the protocol level: no browser, every message is one a modified client could send.
//
//   WS=ws://127.0.0.1:8792/ws node test/phase0.mjs
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import crypto from 'node:crypto';

const WS = process.env.WS || 'ws://127.0.0.1:8792/ws';
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
};

function client(room, role) {
  const ws = new WebSocket(WS);
  const c = { ws, role, snap: null, bytes: [], votes: null, resets: 0, says: [], err: null, closed: false };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'snap') {
      c.snap = m.s;
      c.bytes.push(e.data.length);
    }
    if (m.t === 'welcome') {
      c.snap = m.snapshot;
      c.debug = m.debug;
      c.welcomed = true;
      c.welcomeRole = m.role;
    }
    if (m.t === 'votes') c.votes = m;
    if (m.t === 'reset') {
      c.resets++;
      c.snap = m.snapshot;
    }
    if (m.t === 'say') c.says.push(m.text);
    if (m.t === 'error') c.err = m;
  };
  ws.onclose = () => (c.closed = true);
  c.ready = new Promise((r) => (ws.onopen = () => (ws.send(JSON.stringify({ t: 'join', room, role, name: role })), r())));
  c.ev = (ev) => ws.send(JSON.stringify({ t: 'ev', ev }));
  c.input = (i) => ws.send(JSON.stringify({ t: 'input', yaw: 0, f: 0, s: 0, jump: false, ...i }));
  c.vote = (on = true) => ws.send(JSON.stringify({ t: 'restart', on }));
  c.say = (text) => ws.send(JSON.stringify({ t: 'say', text }));
  c.close = () => ws.close();
  return c;
}
const room = (tag) => `${tag}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
async function team(tag, roles = ['runner', 'operator', 'bridge']) {
  const code = room(tag);
  const out = {};
  for (const r of roles) out[r] = client(code, r);
  await Promise.all(Object.values(out).map((c) => c.ready));
  await until(() => Object.values(out).every((c) => c.snap));
  await sleep(100);
  return out;
}

console.log('=== RELAY 3D — Phase 0: integrity over the wire ===\n');

// ------------------------------------------------------------ role authority
{
  const { runner } = await team('SOLO', ['runner']);
  check('server reports debug mode off', runner.debug === false);
  // a Runner alone sends every lever, the autopilot, the key, chalk and a stamp
  for (const type of ['auto', 'span.throw', 'lift.toggle', 'exit.lever', 'chalk', 'stamp', 'knock']) {
    runner.ev({ type, on: true, text: 'GO', x: 0, y: 0, z: 10, icon: '▲' });
  }
  runner.ev({ type: 'key', down: true });
  await sleep(500);
  const s = runner.snap;
  check(
    'a Runner alone cannot pull any lever, chalk, stamp, knock or hold the key',
    s.span.phase === 'out' && !s.lift.moving && s.lift.y < -0.3 && !s.exit.armed && !s.key.held && s.chalk.length === 0 && s.stamps.length === 0 && s.knocks === 3,
    `span=${s.span.phase} lift=${s.lift.y} armed=${s.exit.armed} key=${s.key.held} chalk=${s.chalk.length} knocks=${s.knocks}`,
  );
  check('the autopilot is refused without --debug', s.runner.auto === false && s.runner.z < 2.1, `auto=${s.runner.auto} z=${s.runner.z}`);
  runner.close();
}
{
  const { runner, operator, bridge } = await team('ROLE');
  operator.ev({ type: 'phrase', text: 'GO GO GO' }); // text chat is gone: talking is voice only
  operator.ev({ type: 'chalk', x: 0, y: 0, z: 10 });
  operator.ev({ type: 'key', down: true });
  bridge.ev({ type: 'span.throw' });
  bridge.ev({ type: 'lift.toggle' });
  bridge.ev({ type: 'exit.lever' });
  bridge.ev({ type: 'knock' });
  bridge.ev({ type: 'stamp', icon: '▲', x: 0, z: 9 });
  operator.say('i can talk');
  bridge.say('i can hear');
  runner.say('typed chat');
  await sleep(500);
  const s = runner.snap;
  check('there is no text chat: no phrases in the state, every "say" goes nowhere', !('phrases' in s) && !('phraseCd' in s));
  check("the Operator cannot chalk or hold the Bridge's key", s.chalk.length === 0 && !s.key.held);
  check("the Bridge cannot pull the Operator's levers, knock or stamp", s.span.phase === 'out' && !s.lift.moving && !s.exit.armed && s.knocks === 3 && s.stamps.length === 0);
  check('...not even the Runner\'s typed shout reaches anyone', operator.says.length === 0 && runner.says.length === 0 && bridge.says.length === 0);

  // ...and each role's own powers still work
  operator.ev({ type: 'span.throw' });
  bridge.ev({ type: 'chalk', x: 0, y: 0, z: 12, dir: 'forward' });
  operator.ev({ type: 'stamp', icon: '✓', x: 0, z: 33 });
  await sleep(400);
  const s2 = runner.snap;
  check(
    'each role keeps its own powers',
    s2.span.phase !== 'out' && s2.chalk.length === 1 && s2.stamps.length === 1,
    `span=${s2.span.phase} chalk=${s2.chalk.length} stamps=${s2.stamps.length}`,
  );

  // untrusted payloads must not poison the sim
  bridge.ev({ type: 'chalk', x: 'NaN', y: {}, z: 1e9, dir: '<img onerror=alert(1)>' });
  await sleep(300);
  const ck = runner.snap.chalk.at(-1);
  check('garbage chalk payloads are clamped and sanitized', Number.isFinite(ck.x) && Number.isFinite(ck.y) && ck.z <= 90 && ck.dir === 'forward', JSON.stringify(ck));

  // a Bridge that disconnects mid-hold releases the key
  operator.ev({ type: 'exit.lever' });
  bridge.ev({ type: 'key', down: true });
  await sleep(300);
  const held = runner.snap.key.held;
  bridge.close();
  await until(() => runner.snap && runner.snap.key.held === false, 2000);
  check('a Bridge that disconnects lets go of the key', held === true && runner.snap.key.held === false);
  runner.close();
  operator.close();
}

// ------------------------------------------------------------------ inspector
{
  // a full room takes one inspector: he gets the snapshots and can do nothing with them
  const code = room('INSP');
  const runner = client(code, 'runner'), operator = client(code, 'operator'), bridge = client(code, 'bridge');
  await Promise.all([runner.ready, operator.ready, bridge.ready]);
  const insp = client(code, 'inspector');
  await insp.ready;
  await until(() => insp.snap && insp.welcomed);
  check('a full room still seats an inspector, who gets the live state', !!insp.snap && !insp.err && insp.welcomeRole === 'inspector', JSON.stringify(insp.err));
  const second = client(code, 'inspector');
  await second.ready;
  await until(() => second.err, 2000);
  check('...but only one inspector per room', second.err?.code === 'inspector_taken', JSON.stringify(second.err));
  second.close();
  for (const type of ['span.throw', 'press', 'lift.toggle', 'exit.lever', 'knock', 'stamp', 'chalk', 'auto', 'reset']) insp.ev({ type, down: true, on: true, x: 0, y: 0, z: 10, icon: '▲' });
  insp.ev({ type: 'key', down: true });
  insp.input({ f: 1, s: 1 });
  insp.vote(true);
  await sleep(500);
  const s = operator.snap;
  check(
    'the inspector cannot pull a lever, chalk, stamp, knock, hold the key, move the Runner or vote',
    s.span.phase === 'out' && !s.lift.moving && !s.exit.armed && !s.key.held && s.press.phase === 'down' && s.knocks === 3 && !s.chalk.length && !s.stamps.length && Math.abs(s.runner.x) < 0.01 && !s.runner.committed && (operator.votes?.roles?.length ?? 0) === 0,
    `span=${s.span.phase} press=${s.press.phase} x=${s.runner.x} votes=${JSON.stringify(operator.votes?.roles)}`,
  );
  check('the inspector does not count towards the restart vote (2 of the 3 players)', operator.votes?.need === 2 || operator.votes == null);
  const seats = await fetch(WS.replace('ws://', 'http://').replace('/ws', `/room.json?room=${code}`)).then((r) => r.json());
  check('the lobby can see the room is full and the inspector seat taken', seats.taken.length === 3 && seats.inspector === true, JSON.stringify(seats));
  for (const c of [runner, operator, bridge, insp]) c.close();
}

// -------------------------------------------------------------- restart vote
{
  const { runner, operator, bridge } = await team('VOTE');
  bridge.ev({ type: 'chalk', x: 0, y: 0, z: 9 });
  bridge.ev({ type: 'chalk', x: 0, y: 0, z: 10 });
  operator.ev({ type: 'knock' });
  operator.ev({ type: 'span.throw' });
  runner.input({ s: 1 }); // steer off the centre at the start station (no commit: he would run)
  await sleep(700);
  runner.input({ s: 0 });
  await sleep(200);
  const before = runner.snap;
  runner.ev({ type: 'reset' }); // the raw debug event: refused
  await sleep(250);
  check('the raw reset event is refused without --debug', runner.snap.runner.x < -1 && runner.snap.ink === 4, `x=${runner.snap.runner.x.toFixed(1)} ink=${runner.snap.ink}`);

  runner.vote(true);
  await until(() => operator.votes?.roles?.length === 1);
  await sleep(200);
  check('one vote out of three players does not restart', runner.resets === 0 && runner.snap.runner.x < -1 && operator.votes.need === 2, JSON.stringify(operator.votes));
  runner.vote(false);
  await until(() => operator.votes?.roles?.length === 0);
  operator.vote(true);
  await sleep(150);
  check('a withdrawn vote does not count', runner.resets === 0);
  bridge.vote(true);
  await until(() => runner.resets > 0);
  await sleep(150);
  const s = runner.snap;
  check(
    'two votes restart the room for everyone',
    runner.resets === 1 && operator.resets === 1 && bridge.resets === 1,
    `resets=${runner.resets}/${operator.resets}/${bridge.resets}`,
  );
  check(
    'a restart is a full reset: position, levers, ink, knocks, chalk, deaths',
    s.runner.z === 2 && s.runner.x === 0 && s.span.phase === 'out' && s.ink === 6 && s.knocks === 3 && s.chalk.length === 0 && s.deaths === 0 && !s.won && s.stats.throws === 0,
    `before x=${before.runner.x.toFixed(1)} ink=${before.ink} knocks=${before.knocks} -> z=${s.runner.z} ink=${s.ink} knocks=${s.knocks}`,
  );
  check('votes are cleared after the restart', operator.votes.roles.length === 0);
  for (const c of [runner, operator, bridge]) c.close();
}
{
  // two players in the room: both must agree; one alone: their own vote is enough
  const pair = await team('PAIR', ['runner', 'bridge']);
  pair.runner.vote(true);
  await sleep(300);
  check('two players: one vote is not enough', pair.runner.resets === 0 && pair.bridge.votes.need === 2);
  pair.bridge.close();
  await until(() => pair.runner.resets > 0, 1500);
  check('a vote is dropped when its voter leaves (no surprise restarts)', pair.runner.resets === 0 && pair.runner.votes.roles.length <= 1);
  pair.runner.vote(true);
  await until(() => pair.runner.resets > 0, 1500);
  check('a player alone restarts with their own vote', pair.runner.resets === 1);
  pair.runner.close();
}

// ------------------------------------------------------------ runner input
{
  // forced momentum: once committed he runs on no matter what. What a frozen tab must not
  // do is keep him STEERING (or jumping) on its last message.
  const { runner, operator } = await team('STALE', ['runner', 'operator']);
  runner.input({ s: 1 }); // hold D at the start station... and then go silent
  await sleep(400);
  const x1 = operator.snap.runner.x;
  await sleep(1600);
  const x2 = operator.snap.runner.x;
  await sleep(500);
  const x3 = operator.snap.runner.x;
  check('a Runner whose input stops arriving stops steering', x2 < x1 && Math.abs(x3 - x2) < 0.02, `x ${x1.toFixed(2)} -> ${x2.toFixed(2)} -> ${x3.toFixed(2)}`);
  runner.close();
  operator.close();
}

// ---------------------------------------------------------- snapshots, clock
{
  const { runner, operator, bridge } = await team('SIZE');
  await sleep(300);
  const fresh = Math.max(...operator.bytes);
  for (let i = 0; i < 40; i++) {
    operator.ev({ type: 'stamp', icon: '▲', x: 0, z: i });
    operator.ev({ type: 'lift.toggle' });
    operator.ev({ type: 'span.throw' });
    bridge.ev({ type: 'chalk', x: 0, y: 0, z: i });
    await sleep(40);
  }
  await sleep(300);
  const busy = Math.max(...operator.bytes.slice(-10));
  check('a fresh snapshot is small (< 1 KB)', fresh < 1024, `${fresh} B`);
  check('snapshots stay bounded in a busy session (< 2 KB)', busy < 2048, `${busy} B = ${((busy * 30) / 1024).toFixed(1)} KB/s per client`);

  const t0 = runner.snap.t;
  const w0 = performance.now();
  await sleep(4000);
  const ratio = (runner.snap.t - t0) / ((performance.now() - w0) / 1000);
  check('the server clock runs at one sim second per wall second (±2%)', ratio > 0.98 && ratio < 1.02, ratio.toFixed(3));
  const n0 = operator.bytes.length;
  await sleep(2000);
  const hz = (operator.bytes.length - n0) / 2;
  check('snapshots arrive at ~30 Hz', hz > 27 && hz < 33, `${hz.toFixed(1)} Hz`);
  for (const c of [runner, operator, bridge]) c.close();
}

// ------------------------------------------------------------- raw frames
function raw() {
  return new Promise((resolve) => {
    const u = new URL(WS);
    const sock = net.connect(Number(u.port), u.hostname);
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const frames = [];
    let closed = false;
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        upgraded = true;
        buf = buf.subarray(i + 4);
        resolve(api);
      }
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        }
        if (buf.length < off + len) return;
        frames.push({ op: buf[0] & 0x0f, payload: buf.subarray(off, off + len) });
        buf = buf.subarray(off + len);
      }
    });
    sock.on('close', () => (closed = true));
    sock.on('error', () => (closed = true));
    const frame = (op, payload, { mask = true, fakeLen } = {}) => {
      const len = fakeLen ?? payload.length;
      let head;
      if (len < 126) head = Buffer.from([0x80 | op, (mask ? 0x80 : 0) | len]);
      else if (len < 65536) {
        head = Buffer.alloc(4);
        head[0] = 0x80 | op;
        head[1] = (mask ? 0x80 : 0) | 126;
        head.writeUInt16BE(len, 2);
      } else {
        head = Buffer.alloc(10);
        head[0] = 0x80 | op;
        head[1] = (mask ? 0x80 : 0) | 127;
        head.writeBigUInt64BE(BigInt(len), 2);
      }
      if (!mask) return Buffer.concat([head, payload]);
      const key = crypto.randomBytes(4);
      const body = Buffer.from(payload.map((b, i) => b ^ key[i & 3]));
      return Buffer.concat([head, key, body]);
    };
    const api = {
      frames,
      get closed() {
        return closed;
      },
      send: (op, payload, o) => sock.write(frame(op, payload, o)),
      write: (b) => sock.write(b),
      end: () => sock.destroy(),
    };
    sock.write(
      `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  });
}
{
  const a = await raw();
  a.send(0x9, Buffer.from('hello-ping'));
  await until(() => a.frames.some((f) => f.op === 0xa));
  const pong = a.frames.find((f) => f.op === 0xa);
  check('a ping gets a proper pong that echoes its payload', pong && pong.payload.toString() === 'hello-ping', pong ? pong.payload.toString() : 'none');
  a.end();

  const b = await raw();
  b.send(0x1, Buffer.alloc(0), { fakeLen: 10 * 1024 * 1024 }); // announces 10 MB, sends nothing
  await until(() => b.closed, 1500);
  check('a frame announcing a huge payload is refused immediately (no 10 MB buffering)', b.closed);

  const c = await raw();
  c.send(0x1, Buffer.from(JSON.stringify({ t: 'ping', c: 1 })), { mask: false });
  await until(() => c.closed, 1500);
  check('an unmasked client frame closes the connection (RFC 6455)', c.closed);

  const d = await raw();
  d.send(0x1, Buffer.from(JSON.stringify({ t: 'ping', c: 7 })));
  await until(() => d.frames.some((f) => f.op === 0x1));
  check('a well-formed masked frame still works', d.frames.some((f) => f.op === 0x1 && f.payload.toString().includes('"pong"')));
  d.end();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
