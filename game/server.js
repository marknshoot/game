// RELAY 3D — LAN server. Zero dependencies: static files + a hand-rolled
// WebSocket server + the authoritative simulation for every room.
//
//   node server.js  [port]
//
// Then: run the Server link printed below on all three laptops.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createState, step, applyEvent, snapshotOf, TUNING } from './shared/sim3d.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8791);
const TICK = 1 / 60;
const SNAP = 1 / 30;

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
/** @type {Map<string, Room>} */
const rooms = new Map();

function getRoom(code) {
  const key = String(code || 'A').toUpperCase().slice(0, 8);
  let r = rooms.get(key);
  if (!r) {
    r = {
      code: key,
      state: createState(),
      input: { yaw: 0, f: 0, s: 0, jump: false },
      clients: new Map(), // ws -> {role, name, id}
      lastActivity: Date.now(),
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
  for (const [, c] of room.clients) out.push({ role: c.role, name: c.name });
  return out;
}

function broadcast(room, msg, except = null) {
  const text = JSON.stringify(msg);
  for (const [ws] of room.clients) if (ws !== except) sendText(ws, text);
}

function playersMessage(room) {
  return { t: 'players', players: playersOf(room) };
}

// ---------------------------------------------------------------- websocket
function sendText(ws, text) {
  if (ws.destroyed || !ws.writable) return;
  ws.write(encodeFrame(text));
}

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// A deliberately small RFC6455 reader: text/ping/close, with continuation support.
function makeFrameReader(sock, onText, onClose) {
  let buf = Buffer.alloc(0);
  let frag = [];
  let fragOp = 0;
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
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
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      buf = buf.subarray(off + maskLen + len);

      if (op === 0x8) {
        onClose();
        return;
      }
      if (op === 0x9) {
        // pong
        const p = Buffer.alloc(payload.length + 2);
        p[0] = 0x8a;
        p[1] = payload.length;
        payload.copy(p, 2);
        sock.write(p);
        continue;
      }
      if (op === 0xa) continue;

      if (op === 0x0) {
        frag.push(payload);
        if (fin) {
          onText(Buffer.concat(frag).toString('utf8'));
          frag = [];
        }
        continue;
      }
      // text frame (0x1)
      fragOp = op;
      if (fin) onText(payload.toString('utf8'));
      else frag = [payload];
    }
  };
}

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

const server = http.createServer((req, res) => {
  serveStatic(req, res);
});

function serveStatic(req, res) {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/') url = '/index.html';
  if (url === '/play' || url === '/play/') url = '/play.html';

  let file;
  if (url.startsWith('/shared/')) file = path.join(ROOT, url);
  else file = path.join(ROOT, 'public', url);

  const rel = path.relative(ROOT, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
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

server.on('upgrade', (req, sock) => {
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
  const id = crypto.randomUUID().slice(0, 8);

  const close = () => {
    if (room) {
      room.clients.delete(sock);
      if (room.clients.size === 0) room.emptySince = Date.now();
      if (role === 'runner') room.input = { yaw: 0, f: 0, s: 0, jump: false };
      broadcast(room, playersMessage(room));
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
    room = room || (m.room ? null : null);

    switch (m.t) {
      case 'join': {
        const target = getRoom(m.room);
        const wanted = ['runner', 'operator', 'bridge'].includes(m.role) ? m.role : 'runner';
        for (const [, c] of target.clients) {
          if (c.role === wanted) {
            sendText(sock, JSON.stringify({ t: 'error', code: 'role_taken', role: wanted, players: playersOf(target) }));
            return;
          }
        }
        room = target;
        role = wanted;
        room.clients.set(sock, { role, name: String(m.name || '').slice(0, 18) || role, id });
        room.emptySince = null;
        room.lastActivity = Date.now();
        sendText(sock, JSON.stringify({ t: 'welcome', id, room: room.code, role, players: playersOf(room), tick: TICK, snapshot: room.state }));
        broadcast(room, playersMessage(room));
        console.log(`[room ${room.code}] ${role} joined (${room.clients.size}/3)`);
        return;
      }
      case 'input': {
        if (!room || role !== 'runner') return;
        room.input = {
          yaw: Number(m.yaw) || 0,
          f: Math.max(-1, Math.min(1, Number(m.f) || 0)),
          s: Math.max(-1, Math.min(1, Number(m.s) || 0)),
          jump: !!m.jump,
        };
        room.lastActivity = Date.now();
        return;
      }
      case 'ev': {
        if (!room || !m.ev) return;
        applyEvent(room.state, m.ev);
        room.lastActivity = Date.now();
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
      case 'ping':
        sendText(sock, JSON.stringify({ t: 'pong', c: m.c }));
        return;
    }
  };

  sock.on('data', makeFrameReader(sock, onText, close));
  sock.on('close', close);
  sock.on('error', close);
});

// ------------------------------------------------------------------- ticking
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.clients.size === 0) {
      if (room.emptySince && now - room.emptySince > 90_000) {
        rooms.delete(code);
        console.log(`[room ${code}] cleaned up`);
      }
      continue;
    }
    step(room.state, TICK, room.input);
    room.snapAcc += TICK;
    if (room.snapAcc >= SNAP) {
      room.snapAcc = 0;
      broadcast(room, { t: 'snap', s: snapshotOf(room.state) });
    }
  }
}, TICK * 1000);

// keep the runner's key input from sticking if a client goes silent
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.clients.size === 0) continue;
    const data = [];
    for (const [, c] of room.clients) data.push(c.role);
  }
}, 5000);

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanAddresses();
  console.log(`\n  RELAY 3D server up — tick ${Math.round(1 / TICK)} Hz, snapshots ${Math.round(1 / SNAP)} Hz\n`);
  console.log(`  this laptop:      http://localhost:${PORT}/`);
  for (const ip of ips) console.log(`  on the network:   http://${ip}:${PORT}/`);
  console.log(`\n  Open the lobby on each laptop, use the same room code, pick a role.\n`);
});
