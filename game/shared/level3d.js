// RELAY 3D — level geometry and beat definitions. Pure data, no three.js, no DOM.
// Shared by the server (authoritative sim) and the browser (rendering + prediction).
// +Z is forward down the gantry, +Y is up. All units are metres.

const b = (x0, x1, y0, y1, z0, z1, kind, extra = {}) => ({ x0, x1, y0, y1, z0, z1, kind, ...extra });

export const LEVEL = {
  name: 'GANTRY RELAY — 3D',
  corridor: { wallX: 4, ceil: 5 },
  start: { x: 0, y: 0, z: 2 },
  checkpoints: [
    { z: 2, y: 0 },
    { z: 28, y: 0 },
    { z: 46, y: 0 },
    { z: 55.6, y: 4.2 }, // on the catwalk, after the lift
  ],
  killY: -8,
  endZ: 70,

  gap: { z0: 18, z1: 26 }, // no floor: needs the slide bridge
  phantom: { z0: 44, z1: 45.8 }, // floor that is a lie (no collider, identical mesh)
  // deck bottom y: at `down` the deck top sits flush with the corridor floor (0),
  // at `up` the deck top sits flush with the catwalk (4.2) — no step-up anywhere
  lift: { x0: -2, x1: 2, z0: 51, z1: 55, down: -0.35, up: 3.85 },
  catwalk: { x0: -1.9, x1: 1.9, y: 4.2, segs: [[55, 57.5], [60.5, 63.6]] },
  exit: { z: 63.0, x0: -2.5, x1: 2.5, y0: 4.2, y1: 7.6 },
  win: { z: 64.6, y: 3.4 },

  // colliders (static). Dynamic ones (span / lift / door) are added by solidsOf().
  boxes: [
    // ---- floor, in three runs: the gap and the phantom hole are the two holes
    b(-6, 4, -1, 0, -6, 18, 'floor'),
    b(-4, 4, -1, 0, 26, 44, 'floor'),
    b(-4, 4, -1, 0, 45.8, 64, 'floor'),
    // ---- side walls
    b(-4.4, -4, 0, 5, -6, 64, 'wall'),
    b(4, 4.4, 0, 5, -6, 64, 'wall'),
    b(-4.4, 4.4, 0, 5, -6.4, -6, 'wall'),
    // ---- lower corridor is blocked at the end: the catwalk is the only way out
    b(-4, 4, 0, 4.2, 63.8, 64.2, 'wall'),
    // ---- catwalk (top surface y = 4.2), with a 3 m jump between the two runs
    b(-1.9, 1.9, 3.9, 4.2, 55, 57.5, 'catwalk'),
    b(-1.9, 1.9, 3.9, 4.2, 60.5, 63.6, 'catwalk'),
    b(-1.9, 1.9, 3.9, 4.2, 63.6, 66, 'catwalk'),
    b(-3.2, 3.2, 3.9, 4.2, 57.5, 57.6, 'rail'), // lip so a fall is readable
    // ---- platform lips that make the pit edges honest
    b(-4, 4, -0.4, 0, 17.6, 18, 'lip'),
    b(-4, 4, -0.4, 0, 26, 26.4, 'lip'),
    b(-4, 4, -0.4, 0, 43.6, 44, 'lip'),
    b(-4, 4, -0.4, 0, 45.8, 46.2, 'lip'),
    // ---- exit platform behind the door
    b(-3, 3, -1, 0, 64, 70, 'floor'),
    b(-1.9, 1.9, 3.9, 4.2, 66, 70, 'catwalk'),
    b(-3, 3, 4.2, 7.6, 66, 66.4, 'wall'),
  ],

  // the slide bridge (dynamic): top surface flush with the floor at y = 0
  span: { x0: -4, x1: 4, z0: 18, z1: 26, y: -0.45, h: 0.45 },

  // decorative props (no colliders) — also used to make the two floors look identical
  props: { pillarEvery: 8, trussEvery: 6, lightEvery: 8 },

  beats: [
    { kind: 'span', z: 18, label: 'SPAN  z18', callLead: 9.0, why: 'slab needs 0.7 s to slide out' },
    { kind: 'pit', z: 44, label: 'PHANTOM FLOOR  z44', callLead: 4.5, why: 'he cannot see it; his reaction costs ~0.3 s' },
    { kind: 'lift', z: 51, label: 'LIFT  z51', callLead: 2.5, why: 'he must be ON it before the Operator raises it' },
    { kind: 'exit', z: 63, label: 'TWO-KEY EXIT  z63', callLead: 5.0, why: 'the Operator arms it, you hold the second key' },
  ],
};

export function gridLabel(z) {
  const i = Math.max(0, Math.min(11, Math.floor((z + 6) / 6)));
  return 'ABCDEFGHIJKL'[i];
}

export function boxList() {
  return LEVEL.boxes;
}

export function phantomBox() {
  return b(LEVEL.phantom.z0, LEVEL.phantom.z1, -1, 0, LEVEL.phantom.z0, LEVEL.phantom.z1, 'phantom');
}

// The identical-looking floor mesh over the hole: same extents as a real floor run.
export function phantomMesh() {
  return {
    x0: -4,
    x1: 4,
    y0: -1,
    y1: 0,
    z0: LEVEL.phantom.z0,
    z1: LEVEL.phantom.z1,
  };
}
