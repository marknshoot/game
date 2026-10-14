// RELAY 3D — built-in voice, routed by role. WebRTC audio, signaled through our own
// WebSocket server, no STUN/TURN, nothing leaves the LAN.
//
//   Bridge  → Runner, Operator     (the only voice on the team)
//   Runner  → Operator             (his shout; the Operator cannot answer)
//   Operator → nobody              (mute: this module never opens his mic)
//   Bridge  ← nobody               (deaf: this module never plays anything for him)
//
// One RTCPeerConnection per link, audio only, sendonly at the speaker and recvonly at the
// listener. The server relays signaling only along shared/voice-rules.js and refuses SDP
// that tries to send the other way, so a modified client cannot hear or speak out of turn.
import { VOICE_LINKS, linkById, hears, talksTo } from '../../shared/voice-rules.js';

const PREF_KEY = 'relay.mic';
export const readMicPref = () => {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {};
  } catch {
    return {};
  }
};
export const writeMicPref = (p) => localStorage.setItem(PREF_KEY, JSON.stringify(p));

export function createVoice({ role, net, onChange = () => {} }) {
  const outLinks = VOICE_LINKS.filter((l) => l.from === role);
  const deaf = role === 'bridge';
  const st = {
    role,
    speaks: talksTo(role),
    hears: deaf ? [] : hears(role),
    supported: typeof RTCPeerConnection === 'function' && !!navigator.mediaDevices?.getUserMedia,
    secure: window.isSecureContext,
    mic: outLinks.length ? 'idle' : 'none', // none | idle | asking | on | denied | unavailable | disabled | insecure
    ptt: false,
    open: false,
    live: false,
    talking: {}, // speaker role -> bool (from the server's PTT relay)
    blocked: false, // autoplay refused: needs a click
    httpsUrl: null,
    error: '',
  };
  let stream = null;
  let track = null;
  let players = [];
  const pcs = new Map(); // link id -> { pc, peer, dir, audio }
  const queues = new Map(); // link id -> promise chain: signaling is applied strictly in order

  const changed = () => onChange(st);

  // --- the https address to suggest when this page cannot use the mic
  fetch('/config.json')
    .then((r) => r.json())
    .then((c) => {
      if (c.httpsPort) st.httpsUrl = `https://${location.hostname}:${c.httpsPort}${location.pathname}${location.search}`;
      changed();
    })
    .catch(() => {});

  async function startMic() {
    if (!outLinks.length) return;
    if (!st.secure) return set('insecure');
    if (!st.supported) return set('unavailable');
    const pref = readMicPref();
    if (pref.off) return set('disabled');
    set('asking');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: pref.deviceId ? { ideal: pref.deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      track = stream.getAudioTracks()[0];
      track.enabled = false; // push-to-talk: silent until held
      track.onended = () => {
        set('unavailable');
        closeAll('out');
      };
      set('on');
      sync();
    } catch (e) {
      st.error = e.name || String(e);
      set(e.name === 'NotAllowedError' ? 'denied' : 'unavailable');
    }
  }
  function set(mic) {
    st.mic = mic;
    changed();
  }

  // ------------------------------------------------------------- links
  function close(id) {
    const e = pcs.get(id);
    if (!e) return;
    pcs.delete(id);
    try {
      e.pc.close();
    } catch {}
    if (e.audio) {
      e.audio.srcObject = null;
      e.audio.remove();
    }
    changed();
  }
  function closeAll(dir) {
    for (const [id, e] of pcs) if (!dir || e.dir === dir) close(id);
  }

  // open/close our outgoing links to match who is in the room
  function sync() {
    for (const link of outLinks) {
      const listener = players.find((p) => p.role === link.to);
      const cur = pcs.get(link.id);
      if (!listener || !track) {
        if (cur) close(link.id);
        continue;
      }
      const dead = cur && ['failed', 'closed'].includes(cur.pc.connectionState);
      if (!cur || cur.peer !== listener.id || dead) {
        if (cur) close(link.id);
        call(link, listener.id);
      }
    }
    for (const [id, e] of pcs) {
      if (e.dir !== 'in') continue;
      if (!players.some((p) => p.role === e.link.from)) close(id);
    }
  }

  function wire(entry) {
    const { pc, link } = entry;
    pc.onicecandidate = (ev) => {
      if (ev.candidate) net.send({ t: 'rtc', link: link.id, kind: 'ice', cand: ev.candidate.toJSON() });
    };
    pc.onconnectionstatechange = changed;
  }

  async function call(link, peer) {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const entry = { pc, peer, dir: 'out', link };
    pcs.set(link.id, entry);
    wire(entry);
    pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    try {
      await pc.setLocalDescription(await pc.createOffer());
      if (pcs.get(link.id) !== entry) return;
      net.send({ t: 'rtc', link: link.id, kind: 'offer', sdp: pc.localDescription.sdp });
    } catch (e) {
      st.error = String(e);
      close(link.id);
    }
    changed();
  }

  async function onRtc(m) {
    const link = linkById(m.link);
    if (!link) return;
    if (m.kind === 'offer') {
      if (link.to !== role || deaf) return;
      close(link.id);
      const pc = new RTCPeerConnection({ iceServers: [] });
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.hidden = true;
      audio.dataset.voice = link.from;
      document.body.append(audio);
      const entry = { pc, peer: m.peer, dir: 'in', link, audio };
      pcs.set(link.id, entry);
      wire(entry);
      pc.ontrack = (ev) => {
        audio.srcObject = ev.streams[0] || new MediaStream([ev.track]);
        play(audio);
      };
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      net.send({ t: 'rtc', link: link.id, kind: 'answer', sdp: pc.localDescription.sdp });
      changed();
      return;
    }
    const e = pcs.get(link.id);
    if (!e) return;
    if (m.kind === 'answer' && e.dir === 'out' && e.pc.signalingState === 'have-local-offer') {
      await e.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
    } else if (m.kind === 'ice') {
      await e.pc.addIceCandidate(m.cand).catch(() => {});
    } else if (m.kind === 'bye') close(link.id);
  }

  function play(audio) {
    audio.play().then(
      () => {
        if (st.blocked) {
          st.blocked = false;
          changed();
        }
      },
      () => {
        st.blocked = true; // the browser wants a click first
        changed();
      },
    );
  }

  net.on('rtc', (m) => {
    const q = (queues.get(m.link) || Promise.resolve()).then(() => onRtc(m)).catch((e) => (st.error = String(e)));
    queues.set(m.link, q);
  });
  net.on('rtc-error', (m) => {
    st.error = `${m.link}: ${m.reason}`;
    if (m.reason === 'peer absent') close(m.link);
    changed();
  });
  net.on('talk', (m) => {
    if (deaf || !st.hears.includes(m.role)) return;
    st.talking[m.role] = !!m.on;
    changed();
  });
  // a dropped connection is retried by the speaker
  setInterval(sync, 3000);

  // -------------------------------------------------------- push-to-talk
  function apply() {
    const live = !!track && (st.ptt || st.open);
    if (track) track.enabled = live;
    if (live !== st.live) {
      st.live = live;
      net.send({ t: 'ptt', on: live });
    }
    changed();
  }

  // ----------------------------------------------------------- readings
  async function stats() {
    const out = [];
    for (const [id, e] of pcs) {
      const r = { id, dir: e.dir, conn: e.pc.connectionState, direction: null, bytes: 0, packets: 0, level: 0 };
      r.direction = e.pc.getTransceivers()[0]?.currentDirection || null;
      try {
        const rep = await e.pc.getStats();
        rep.forEach((x) => {
          if (e.dir === 'out' && x.type === 'outbound-rtp' && x.kind === 'audio') {
            r.bytes = x.bytesSent;
            r.packets = x.packetsSent;
          }
          if (e.dir === 'out' && x.type === 'media-source' && x.kind === 'audio') r.level = x.audioLevel || 0;
          if (e.dir === 'in' && x.type === 'inbound-rtp' && x.kind === 'audio') {
            r.bytes = x.bytesReceived;
            r.packets = x.packetsReceived;
            r.level = x.audioLevel || 0;
            r.energy = x.totalAudioEnergy || 0;
            r.jitterMs = Math.round((x.jitterBufferDelay / Math.max(1, x.jitterBufferEmittedCount)) * 1000);
          }
        });
      } catch {}
      out.push(r);
    }
    return out;
  }

  return {
    state: st,
    start: startMic,
    setPlayers(p) {
      players = p || [];
      sync();
    },
    setPtt(on) {
      if (st.ptt === !!on) return;
      st.ptt = !!on;
      apply();
    },
    toggleOpen() {
      st.open = !st.open;
      apply();
    },
    // first user gesture: let blocked voice play
    resume() {
      for (const e of pcs.values()) if (e.audio?.srcObject) play(e.audio);
    },
    links: () => [...pcs.values()].map((e) => ({ id: e.link.id, dir: e.dir, conn: e.pc.connectionState })),
    stats,
  };
}
