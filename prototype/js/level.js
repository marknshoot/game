// RELAY prototype — level definition.
// All units are meters. +y is up. Ground top surface is y = 0.

export const PPM = 34; // pixels per meter at zoom 1

export const LEVEL = {
  name: 'GANTRY-03  "Two-Key Catwalk"',
  spawnX: 2,
  // x thresholds that become the respawn point once passed
  checkpoints: [
    { x: 2, at: 2 },
    { x: 30, at: 30 },
    { x: 40, at: 40 },
    { x: 50, at: 50 },
  ],
  killY: -6,

  gap: { x0: 18, x1: 26 }, // 8 m pit — requires the slide bridge
  housing: { x: 16.2, w: 1.5, h: 0.55 }, // the "you feel a dead slide-out span" prop
  camo: { x0: 44, x1: 45.8 }, // phantom floor: looks solid, is not
  exit: { x: 62, w: 1.2, h: 3.2 },
  backWall: 63.6,
  endX: 66,

  // static collision boxes (top of each box is a walkable surface)
  solids: [
    { x: -4, y: -1, w: 22, h: 1, kind: 'floor' }, //  -4 .. 18
    { x: 26, y: -1, w: 18, h: 1, kind: 'floor' }, //  26 .. 44
    { x: 45.8, y: -1, w: 18.2, h: 1, kind: 'floor' }, //  45.8 .. 64
    { x: -4, y: -1, w: 0.6, h: 8, kind: 'wall' }, // left wall
  ],

  span: { x: 18, y: -0.45, w: 8, h: 0.45 }, // slide bridge: top surface flush with the floor

  // grid used by the operator's stamps (columns only — it is a side view)
  grid: { from: 0, to: 72, step: 6, labels: 'ABCDEFGHIJKL' },

  // beats the Bridge must call. `callLead` = meters before the beat where
  // the Bridge should speak, given latency + the Operator's/Runner's reaction time.
  beats: [
    { kind: 'span', x: 18, label: 'GAP (A3)', callLead: 9.0, say: 'THROW / ON ONE', why: 'span needs 0.7 s to slide out' },
    { kind: 'pit', x: 44, label: 'PHANTOM FLOOR (D4)', callLead: 4.5, say: 'JUMP', why: 'he cannot see it; his reaction costs ~0.3 s' },
    { kind: 'exit', x: 62, label: 'TWO-KEY EXIT (F4)', callLead: 5.0, say: 'STOP / HOLD', why: 'he must wait for the armed door' },
  ],

  // hinted beats for the coach lines
  hints: {
    gap: { x: 18, label: 'GAP A3' },
    camo: { x: 45.5, label: 'HAZARD D4' },
    exit: { x: 62, label: 'EXIT F4' },
  },
};

export function gridLabel(x) {
  const g = LEVEL.grid;
  const i = Math.max(0, Math.min(g.labels.length - 1, Math.floor((x - g.from) / g.step)));
  return g.labels[i] || '?';
}
