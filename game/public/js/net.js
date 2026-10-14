// RELAY 3D — WebSocket client. Talks to the authoritative server, measures RTT,
// and hands snapshots to the caller.
export function createNet({ room, role, name, onWelcome, onSnapshot, onPlayers, onError, onStatus, onVotes, onReset }) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws`;
  let ws = null;
  let rtt = 0;
  let pingTimer = null;
  let closed = false;
  const extra = new Map(); // type -> [fn]: message types owned by other modules (voice)

  function connect() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      onStatus?.('connected');
      send({ t: 'join', room, role, name });
      pingTimer = setInterval(() => send({ t: 'ping', c: performance.now() }), 1500);
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      for (const fn of extra.get(m.t) || []) fn(m);
      switch (m.t) {
        case 'welcome':
          onWelcome?.(m);
          break;
        case 'snap':
          onSnapshot?.(m.s);
          break;
        case 'players':
          onPlayers?.(m.players, m);
          break;
        case 'error':
          onError?.(m);
          break;
        case 'votes':
          onVotes?.(m);
          break;
        case 'reset':
          onReset?.(m.snapshot);
          break;
        case 'pong':
          rtt = Math.round(performance.now() - m.c);
          break;
      }
    };
    ws.onclose = () => {
      onStatus?.('disconnected');
      if (!closed) setTimeout(connect, 1200);
    };
    ws.onerror = () => onStatus?.('error');
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  connect();

  return {
    get rtt() {
      return rtt;
    },
    get connected() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
    sendInput: (input) => send({ t: 'input', ...input }),
    sendEvent: (ev) => send({ t: 'ev', ev }),
    voteRestart: (on) => send({ t: 'restart', on }),
    send,
    on(type, fn) {
      if (!extra.has(type)) extra.set(type, []);
      extra.get(type).push(fn);
    },
    close() {
      closed = true;
      clearInterval(pingTimer);
      ws?.close();
    },
  };
}
