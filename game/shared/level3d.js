// RELAY 3D — the showcase level. Pure data + layout helpers, no three.js, no DOM.
// Shared by the server (authoritative sim) and the browser (rendering + prediction).
// +Z is forward down the gantry, +Y is up, the Runner looks down +Z, so screen-RIGHT is -X.
//
// Four sections, each started from a STATION where the Runner stands still until he
// commits (W). Between stations he cannot stop: he only steers, jumps and briefly braces.
//
//   S1  THE SPAN        z 2→28   the Operator throws a one-lane bridge, on the Bridge's call;
//                                 which lane it slides out in is rolled every attempt
//   S2  THE DARK HALL   z 28→50  a vast chamber; 9 identical floor tiles, 6 are lies. Only the
//                                 Operator's board shows which. He stamps, the Bridge chalks.
//   S3  PRESS + LIFT    z 50→65  the Operator holds a crusher up on the Bridge's count, then
//                                 raises a lift he cannot see the Runner standing on
//   S4  COLLAPSE        z 65→86  the catwalk falls away behind him; a two-key door ahead

const b = (x0, x1, y0, y1, z0, z1, kind, extra = {}) => ({ x0, x1, y0, y1, z0, z1, kind, ...extra });

export const LANE_W = 8 / 3;

export const LEVEL = {
  name: 'GANTRY RELAY',
  corridor: { wallX: 4, ceil: 5 },
  start: { x: 0, y: 0, z: 2 },
  stations: [
    { z: 2, y: 0, name: 'START' },
    { z: 28, y: 0, name: 'HALL DOOR' },
    { z: 50, y: 0, name: 'PRESS BAY' },
    { z: 65.2, y: 4.2, name: 'CATWALK' },
  ],
  killY: -8,
  endZ: 90,

  gap: { z0: 18, z1: 26 },
  // a one-lane slide bridge; which of the three lanes it slides out in is rolled per attempt
  span: { x0: -4, x1: 4, z0: 18, z1: 26, y: -0.45, h: 0.45 },

  hall: { z0: 30, z1: 48, segLen: 6, segs: 3, lanes: 3, x0: -4, x1: 4 },
  chamber: { x: 14, z0: 29.6, z1: 48.4, y0: -10, y1: 16 },

  press: { x0: -4, x1: 4, z0: 56, z1: 58, upY: 2.4, h: 2.6 },
  lift: { x0: -4, x1: 4, z0: 60, z1: 64, down: -0.35, up: 3.85 },
  catwalk: { x0: -2.5, x1: 2.5, y: 4.2, segs: [[64, 72], [75, 90]] },
  collapse: { z0: 64, end: 84.6, delay: 0.4, speed: 6.6 }, // stops just past the door
  exit: { z: 84, x0: -2.5, x1: 2.5, y0: 4.2, y1: 7.6 },
  win: { z: 86, y: 3.4 },

  // static colliders. Dynamic ones (span, hall tiles, lift, catwalk, door) come from solidsOf().
  boxes: [
    // ---- floor runs: the span gap, the hall (tiles only), the lift shaft are the holes
    b(-4, 4, -1, 0, -6, 18, 'floor'),
    b(-4, 4, -1, 0, 26, 30, 'floor'),
    b(-4, 4, -1, 0, 48, 60, 'floor'),
    // ---- corridor walls (the hall has none: it is a chamber)
    b(-4.4, -4, 0, 5, -6, 29.6, 'wall'),
    b(4, 4.4, 0, 5, -6, 29.6, 'wall'),
    b(-4.4, -4, 0, 5, 48.4, 64.4, 'wall'),
    b(4, 4.4, 0, 5, 48.4, 64.4, 'wall'),
    b(-4.4, 4.4, 0, 5, -6.4, -6, 'wall'),
    // ---- lift shaft: open below the deck, closed at the far end up to the catwalk
    b(-4, 4, -8, -1, 59.6, 60, 'wall'),
    b(-4, 4, -8, 4.2, 64, 64.4, 'wall'),
    // ---- lips that make pit edges honest
    b(-4, 4, -0.4, 0, 17.6, 18, 'lip'),
    b(-4, 4, -0.4, 0, 26, 26.4, 'lip'),
    b(-4, 4, -0.4, 0, 48, 48.4, 'lip'),
    b(-4, 4, -0.4, 0, 59.6, 60, 'lip'),
    // ---- catwalk side rails (no falling off sideways) and the end wall
    b(-2.9, -2.5, 4.2, 5.3, 64, 90, 'rail'),
    b(2.5, 2.9, 4.2, 5.3, 64, 90, 'rail'),
    b(-2.9, 2.9, 4.2, 8, 90, 90.4, 'wall'),
    // ---- the chamber around the hall (out of reach: scenery for the sonar)
    b(-14.4, -14, -10, 16, 29.6, 48.4, 'deco'),
    b(14, 14.4, -10, 16, 29.6, 48.4, 'deco'),
    b(-14, -4, -10, 16, 29.6, 30, 'deco'),
    b(4, 14, -10, 16, 29.6, 30, 'deco'),
    b(-4, 4, 5, 16, 29.6, 30, 'deco'),
    b(-14, -4, -10, 16, 48, 48.4, 'deco'),
    b(4, 14, -10, 16, 48, 48.4, 'deco'),
    b(-4, 4, 5, 16, 48, 48.4, 'deco'),
  ],

  props: { pillarEvery: 8, trussEvery: 6 },

  // `callLead` (metres before the beat) is only shown to the Bridge in assist mode
  beats: [
    { kind: 'span', z: 18, label: 'SPAN  z18', callLead: 8.0, why: 'one-lane bridge, 0.7 s to slide out, holds 1.2 s' },
    { kind: 'hall', z: 30, label: 'DARK HALL  z30–48', callLead: 4.0, why: 'six of nine tiles are lies; only the Operator sees which' },
    { kind: 'press', z: 56, label: 'PRESS  z56', callLead: 6.0, why: 'the Operator holds it up for at most 1.2 s' },
    { kind: 'lift', z: 60, label: 'LIFT  z60', callLead: 2.0, why: 'raise it early and he falls down the shaft' },
    { kind: 'exit', z: 84, label: 'COLLAPSE + TWO-KEY EXIT  z84', callLead: 19, why: 'arm, then the key, before the catwalk catches him' },
  ],
};

// ------------------------------------------------------------- hall layout
// lane 0 is world -X (the Runner's RIGHT), lane 2 is +X (his LEFT)
export const LANE_NAME = ['RIGHT', 'CENTRE', 'LEFT'];
export const laneX = (lane) => LEVEL.hall.x0 + LANE_W * (lane + 0.5);

export function hallTiles(layout) {
  const H = LEVEL.hall;
  const out = [];
  for (let seg = 0; seg < H.segs; seg++) {
    for (let lane = 0; lane < H.lanes; lane++) {
      out.push({
        seg,
        lane,
        x0: H.x0 + LANE_W * lane,
        x1: H.x0 + LANE_W * (lane + 1),
        y0: -1,
        y1: 0,
        z0: H.z0 + H.segLen * seg,
        z1: H.z0 + H.segLen * (seg + 1),
        fake: !!layout && layout.hall[seg] !== lane,
      });
    }
  }
  return out;
}

export function spanX(layout) {
  const lane = layout ? layout.spanLane : 1;
  return [LEVEL.hall.x0 + LANE_W * lane, LEVEL.hall.x0 + LANE_W * (lane + 1)];
}

export function gridLabel(z) {
  const i = Math.max(0, Math.min(15, Math.floor((z + 6) / 6)));
  return 'ABCDEFGHIJKLMNOP'[i];
}

export function boxList() {
  return LEVEL.boxes;
}
