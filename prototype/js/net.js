// RELAY prototype — multi-tab transport (BroadcastChannel, host election).
// Roles are ranked: the Runner's tab owns the simulation when it is open.
const RANK = { runner: 0, operator: 1, bridge: 2 };

export function createNet(role, room, handlers) {
  const id = Math.random().toString(36).slice(2, 8);
  const bc = new BroadcastChannel(`relay-proto-${room || 'a'}`);
  const peers = new Map(); // id -> {role, t}
  let isHost = false;
  let snapAcc = 0;

  const send = (m) => bc.postMessage({ from: id, role, ...m });
  const now = () => performance.now();

  function alive() {
    for (const [pid, p] of peers) if (now() - p.t > 4000) peers.delete(pid);
  }

  function elect() {
    alive();
    let best = { id, role };
    for (const [pid, p] of peers) {
      const a = [RANK[p.role] ?? 9, pid];
      const b = [RANK[best.role] ?? 9, best.id];
      if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) best = { id: pid, role: p.role };
    }
    const next = best.id === id;
    if (next !== isHost) {
      isHost = next;
      handlers.onHostChange?.(isHost);
    }
    return isHost;
  }

  bc.onmessage = (e) => {
    const m = e.data;
    if (!m || m.from === id) return;
    switch (m.type) {
      case 'hello':
        peers.set(m.from, { role: m.role, t: now() });
        send({ type: 'hello.ack' });
        break;
      case 'hello.ack':
      case 'hb':
        peers.set(m.from, { role: m.role, t: now() });
        break;
      case 'bye':
        peers.delete(m.from);
        break;
      case 'ev':
        handlers.onEvent?.(m.ev);
        break;
      case 'snap':
        if (!isHost) handlers.onSnapshot?.(m.s);
        break;
      case 'key':
        handlers.onRemoteKey?.(m.code, m.down);
        break;
    }
    elect();
  };

  send({ type: 'hello' });
  window.addEventListener('beforeunload', () => send({ type: 'bye' }));
  window.addEventListener('pagehide', () => send({ type: 'bye' }));

  // heartbeat
  setInterval(() => {
    send({ type: 'hb' });
    elect();
  }, 1200);

  return {
    id,
    role,
    get isHost() {
      return isHost;
    },
    peers: () => [...peers.entries()].map(([pid, p]) => ({ id: pid, role: p.role })),
    sendEvent: (ev) => send({ type: 'ev', ev }),
    sendKey: (code, down) => send({ type: 'key', code, down }),
    tick(dt, state, snapshot) {
      snapAcc += dt;
      if (snapAcc >= 1 / 30) {
        snapAcc = 0;
        send({ type: 'snap', s: snapshot(state) });
      }
    },
  };
}
