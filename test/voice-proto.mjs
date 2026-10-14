// RELAY 3D — voice routing, enforced by the server. Raw WebSocket clients against a
// normal (non-debug) server: every message here is one a modified client could send.
//
//   WS=ws://127.0.0.1:8792/ws HTTPS=https://127.0.0.1:9792 node test/voice-proto.mjs
import { setTimeout as sleep } from 'node:timers/promises';
import https from 'node:https';
import { checkSdp, VOICE_LINKS, talksTo, hears } from '../game/shared/voice-rules.js';

const WS = process.env.WS || 'ws://127.0.0.1:8792/ws';
const HTTPS = process.env.HTTPS || 'https://127.0.0.1:9792';
const HTTP = WS.replace(/^ws/, 'http').replace(/\/ws$/, '');
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const until = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(15);
  }
  return false;
};

const sdp = (dir, kinds = ['audio']) =>
  ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', ...kinds.flatMap((k) => [`m=${k} 9 UDP/TLS/RTP/SAVPF 111`, 'c=IN IP4 0.0.0.0', `a=${dir}`, 'a=mid:0'])].join('\r\n') + '\r\n';

function client(room, role, url = WS) {
  const ws = new WebSocket(url);
  const c = { role, rtc: [], errs: [], talk: [], players: [] };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'rtc') c.rtc.push(m);
    if (m.t === 'rtc-error') c.errs.push(m);
    if (m.t === 'talk') c.talk.push(m);
    if (m.t === 'players') c.players = m.players;
    if (m.t === 'welcome') c.welcome = m;
  };
  c.ready = new Promise((r) => (ws.onopen = () => (ws.send(JSON.stringify({ t: 'join', room, role })), r())));
  c.send = (m) => ws.send(JSON.stringify(m));
  c.rtcSend = (link, kind, extra = {}) => c.send({ t: 'rtc', link, kind, ...extra });
  c.close = () => ws.close();
  c.reset = () => {
    c.rtc.length = 0;
    c.errs.length = 0;
    c.talk.length = 0;
  };
  return c;
}

console.log('=== RELAY 3D — voice routing over the wire ===\n');

// ------------------------------------------------------------- pure rules
check(
  'the rules: Bridge→Runner, Bridge→Operator, Runner→Operator, nothing else',
  VOICE_LINKS.map((l) => l.id).sort().join() === 'bridge>operator,bridge>runner,runner>operator' &&
    talksTo('operator').length === 0 && hears('bridge').length === 0 && hears('runner').join() === 'bridge',
);
check(
  'SDP check: speaker offers sendonly, listener answers recvonly, audio only',
  checkSdp(sdp('sendonly'), 'offer') === null && checkSdp(sdp('recvonly'), 'answer') === null &&
    checkSdp(sdp('sendrecv'), 'offer') && checkSdp(sdp('recvonly'), 'offer') && checkSdp(sdp('sendrecv'), 'answer') &&
    checkSdp(sdp('sendonly'), 'answer') && checkSdp(sdp('sendonly', ['audio', 'video']), 'offer') &&
    checkSdp(sdp('sendonly', ['application']), 'offer') && checkSdp('hello', 'offer'),
);

// ------------------------------------------------------------- the server
const code = `V${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const R = client(code, 'runner');
const O = client(code, 'operator');
const B = client(code, 'bridge');
await Promise.all([R.ready, O.ready, B.ready]);
await until(() => R.players.length === 3 && O.players.length === 3 && B.players.length === 3);
check('players carry ids (voice needs to know who to call)', R.players.every((p) => typeof p.id === 'string' && p.id.length === 8));

// legit flows
B.rtcSend('bridge>runner', 'offer', { sdp: sdp('sendonly') });
B.rtcSend('bridge>operator', 'offer', { sdp: sdp('sendonly') });
R.rtcSend('runner>operator', 'offer', { sdp: sdp('sendonly') });
await until(() => R.rtc.length >= 1 && O.rtc.length >= 2);
check("the Bridge's offer reaches the Runner", R.rtc.some((m) => m.link === 'bridge>runner' && m.kind === 'offer'));
check("the Bridge's and the Runner's offers reach the Operator", O.rtc.filter((m) => m.kind === 'offer').map((m) => m.link).sort().join() === 'bridge>operator,runner>operator');
R.rtcSend('bridge>runner', 'answer', { sdp: sdp('recvonly') });
O.rtcSend('runner>operator', 'answer', { sdp: sdp('recvonly') });
R.rtcSend('bridge>runner', 'ice', { cand: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host', sdpMid: '0', sdpMLineIndex: 0, evil: 'x'.repeat(50) } });
await until(() => B.rtc.some((m) => m.kind === 'answer') && R.rtc.some((m) => m.kind === 'answer') && B.rtc.some((m) => m.kind === 'ice'));
check('answers go back to the speaker', B.rtc.some((m) => m.link === 'bridge>runner' && m.kind === 'answer') && R.rtc.some((m) => m.link === 'runner>operator' && m.kind === 'answer'));
const ice = B.rtc.find((m) => m.kind === 'ice');
check('ICE candidates are relayed, stripped to the four known fields', ice && Object.keys(ice.cand).sort().join() === 'candidate,sdpMLineIndex,sdpMid,usernameFragment');
check('nobody else saw any of it (the Bridge never got an offer)', !B.rtc.some((m) => m.kind === 'offer'));

// the attacks
for (const c of [R, O, B]) c.reset();
O.rtcSend('bridge>runner', 'offer', { sdp: sdp('sendonly') }); // not his link
O.rtcSend('operator>runner', 'offer', { sdp: sdp('sendonly') }); // no such link
O.rtcSend('runner>operator', 'offer', { sdp: sdp('sendonly') }); // listener posing as speaker
await sleep(300);
check('the mute Operator cannot offer a voice on any link', R.rtc.length === 0 && B.rtc.length === 0 && O.errs.length === 3, O.errs.map((e) => e.reason).join(' | '));

for (const c of [R, O, B]) c.reset();
R.rtcSend('bridge>runner', 'answer', { sdp: sdp('sendrecv') }); // answer that also sends back
R.rtcSend('bridge>runner', 'answer', { sdp: sdp('sendonly') });
O.rtcSend('bridge>operator', 'answer', { sdp: sdp('sendrecv') });
await sleep(300);
check('a listener cannot answer with sendrecv/sendonly (no talking back to the deaf Bridge)', B.rtc.length === 0 && R.errs.length === 2 && O.errs.length === 1, [...R.errs, ...O.errs].map((e) => e.reason).join(' | '));

for (const c of [R, O, B]) c.reset();
B.rtcSend('bridge>runner', 'offer', { sdp: sdp('sendrecv') }); // offer that also listens
B.rtcSend('bridge>runner', 'offer', { sdp: sdp('recvonly') });
R.rtcSend('runner>operator', 'offer', { sdp: sdp('sendonly', ['audio', 'video']) });
R.rtcSend('runner>operator', 'offer', { sdp: sdp('sendonly', ['application']) }); // a data channel to pass notes
await sleep(300);
check('a speaker cannot offer sendrecv/recvonly, video or a data channel', R.rtc.length === 0 && O.rtc.length === 0 && B.errs.length === 2 && R.errs.length === 2, [...B.errs, ...R.errs].map((e) => e.reason).join(' | '));

for (const c of [R, O, B]) c.reset();
B.rtcSend('bridge>runner', 'offer', { sdp: sdp('sendonly') + 'a=x:' + 'y'.repeat(13000) });
B.rtcSend('bridge>runner', 'ice', { cand: { candidate: 42 } });
B.rtcSend('bridge>runner', 'shout', {});
await sleep(300);
check('oversized SDP, junk candidates and unknown kinds are refused', R.rtc.length === 0 && B.errs.length === 3, B.errs.map((e) => e.reason).join(' | '));

// talking indicators
for (const c of [R, O, B]) c.reset();
B.send({ t: 'ptt', on: true });
R.send({ t: 'ptt', on: true });
O.send({ t: 'ptt', on: true });
await sleep(300);
check("the Bridge's talking light reaches Runner + Operator", R.talk.some((m) => m.role === 'bridge' && m.on) && O.talk.some((m) => m.role === 'bridge' && m.on));
check("the Runner's talking light reaches only the Operator", O.talk.some((m) => m.role === 'runner' && m.on) && !B.talk.some((m) => m.role === 'runner'));
check('the deaf Bridge gets no talking lights at all; the Operator has none to send', B.talk.length === 0 && !R.talk.some((m) => m.role === 'operator') && !O.talk.some((m) => m.role === 'operator'));
for (const c of [R, O, B]) c.reset();
B.close();
await until(() => R.talk.length && O.talk.length);
check('a Bridge who disconnects mid-sentence turns his light off', R.talk.some((m) => m.role === 'bridge' && !m.on) && O.talk.some((m) => m.role === 'bridge' && !m.on));

R.reset();
R.rtcSend('bridge>runner', 'answer', { sdp: sdp('recvonly') });
await sleep(200);
check('signaling to an absent peer is reported, not silently dropped', R.errs.some((e) => e.reason === 'peer absent'));

// flood
R.reset();
O.reset();
for (let i = 0; i < 400; i++) R.rtcSend('runner>operator', 'ice', { cand: { candidate: `candidate:${i} 1 udp 1 10.0.0.1 ${1000 + i} typ host` } });
await sleep(500);
const got = O.rtc.length;
check('signaling is rate-limited (a flood is not relayed)', got > 50 && got < 200 && R.errs.some((e) => e.reason === 'rate limited'), `${got}/400 relayed`);
R.close();
O.close();

// ------------------------------------------------------------- https
const get = (url, opts = {}) =>
  new Promise((resolve) => {
    https
      .get(url, { rejectUnauthorized: false, ...opts }, (res) => {
        const cert = res.socket.getPeerCertificate?.();
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body, cert }));
      })
      .on('error', (e) => resolve({ status: 0, error: e.message }));
  });
const cfg = await (await fetch(`${HTTP}/config.json`)).json();
check('/config.json advertises the https port', Number.isInteger(cfg.httpsPort) && String(cfg.httpsPort) === new URL(HTTPS).port, JSON.stringify(cfg));
const page = await get(`${HTTPS}/play.html`);
check('the game is served over https', page.status === 200 && page.body.includes('play'), `status=${page.status}`);
const alt = page.cert?.subjectaltname || '';
check("the certificate covers localhost and this laptop's LAN addresses", alt.includes('DNS:localhost') && alt.includes('IP Address:127.0.0.1') && cfg.lan.every((ip) => alt.includes(ip)), alt);
const wss = client(`${code}S`, 'runner', HTTPS.replace(/^https/, 'wss') + '/ws');
// Node's WebSocket verifies the cert; trust it the way a player does (by accepting it)
await Promise.race([wss.ready, sleep(1500)]);
await until(() => wss.welcome, 1500);
check('WebSockets work over wss:// on the https port', !!wss.welcome, wss.welcome ? `room ${wss.welcome.room}` : 'no welcome');
wss.close();
for (const u of ['/shared/../server.js', '/shared/%2e%2e/.cert/key.pem', '/../.cert/key.pem', '/.cert/key.pem', '/shared/../.cert/key.pem']) {
  const r = await fetch(`${HTTP}${u}`).catch(() => ({ status: 0 }));
  const raw = await new Promise((resolve) => {
    import('node:net').then(({ default: net }) => {
      const s = net.connect(Number(new URL(HTTP).port), '127.0.0.1', () => s.write(`GET ${u} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
      let b = '';
      s.on('data', (d) => (b += d));
      s.on('end', () => resolve(b));
      s.on('error', () => resolve(''));
    });
  });
  if (r.status === 200 || /^HTTP\/1\.1 200/.test(raw) || raw.includes('PRIVATE KEY')) {
    check(`the TLS key and the server source are never served (${u})`, false, raw.slice(0, 40));
    break;
  }
  if (u === '/shared/../.cert/key.pem') check('the TLS key and the server source are never served (5 traversal paths)', true);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
