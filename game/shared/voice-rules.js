// RELAY 3D — who can hear whom. Pure data + validation, shared by the server (which
// enforces it) and the browser (which only ever tries to open the links listed here).
//
//   Bridge  ──voice──▶ Runner        the Bridge is the only voice on the team
//   Bridge  ──voice──▶ Operator
//   Runner  ──voice──▶ Operator      the Runner can shout to the Operator, who cannot answer
//
// The Operator has no outgoing link (mute) and the Bridge no incoming one (deaf).
// Each link is one-way: one WebRTC connection, audio only, sendonly at the speaker and
// recvonly at the listener. The server refuses any offer or answer that breaks that.

export const VOICE_LINKS = [
  { id: 'bridge>runner', from: 'bridge', to: 'runner' },
  { id: 'bridge>operator', from: 'bridge', to: 'operator' },
  { id: 'runner>operator', from: 'runner', to: 'operator' },
];

export const linkById = (id) => VOICE_LINKS.find((l) => l.id === id) || null;
export const talksTo = (role) => VOICE_LINKS.filter((l) => l.from === role).map((l) => l.to);
export const hears = (role) => VOICE_LINKS.filter((l) => l.to === role).map((l) => l.from);

export const MAX_SDP = 12000;
const DIR_RE = /^a=(sendrecv|sendonly|recvonly|inactive)\s*$/m;

// side: 'offer' (written by the speaker) or 'answer' (written by the listener).
// Returns null when the SDP is acceptable, or a short reason when it is not.
export function checkSdp(sdp, side) {
  if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || sdp.length > MAX_SDP) return 'malformed sdp';
  const parts = sdp.split(/\r?\n(?=m=)/);
  const session = parts[0];
  const sections = parts.slice(1);
  if (!sections.length) return 'no media';
  const allowed = side === 'offer' ? ['sendonly', 'inactive'] : ['recvonly', 'inactive'];
  const sessionDir = (session.match(DIR_RE) || [])[1] || null;
  if (sessionDir && !allowed.includes(sessionDir)) return `session direction ${sessionDir}`;
  for (const sec of sections) {
    const kind = (sec.match(/^m=(\w+)/) || [])[1];
    if (kind !== 'audio') return `media ${kind || '?'} not allowed (audio only)`;
    const dir = (sec.match(DIR_RE) || [])[1] || sessionDir || 'sendrecv';
    if (!allowed.includes(dir)) return `direction ${dir} not allowed in ${side}`;
  }
  return null;
}

// ICE candidates are small, flat objects; anything else is not relayed.
export function cleanCandidate(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.candidate !== 'string' || c.candidate.length > 600) return null;
  return {
    candidate: c.candidate,
    sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 32) : null,
    sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null,
    usernameFragment: typeof c.usernameFragment === 'string' ? c.usernameFragment.slice(0, 64) : null,
  };
}
