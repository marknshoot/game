// RELAY 3D — LAN server. Zero dependencies: static files + a hand-rolled
// WebSocket server + the authoritative simulation for every room.
//
//   node server.js  [port]  [--debug]  [--https-port=N]  [--no-https]
//
// HTTP on `port` (8791), HTTPS on port+1000 (9791) with a self-signed certificate that is
// generated on first run for this laptop's LAN addresses. Browsers only allow the
// microphone on https:// (or localhost), so voice chat on the other laptops needs the
// https address; everything else works on either.
//
// Then: run the Server link printed below on all three laptops.
// --debug (or RELAY_DEBUG=1) allows the demo autopilot and the raw reset event;
// a normal server refuses both, so nobody can let the level play itself.
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createState, step, applyEvent, snapshotOf, resetState } from './shared/sim3d.js';
import { linkById, talksTo, checkSdp, cleanCandidate } from './shared/voice-rules.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const PORT = Number(ARGS.find((a) => /^\d+$/.test(a)) || process.env.PORT || 8791);
const DEBUG = ARGS.includes('--debug') || process.env.RELAY_DEBUG === '1';
const HTTPS_PORT = ARGS.includes('--no-https') ? 0 : Number((ARGS.find((a) => a.startsWith('--https-port=')) || '').split('=')[1] || process.env.HTTPS_PORT || PORT + 1000);
const CERT_DIR = process.env.RELAY_CERT_DIR || path.join(ROOT, '.cert');
const TICK = 1 / 60;
const SNAP = 1 / 30;
const MAX_FRAME = 16 * 1024; // the biggest legit client message is ~200 bytes
const INPUT_STALE_MS = 1000; // a Runner who stops sending input stops running
const VOTE_TTL_MS = 15_000;

// Who may do what. The roles' disabilities are rules, so the server enforces them:
// the Operator is mute (no phrases), the Bridge holds the chalk and the 2nd key,
// and the Runner only has his body (input) and his voice (say, Operator-only).
const ALLOWED = {
  operator: new Set(['span.throw', 'press', 'lift.toggle', 'exit.lever', 'knock', 'stamp']),
  bridge: new Set(['phrase', 'chalk', 'key']),
  runner: new Set(),
};
const DEBUG_EVENTS = new Set(['auto', 'reset']);

function eventAllowed(role, type, debug = DEBUG) {
  if (DEBUG_EVENTS.has(type)) return debug;
  return !!ALLOWED[role]?.has(type);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ------------------------------------------------------------------- rooms
/** @type {Map<string, any>} */
const rooms = new Map();
const IDLE_INPUT = () => ({ yaw: 0, f: 0, s: 0, jump: false });

function getRoom(code) {
  const key = String(code || 'A').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'A';
  let r = rooms.get(key);
  if (!r) {
    r = {
      code: key,
      state: createState(),
      input: IDLE_INPUT(),
      inputAt: 0,
      clients: new Map(), // ws -> {role, name, id}
      votes: new Map(), // role -> time of the vote
      history: [], // finished runs: who played what, how long, how many falls
      logged: false,
      simAcc: 0,
      snapAcc: 0,
      emptySince: null,
    };
    rooms.set(key, r);
    console.log(`[room ${key}] created`);
  }
  return r;
}

function playersOf(room) {
  const out = [];
  for (const [, c] of room.clients) out.push({ role: c.role, name: c.name, id: c.id });
  return out;
}

// numbers rounded to the millimetre / millisecond: plenty for rendering, half the bytes
const round3 = (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v);

function broadcast(room, msg, except = null) {
  const text = JSON.stringify(msg, round3);
  for (const [ws] of room.clients) if (ws !== except) sendText(ws, text);
}

function playersMessage(room) {
  return { t: 'players', players: playersOf(room) };
}

// ------------------------------------------------------------- restart vote
// RUN AGAIN needs two of the players in the room (or the only one, if alone),
// so nobody can wipe a run the others are in the middle of.
function votesNeeded(room) {
  return Math.min(2, room.clients.size);
}
function presentRoles(room) {
  return new Set([...room.clients.values()].map((c) => c.role));
}
function votesMessage(room) {
  return { t: 'votes', roles: [...room.votes.keys()], need: votesNeeded(room) };
}
function pruneVotes(room, now = Date.now()) {
  const present = presentRoles(room);
  let changed = false;
  for (const [role, at] of room.votes) {
    if (!present.has(role) || now - at > VOTE_TTL_MS) {
      room.votes.delete(role);
      changed = true;
    }
  }
  return changed;
}
function vote(room, role, on) {
  pruneVotes(room);
  if (on) room.votes.set(role, Date.now());
  else room.votes.delete(role);
  if (room.clients.size > 0 && room.votes.size >= votesNeeded(room)) {
    restartRoom(room);
    return;
  }
  broadcast(room, votesMessage(room));
}
// After a WIN with all three seats taken, RUN AGAIN also rotates the roles, so over three
// runs everyone plays Runner, Operator and Bridge once. Each client is told its next role
// and reloads into it; its old seat can be taken over while it does.
const NEXT_ROLE = { runner: 'operator', operator: 'bridge', bridge: 'runner' };
function restartRoom(room) {
  const rotate = room.state.won && presentRoles(room).size === 3;
  resetState(room.state);
  room.logged = false;
  if (rotate) {
    for (const [ws, c] of room.clients) {
      c.leaving = Date.now();
      sendText(ws, JSON.stringify({ t: 'rotate', role: NEXT_ROLE[c.role] }));
    }
    console.log(`[room ${room.code}] roles rotate`);
  }
  room.input = IDLE_INPUT();
  room.votes.clear();
  room.snapAcc = 0;
  broadcast(room, { t: 'reset', snapshot: snapshotOf(room.state) });
  broadcast(room, votesMessage(room));
  console.log(`[room ${room.code}] restarted`);
}

// ---------------------------------------------------------------- websocket
function sendText(ws, text) {
  if (ws.destroyed || !ws.writable) return;
  ws.write(encodeFrame(0x1, Buffer.from(text, 'utf8')));
}

function encodeFrame(op, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | op, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | op;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | op;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// A deliberately small RFC6455 reader: text/ping/close, with continuation support.
// Client frames must be masked; frames (or fragmented messages) above MAX_FRAME and
// control frames above 125 bytes close the connection instead of buffering forever.
function makeFrameReader(sock, onText, onClose) {
  let buf = Buffer.alloc(0);
  let frag = [];
  let fragLen = 0;
  const fail = (code) => {
    if (!sock.destroyed) sock.write(encodeFrame(0x8, Buffer.from([code >> 8, code & 0xff])));
    onClose();
  };
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        len = big > BigInt(MAX_FRAME) ? Infinity : Number(big);
        off = 10;
      }
      if (!masked) return fail(1002);
      if (len > MAX_FRAME || fragLen + len > MAX_FRAME) return fail(1009);
      if (op >= 0x8 && (len > 125 || !fin)) return fail(1002);
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ mask[i & 3];
      buf = buf.subarray(off + 4 + len);

      if (op === 0x8) {
        if (!sock.destroyed) sock.write(encodeFrame(0x8, payload.subarray(0, 2)));
        onClose();
        return;
      }
      if (op === 0x9) {
        if (!sock.destroyed) sock.write(encodeFrame(0xa, payload)); // pong echoes the ping
        continue;
      }
      if (op === 0xa) continue;

      if (op === 0x0) {
        frag.push(payload);
        fragLen += len;
        if (fin) {
          const text = Buffer.concat(frag).toString('utf8');
          frag = [];
          fragLen = 0;
          onText(text);
        }
        continue;
      }
      if (op !== 0x1) continue; // binary frames are not part of the protocol
      if (fin) onText(payload.toString('utf8'));
      else {
        frag = [payload];
        fragLen = len;
      }
    }
  };
}

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function handle(req, res) {
  if ((req.url || '').split('?')[0] === '/config.json') {
    res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-cache' });
    res.end(JSON.stringify({ httpPort: PORT, httpsPort: tlsUp ? HTTPS_PORT : null, lan: lanAddresses(), debug: DEBUG }));
    return;
  }
  serveStatic(req, res);
}
const server = http.createServer(handle);

function serveStatic(req, res) {
  let url;
  try {
    url = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (url === '/') url = '/index.html';
  if (url === '/play' || url === '/play/') url = '/play.html';

  let file;
  if (url.startsWith('/shared/')) file = path.join(ROOT, url);
  else file = path.join(ROOT, 'public', url);

  // only public/ and shared/ are served: never server.js, never the TLS key in .cert/
  const rel = path.relative(ROOT, file);
  if (!(rel.startsWith('public' + path.sep) || rel.startsWith('shared' + path.sep))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

function onUpgrade(req, sock) {
  if (!/^\/ws/.test(req.url || '')) {
    sock.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  sock.setNoDelay(true);

  let room = null;
  let role = null;
  let closed = false;
  let talking = false;
  const id = crypto.randomUUID().slice(0, 8);
  // signaling is chatty for a moment (offer, answer, ~10 ICE candidates per link) and then
  // silent; a token bucket keeps a broken or hostile client from using us as a megaphone
  const bucket = { tokens: 120, at: Date.now() };
  const spend = () => {
    const now = Date.now();
    bucket.tokens = Math.min(120, bucket.tokens + ((now - bucket.at) / 1000) * 40);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };
  const rtcError = (link, reason) => sendText(sock, JSON.stringify({ t: 'rtc-error', link: String(link || '').slice(0, 32), reason }));

  const close = () => {
    if (closed) return;
    closed = true;
    if (room) {
      room.clients.delete(sock);
      if (room.clients.size === 0) room.emptySince = Date.now();
      if (role === 'runner') room.input = IDLE_INPUT();
      if (role === 'bridge') applyEvent(room.state, { type: 'key', down: false }); // a key nobody holds
      room.votes.delete(role);
      if (talking) sendTalk(room, role, false);
      broadcast(room, playersMessage(room));
      broadcast(room, votesMessage(room));
    }
    sock.destroy();
  };

  const onText = (text) => {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;

    switch (m.t) {
      case 'join': {
        if (room) return; // one socket, one seat
        const target = getRoom(m.room);
        const wanted = ['runner', 'operator', 'bridge'].includes(m.role) ? m.role : 'runner';
        for (const [ws2, c] of target.clients) {
          if (c.role === wanted && c.leaving && Date.now() - c.leaving < 15_000) {
            target.clients.delete(ws2); // a rotating player's old seat: theirs is already reloading
            c.kick();
            continue;
          }
          if (c.role === wanted) {
            sendText(sock, JSON.stringify({ t: 'error', code: 'role_taken', role: wanted, players: playersOf(target) }));
            return;
          }
        }
        room = target;
        role = wanted;
        room.clients.set(sock, { role, name: String(m.name || '').slice(0, 18) || role, id, leaving: 0, kick: () => ((closed = true), sock.destroy()) });
        room.emptySince = null;
        sendText(sock, JSON.stringify({ t: 'welcome', id, room: room.code, role, debug: DEBUG, players: playersOf(room), history: room.history, tick: TICK, snapshot: snapshotOf(room.state) }, round3));
        broadcast(room, playersMessage(room));
        sendText(sock, JSON.stringify(votesMessage(room)));
        console.log(`[room ${room.code}] ${role} joined (${room.clients.size}/3)`);
        return;
      }
      case 'input': {
        if (!room || role !== 'runner') return;
        room.input = {
          yaw: Number.isFinite(Number(m.yaw)) ? Number(m.yaw) : 0,
          f: Math.max(-1, Math.min(1, Number(m.f) || 0)),
          s: Math.max(-1, Math.min(1, Number(m.s) || 0)),
          jump: !!m.jump,
        };
        room.inputAt = Date.now();
        return;
      }
      case 'ev': {
        if (!room || !m.ev || typeof m.ev.type !== 'string') return;
        if (!eventAllowed(role, m.ev.type)) return;
        applyEvent(room.state, m.ev);
        return;
      }
      case 'restart': {
        if (!room) return;
        vote(room, role, m.on !== false);
        return;
      }
      case 'say': {
        if (!room || role !== 'runner') return; // the Operator is mute; the Bridge is deaf
        const text = String(m.text || '').slice(0, 140);
        if (!text) return;
        const who = room.clients.get(sock)?.name || 'runner';
        for (const [ws2, c] of room.clients) {
          if (c.role === 'operator') sendText(ws2, JSON.stringify({ t: 'say', from: who, text }));
        }
        return;
      }
      case 'rtc': {
        // WebRTC signaling, relayed only along the links in shared/voice-rules.js:
        // the speaker offers (sendonly), the listener answers (recvonly), both trade ICE.
        if (!room) return;
        if (!spend()) return rtcError(m.link, 'rate limited');
        const link = linkById(m.link);
        if (!link) return rtcError(m.link, 'no such link');
        if (role !== link.from && role !== link.to) return rtcError(link.id, 'not your link');
        const out = { t: 'rtc', link: link.id, kind: m.kind };
        if (m.kind === 'offer' || m.kind === 'answer') {
          const want = m.kind === 'offer' ? link.from : link.to;
          if (role !== want) return rtcError(link.id, `only the ${want} sends the ${m.kind}`);
          const bad = checkSdp(m.sdp, m.kind);
          if (bad) return rtcError(link.id, bad);
          out.sdp = m.sdp;
        } else if (m.kind === 'ice') {
          const cand = cleanCandidate(m.cand);
          if (!cand) return rtcError(link.id, 'bad candidate');
          out.cand = cand;
        } else if (m.kind === 'bye') {
          // either side hangs up
        } else return rtcError(link.id, 'unknown kind');
        const other = role === link.from ? link.to : link.from;
        let delivered = false;
        for (const [ws2, c] of room.clients) {
          if (c.role === other) {
            out.peer = id;
            sendText(ws2, JSON.stringify(out));
            delivered = true;
          }
        }
        if (!delivered && m.kind !== 'bye') rtcError(link.id, 'peer absent');
        return;
      }
      case 'ptt': {
        // talking indicator, sent only to the roles that can hear this one
        if (!room || !talksTo(role).length || !spend()) return;
        const on = !!m.on;
        if (on === talking) return;
        talking = on;
        sendTalk(room, role, on);
        return;
      }
      case 'ping':
        sendText(sock, JSON.stringify({ t: 'pong', c: Number(m.c) || 0 }));
        return;
    }
  };

  sock.on('data', makeFrameReader(sock, onText, close));
  sock.on('close', close);
  sock.on('error', close);
}
server.on('upgrade', onUpgrade);

function sendTalk(room, role, on) {
  const to = talksTo(role);
  const text = JSON.stringify({ t: 'talk', role, on });
  for (const [ws, c] of room.clients) if (to.includes(c.role)) sendText(ws, text);
}

// ------------------------------------------------------------------- https
// A self-signed certificate for this laptop: SAN = localhost + every LAN IPv4, regenerated
// when the addresses change. Players accept the browser warning once per laptop.
function ensureCert() {
  const keyF = path.join(CERT_DIR, 'key.pem');
  const certF = path.join(CERT_DIR, 'cert.pem');
  const metaF = path.join(CERT_DIR, 'san.json');
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanAddresses().map((ip) => `IP:${ip}`)];
  try {
    const meta = JSON.parse(fs.readFileSync(metaF, 'utf8'));
    if (san.every((x) => meta.san.includes(x))) return { key: fs.readFileSync(keyF), cert: fs.readFileSync(certF), fresh: false };
  } catch {}
  fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(CERT_DIR, 'tmp-'));
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
        '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem'),
        '-subj', '/CN=RELAY LAN server',
        '-addext', `subjectAltName=${san.join(',')}`,
        '-addext', 'basicConstraints=critical,CA:FALSE',
        '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
        '-addext', 'extendedKeyUsage=serverAuth',
      ],
      { stdio: 'ignore' },
    );
    fs.chmodSync(path.join(tmp, 'key.pem'), 0o600);
    // rename is atomic, so two servers starting at once never read half a key
    fs.renameSync(path.join(tmp, 'key.pem'), keyF);
    fs.renameSync(path.join(tmp, 'cert.pem'), certF);
    fs.writeFileSync(metaF, JSON.stringify({ san, created: new Date().toISOString() }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { key: fs.readFileSync(keyF), cert: fs.readFileSync(certF), fresh: true };
}

let tlsUp = false;
let tlsNote = '';
if (HTTPS_PORT) {
  try {
    const { key, cert, fresh } = ensureCert();
    const tls = https.createServer({ key, cert }, handle);
    tls.on('upgrade', onUpgrade);
    tls.on('error', (e) => console.log(`  (https on :${HTTPS_PORT} failed: ${e.code || e.message} — voice needs it on other laptops)`));
    tls.listen(HTTPS_PORT, '0.0.0.0', () => (tlsUp = true));
    tlsNote = fresh ? `  (new self-signed certificate in ${path.relative(process.cwd(), CERT_DIR) || CERT_DIR})` : '';
  } catch (e) {
    tlsNote = `  (no https: ${e.code === 'ENOENT' ? 'openssl not found' : e.message}; voice works on localhost only)`;
  }
}

// ------------------------------------------------------------------- ticking
// setInterval drifts (it fires late, never early), so the sim is advanced by the
// real elapsed time in fixed TICK steps: one sim second per wall second.
let lastTick = performance.now();
setInterval(() => {
  const nowMs = performance.now();
  const elapsed = Math.min(0.25, (nowMs - lastTick) / 1000);
  lastTick = nowMs;
  const wall = Date.now();
  for (const [code, room] of rooms) {
    if (room.clients.size === 0) {
      if (room.emptySince && wall - room.emptySince > 90_000) {
        rooms.delete(code);
        console.log(`[room ${code}] cleaned up`);
      }
      continue;
    }
    if (room.inputAt && wall - room.inputAt > INPUT_STALE_MS) {
      room.input = IDLE_INPUT();
      room.inputAt = 0;
    }
    if (room.votes.size && pruneVotes(room, wall)) broadcast(room, votesMessage(room));
    room.simAcc += elapsed;
    let steps = 0;
    while (room.simAcc >= TICK && steps < 8) {
      step(room.state, TICK, room.input);
      room.simAcc -= TICK;
      room.snapAcc += TICK;
      steps++;
    }
    if (steps === 8) room.simAcc = 0; // a long stall: drop the backlog rather than fast-forward
    if (room.state.won && !room.logged) {
      room.logged = true;
      const roles = {};
      for (const c of room.clients.values()) roles[c.role] = c.name;
      room.history.push({ n: room.history.length + 1, time: Math.round(room.state.wonTime * 10) / 10, deaths: room.state.deaths, roles });
      if (room.history.length > 12) room.history.shift();
      broadcast(room, { t: 'history', runs: room.history });
    }
    if (room.snapAcc >= SNAP - 1e-9) {
      room.snapAcc -= SNAP;
      if (room.snapAcc > SNAP) room.snapAcc = 0;
      broadcast(room, { t: 'snap', s: snapshotOf(room.state) });
    }
  }
}, 1000 / 120);

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanAddresses();
  console.log(`\n  RELAY 3D server up — tick ${Math.round(1 / TICK)} Hz, snapshots ${Math.round(1 / SNAP)} Hz${DEBUG ? '  [DEBUG: autopilot + reset allowed]' : ''}\n`);
  console.log(`  this laptop:      http://localhost:${PORT}/`);
  if (HTTPS_PORT && !tlsNote.startsWith('  (no')) {
    for (const ip of ips) console.log(`  on the network:   https://${ip}:${HTTPS_PORT}/   ← use this one: voice needs https`);
    console.log(`                    (self-signed: click through the browser warning once per laptop)`);
  } else for (const ip of ips) console.log(`  on the network:   http://${ip}:${PORT}/`);
  if (tlsNote) console.log(tlsNote);
  console.log(`\n  Open the lobby on each laptop, use the same room code, pick a role.\n`);
});
