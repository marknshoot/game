// RELAY prototype — rendering for the three private screens.
import { LEVEL, PPM } from './level.js';
import { TUNING, solidsOf } from './sim.js';

export const COL = {
  bg: '#05070c',
  floor: '#161b26',
  floorTop: '#7f9cd8',
  wall: '#10141d',
  span: '#55617f',
  spanTop: '#9fb6e8',
  door: '#2b3446',
  chalk: '#ffd257',
  runner: '#e8f0ff',
  hazard: '#ff5a4d',
  ok: '#4de08a',
  warn: '#ffb44d',
  accent: '#5ad1ff',
};

export function setupCanvas(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  const w = Math.max(320, Math.floor(r.width * dpr));
  const h = Math.max(200, Math.floor(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { ctx, w, h, dpr };
}

export function makeCam(w, h, s, viewW = 30) {
  // frame by height, then clamp the horizontal window so every window shape
  // (wide-short, tall-narrow, solo panel) shows a sane amount of world
  let scale = h / 13;
  scale = Math.min(scale, w / 14);
  scale = Math.max(scale, w / 34);
  const vw = w / scale;
  const vh = h / scale;

  // ground line sits ~42% up from the bottom, runner always in frame
  let bottom = -0.42 * vh;
  const headroom = s.runner.y + 6;
  if (headroom > bottom + vh) bottom = headroom - vh;

  let x = s.runner.x;
  const minX = -4 + vw / 2;
  const maxX = LEVEL.endX - vw / 2;
  if (minX > maxX) x = (minX + maxX) / 2;
  else x = Math.max(minX, Math.min(maxX, x));

  return {
    scale,
    x,
    bottom,
    viewW: vw,
    viewH: vh,
    tx: (mx) => (mx - x) * scale + w / 2,
    ty: (my) => h - (my - bottom) * scale,
    toWorld: (px, py) => ({ x: (px - w / 2) / scale + x, y: (h - py) / scale + bottom }),
  };
}

function rect(ctx, cam, x, y, w, h) {
  ctx.fillRect(cam.tx(x), cam.ty(y + h), w * cam.scale, h * cam.scale);
}

// ---------------------------------------------------------------- world view
export function drawWorld(ctx, s, cam, opts = {}) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, w, h);

  // --- geometry (silhouettes only: no colours, no labels, no state)
  const drawSolid = (b, fill, top) => {
    ctx.fillStyle = fill;
    rect(ctx, cam, b.x, b.y, b.w, b.h);
    ctx.fillStyle = top;
    rect(ctx, cam, b.x, b.y + b.h - 0.08, b.w, 0.08);
  };

  const solids = solidsOf(s);
  for (const b of solids) {
    if (b.kind === 'floor') drawSolid(b, COL.floor, COL.floorTop);
    else if (b.kind === 'wall') drawSolid(b, COL.wall, '#243049');
    else if (b.kind === 'door') drawSolid(b, COL.door, '#3a4763');
  }

  // the phantom floor: identical to real floor as far as the Runner can tell.
  const c = LEVEL.camo;
  drawSolid({ x: c.x0, y: -1, w: c.x1 - c.x0, h: 1 }, COL.floor, COL.floorTop);

  // the slide bridge (partial extension while moving)
  const sp = s.span;
  if (sp.phase !== 'out') {
    let ext = 1;
    if (sp.phase === 'moving') ext = 1 - Math.max(0, sp.timer) / TUNING.spanTravel;
    if (sp.phase === 'retracting') ext = Math.max(0, sp.timer) / TUNING.spanRetract;
    ctx.fillStyle = COL.span;
    rect(ctx, cam, LEVEL.span.x, LEVEL.span.y, LEVEL.span.w * ext, LEVEL.span.h);
    ctx.fillStyle = COL.spanTop;
    rect(ctx, cam, LEVEL.span.x, LEVEL.span.y + LEVEL.span.h - 0.08, LEVEL.span.w * ext, 0.08);
  }

  // housing prop (the thing the Runner can "feel")
  ctx.strokeStyle = '#3c4864';
  ctx.lineWidth = Math.max(1, cam.scale * 0.07);
  const hz = LEVEL.housing;
  ctx.strokeRect(cam.tx(hz.x), cam.ty(hz.h), hz.w * cam.scale, hz.h * cam.scale);

  // exit doorway
  ctx.strokeStyle = '#41506f';
  ctx.strokeRect(cam.tx(LEVEL.exit.x - 0.2), cam.ty(LEVEL.exit.h + 0.5), (LEVEL.exit.w + 0.4) * cam.scale, (LEVEL.exit.h + 0.5) * cam.scale);

  // --- ghost trail (last seconds, for the blame replay)
  if (opts.ghost && s.dead && s.ghost.length > 2) {
    for (let i = 0; i < s.ghost.length; i += 3) {
      const g = s.ghost[i];
      const a = 0.05 + 0.4 * (i / s.ghost.length);
      ctx.fillStyle = `rgba(255,110,110,${a})`;
      ctx.fillRect(cam.tx(g.x), cam.ty(g.y + 0.8), cam.scale * 0.2, cam.scale * 0.2);
    }
  }

  // --- runner
  const r = s.runner;
  ctx.fillStyle = COL.runner;
  const rw = TUNING.runnerW * cam.scale;
  const rh = TUNING.runnerH * cam.scale;
  const rx = cam.tx(r.x) - rw / 2;
  const ry = cam.ty(r.y + TUNING.runnerH);
  ctx.globalAlpha = s.dead ? 0.25 : 1;
  ctx.fillRect(rx, ry, rw, rh * 0.72);
  ctx.beginPath();
  ctx.arc(cam.tx(r.x), ry + rh * 0.84, rh * 0.14, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // --- vignette: the Runner only sees a few metres of raw shape
  if (opts.vignette) {
    const r0 = Math.max(2.6, cam.scale * 2.6);
    const r1 = Math.max(r0 + 40, cam.scale * 10.5);
    const g = ctx.createRadialGradient(cam.tx(r.x), cam.ty(r.y + 1), r0, cam.tx(r.x), cam.ty(r.y + 1), r1);
    g.addColorStop(0, 'rgba(3,5,10,0)');
    g.addColorStop(0.55, 'rgba(3,5,10,0.55)');
    g.addColorStop(1, 'rgba(3,5,10,1)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  // --- chalk arrows (the Bridge's only spatial channel; always on top)
  for (const k of s.chalk) {
    drawChalk(ctx, cam, k);
  }

  ctx.globalAlpha = 1;
}

function drawChalk(ctx, cam, k) {
  const px = cam.tx(k.x);
  const py = cam.ty(k.y + 1.1);
  ctx.save();
  ctx.translate(px, py);
  ctx.strokeStyle = COL.chalk;
  ctx.lineWidth = Math.max(2, cam.scale * 0.13);
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.95;
  const L = 1.1 * cam.scale;
  ctx.beginPath();
  if (k.dir === 'up') {
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -L);
    ctx.moveTo(0, -L);
    ctx.lineTo(-L * 0.4, -L * 0.6);
    ctx.moveTo(0, -L);
    ctx.lineTo(L * 0.4, -L * 0.6);
  } else if (k.dir === 'down') {
    ctx.moveTo(0, 0);
    ctx.lineTo(0, L);
    ctx.moveTo(0, L);
    ctx.lineTo(-L * 0.4, L * 0.6);
    ctx.moveTo(0, L);
    ctx.lineTo(L * 0.4, L * 0.6);
  } else {
    const d = k.dir === 'left' ? -1 : 1;
    ctx.moveTo(-L * 0.5 * d, 0);
    ctx.lineTo(L * 0.5 * d, 0);
    ctx.moveTo(L * 0.5 * d, 0);
    ctx.lineTo(L * 0.1 * d, -L * 0.35);
    ctx.moveTo(L * 0.5 * d, 0);
    ctx.lineTo(L * 0.1 * d, L * 0.35);
  }
  ctx.stroke();
  ctx.restore();
}

// ------------------------------------------------------------ schematic view
// The Operator's console (and the same board mirrored to the Bridge).
// Full level, live system state, hazard markers — and NO runner marker.
export function drawSchematic(ctx, s, opts = {}) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#080d16';
  ctx.fillRect(0, 0, w, h);

  const pad = 14;
  const x0 = -5;
  const x1 = LEVEL.endX + 2;
  const scale = (w - pad * 2) / (x1 - x0);
  const groundPx = h - pad - Math.max(40, h * 0.22);

  const X = (mx) => pad + (mx - x0) * scale;
  const Y = (my) => groundPx - my * scale;

  // grid
  ctx.strokeStyle = 'rgba(90,209,255,0.08)';
  ctx.lineWidth = 1;
  const g = LEVEL.grid;
  for (let i = 0; i < g.labels.length; i++) {
    const gx = g.from + i * g.step;
    const px = X(gx);
    ctx.beginPath();
    ctx.moveTo(px, pad);
    ctx.lineTo(px, groundPx);
    ctx.stroke();
    ctx.fillStyle = 'rgba(90,209,255,0.45)';
    ctx.font = `600 ${Math.max(9, h * 0.032)}px ui-monospace,monospace`;
    ctx.fillText(g.labels[i], px + 3, groundPx - 4);
  }

  // floor line
  ctx.strokeStyle = '#2f4266';
  ctx.lineWidth = 3;
  const seg = (a, b) => {
    ctx.beginPath();
    ctx.moveTo(X(a), groundPx);
    ctx.lineTo(X(b), groundPx);
    ctx.stroke();
  };
  // floors, minus the real gap and minus the phantom floor
  ctx.strokeStyle = '#3d5a8a';
  seg(x0, LEVEL.gap.x0);
  seg(LEVEL.gap.x1, LEVEL.camo.x0);
  seg(LEVEL.camo.x1, LEVEL.endX);

  // hazard strip over the phantom floor
  ctx.fillStyle = 'rgba(255,90,77,0.28)';
  ctx.fillRect(X(LEVEL.camo.x0), groundPx - 3, (LEVEL.camo.x1 - LEVEL.camo.x0) * scale, 6);
  ctx.fillStyle = COL.hazard;
  ctx.font = `700 ${Math.max(10, h * 0.04)}px ui-monospace,monospace`;
  ctx.fillText('\u25B2 D4', X(LEVEL.camo.x0), groundPx - 10);

  // gap marker
  ctx.fillStyle = COL.warn;
  ctx.fillText('GAP A3', X(LEVEL.gap.x0), groundPx - 10);

  // span state
  const sp = s.span;
  const spanCol = sp.phase === 'extended' ? COL.ok : sp.phase === 'out' ? '#39435c' : COL.warn;
  ctx.strokeStyle = spanCol;
  ctx.lineWidth = 4;
  const ext = sp.phase === 'out' ? 0 : sp.phase === 'extended' ? 1 : sp.phase === 'moving' ? 1 - sp.timer / TUNING.spanTravel : sp.timer / TUNING.spanRetract;
  ctx.beginPath();
  ctx.moveTo(X(LEVEL.span.x), groundPx);
  ctx.lineTo(X(LEVEL.span.x + LEVEL.span.w * Math.max(0.02, ext)), groundPx);
  ctx.stroke();
  ctx.fillStyle = spanCol;
  ctx.fillText(`SPAN ${sp.phase.toUpperCase()}`, X(LEVEL.span.x), groundPx + Math.max(16, h * 0.07));

  // motor temp
  const hot = sp.throws.filter((t) => s.t - t < TUNING.motorWindow).length;
  const locked = sp.lockUntil > s.t;
  ctx.fillStyle = locked ? COL.hazard : hot >= 1 ? COL.warn : '#4a5a78';
  ctx.fillText(locked ? `MOTOR LOCKED ${(sp.lockUntil - s.t).toFixed(1)}s` : `MOTOR ${hot}/${TUNING.motorMax}`, X(LEVEL.span.x), groundPx + Math.max(28, h * 0.12));

  // exit state
  const ex = s.exit;
  const exCol = ex.open ? COL.ok : ex.armed ? COL.warn : '#4a5a78';
  ctx.fillStyle = exCol;
  ctx.fillRect(X(LEVEL.exit.x), Y(LEVEL.exit.h), LEVEL.exit.w * scale, LEVEL.exit.h * scale);
  ctx.fillText(ex.open ? 'EXIT OPEN' : ex.armed ? `EXIT ARMED ${s.key.hold.toFixed(1)}/${TUNING.keyHoldTime}s` : 'EXIT LOCKED', X(LEVEL.exit.x - 2.4), Y(LEVEL.exit.h + 0.9));

  // stamps placed by the Operator (the Bridge's board)
  const now = s.t;
  for (const st of s.stamps) {
    const age = now - st.t;
    if (age > 6) continue;
    const a = Math.max(0, 1 - age / 6);
    ctx.globalAlpha = a;
    ctx.fillStyle = COL.accent;
    ctx.beginPath();
    ctx.arc(X(st.x), groundPx - 22, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#04121c';
    ctx.font = '700 9px ui-monospace,monospace';
    ctx.fillText(st.icon, X(st.x) - 3.5, groundPx - 19);
    ctx.globalAlpha = 1;
  }

  if (opts.noRunnerNote) {
    ctx.fillStyle = 'rgba(255,180,77,0.75)';
    ctx.font = `600 ${Math.max(10, h * 0.038)}px ui-monospace,monospace`;
    ctx.fillText('NO LIVE RUNNER FEED', pad, pad + 12);
  }
}

// Bridge-only overlay: metres and seconds until the next beat.
export function nextBeat(s) {
  const r = s.runner.x;
  for (const b of LEVEL.beats) {
    const d = b.x - r;
    if (d < -1.5) continue;
    const t = Math.max(0, d / Math.max(0.1, s.runner.vx || TUNING.runSpeed));
    return { ...b, dist: d, eta: t, call: d <= b.callLead && d > b.callLead - 3.0 };
  }
  return null;
}
