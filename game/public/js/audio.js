// RELAY 3D — procedural audio. Zero dependencies and no audio files: every sound
// is synthesized from WebAudio oscillators, noise buffers, filters and gain
// envelopes. The Bridge is DEAF as a game rule, so createAudio('bridge') returns
// hard-muted no-ops that never construct an AudioContext, not even by accident.
import { LEVEL } from '../../shared/level3d.js';
import { TUNING } from '../../shared/sim3d.js';

const MASTER = 0.6;

export function createAudio(role) {
  if (role === 'bridge') {
    const mute = () => {};
    return {
      enabled: false,
      unlock: mute,
      update: mute,
      sonar: mute,
      knock: mute,
      footstep: mute,
      land: mute,
      death: mute,
      win: mute,
    };
  }

  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let hums = null;
  let unlocked = false;
  let lastArmed = null;
  let lastPress = null;
  let lastCollapse = null;
  let lastOpen = null;

  return {
    enabled: true,
    unlock,
    update,
    sonar,
    knock,
    footstep,
    land,
    death,
    win,
  };

  // --------------------------------------------------------------- lifecycle
  // Browsers only allow audio after a gesture, so the context is built lazily.
  function unlock() {
    unlocked = true;
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
    } catch {
      ctx = null;
      return;
    }
    master = ctx.createGain();
    master.gain.value = MASTER;
    master.connect(ctx.destination);
    buildHums();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  // ------------------------------------------------------------- node helpers
  function noiseBuffer() {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }

  function setPos(p, x, y, z) {
    if (p.positionX) {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    } else {
      p.setPosition(x, y, z);
    }
  }

  function pannerAt(x, y, z) {
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'linear';
    p.refDistance = 2;
    p.maxDistance = 30;
    p.rolloffFactor = 1;
    setPos(p, x, y, z);
    return p;
  }

  function setListener(x, y, z, fx, fy, fz) {
    const L = ctx.listener;
    if (L.positionX) {
      L.positionX.value = x;
      L.positionY.value = y;
      L.positionZ.value = z;
      L.forwardX.value = fx;
      L.forwardY.value = fy;
      L.forwardZ.value = fz;
      L.upX.value = 0;
      L.upY.value = 1;
      L.upZ.value = 0;
    } else {
      L.setPosition(x, y, z);
      L.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  // disconnect a short-lived graph once its source has stopped
  function freeOnEnd(source, ...chain) {
    source.onended = () => {
      for (const n of chain) {
        try {
          n.disconnect();
        } catch {
          /* already gone */
        }
      }
    };
  }

  // ------------------------------------------- continuous (reused) hum nodes
  function buildHums() {
    const now = ctx.currentTime;

    // span motor — the Runner's only cue that the bridge is out
    const sp = LEVEL.span;
    const spanOsc = ctx.createOscillator();
    spanOsc.type = 'sawtooth';
    spanOsc.frequency.value = 70;
    const spanFilter = ctx.createBiquadFilter();
    spanFilter.type = 'lowpass';
    spanFilter.frequency.value = 1400;
    const spanGain = ctx.createGain();
    spanGain.gain.value = 0;
    const spanPan = pannerAt((sp.x0 + sp.x1) / 2, sp.y + sp.h / 2, sp.z0);
    spanOsc.connect(spanFilter).connect(spanGain).connect(spanPan).connect(master);
    spanOsc.start(now);

    // lift deck
    const L = LEVEL.lift;
    const liftOsc = ctx.createOscillator();
    liftOsc.type = 'triangle';
    liftOsc.frequency.value = 58;
    const liftOsc2 = ctx.createOscillator();
    liftOsc2.type = 'sawtooth';
    liftOsc2.frequency.value = 87;
    const liftGain2 = ctx.createGain();
    liftGain2.gain.value = 0.35;
    const liftGain = ctx.createGain();
    liftGain.gain.value = 0;
    const liftPan = pannerAt((L.x0 + L.x1) / 2, 0.6, (L.z0 + L.z1) / 2);
    liftOsc.connect(liftGain).connect(liftPan).connect(master);
    liftOsc2.connect(liftGain2).connect(liftGain);
    liftOsc.start(now);
    liftOsc2.start(now);

    // exit door slab rumble
    const E = LEVEL.exit;
    const doorNoise = ctx.createBufferSource();
    doorNoise.buffer = noiseBuffer();
    doorNoise.loop = true;
    const doorFilter = ctx.createBiquadFilter();
    doorFilter.type = 'lowpass';
    doorFilter.frequency.value = 140;
    const doorGain = ctx.createGain();
    doorGain.gain.value = 0;
    const doorPan = pannerAt((E.x0 + E.x1) / 2, (E.y0 + E.y1) / 2, E.z);
    doorNoise.connect(doorFilter).connect(doorGain).connect(doorPan).connect(master);
    doorNoise.start(now);

    hums = {
      span: { osc: spanOsc, gain: spanGain },
      lift: { gain: liftGain, pan: liftPan },
      door: { gain: doorGain },
    };
  }

  // --------------------------------------------------------------- per frame
  function update(state, view, dt) {
    if (!ctx || !hums) return;
    const now = ctx.currentTime;

    // Listener: the Runner's ears sit at his eyes and turn with his yaw; the
    // Operator hears the whole gantry from a fixed seat.
    const r = view && view.runner;
    if (role === 'runner' && r) {
      const yaw = r.yaw || 0;
      setListener(r.x, r.y + 1.55, r.z, Math.sin(yaw), 0, Math.cos(yaw));
    } else {
      setListener(0, 4, 30, 0, 0, 1);
    }

    // span: rising whine, steady hum, falling whine, silence
    const sp = state.span;
    let spanFreq = 70;
    let spanGain = 0;
    if (sp.phase === 'moving') {
      spanFreq = 70 + 330 * (1 - Math.max(0, sp.timer) / TUNING.spanTravel);
      spanGain = 0.55;
    } else if (sp.phase === 'extended') {
      spanFreq = 95;
      spanGain = 0.4;
    } else if (sp.phase === 'retracting') {
      spanFreq = 400 - 330 * (1 - Math.max(0, sp.timer) / TUNING.spanRetract);
      spanGain = 0.5;
    }
    hums.span.osc.frequency.setTargetAtTime(spanFreq, now, 0.04);
    hums.span.gain.gain.setTargetAtTime(spanGain, now, 0.06);

    // lift: hum only while the deck is actually travelling
    hums.lift.gain.gain.setTargetAtTime(state.lift.moving ? 0.28 : 0, now, 0.08);
    setPos(hums.lift.pan, (LEVEL.lift.x0 + LEVEL.lift.x1) / 2, state.lift.y + 0.6, (LEVEL.lift.z0 + LEVEL.lift.z1) / 2);

    // exit door: clunk on arm/disarm, rumble while the slab slides
    if (lastArmed === null) lastArmed = state.exit.armed;
    else if (state.exit.armed !== lastArmed) {
      lastArmed = state.exit.armed;
      doorClunk();
    }
    if (lastOpen === null) lastOpen = state.exit.open;
    const sliding = Math.abs(state.exit.open - lastOpen) > 0.002;
    lastOpen = state.exit.open;
    hums.door.gain.gain.setTargetAtTime(sliding ? 0.24 : 0, now, 0.05);

    // the press: a heavy clunk when it tops out or slams home
    const pp = state.press?.phase;
    if (lastPress !== null && pp !== lastPress && (pp === 'up' || pp === 'down')) {
      doorClunk({ x: 0, y: 2.5, z: (LEVEL.press.z0 + LEVEL.press.z1) / 2, gain: pp === 'down' ? 0.9 : 0.4 });
    }
    lastPress = pp ?? null;
    // the collapse: a crack for every metre of catwalk that goes
    if (state.collapse?.active) {
      const zc = Math.floor(state.collapse.z);
      if (lastCollapse !== null && zc > lastCollapse) doorClunk({ x: 0, y: LEVEL.catwalk.y, z: zc, gain: 0.35 });
      lastCollapse = zc;
    } else lastCollapse = null;
  }


  // --------------------------------------------------------------- one-shots
  function doorClunk(at) {
    if (!ctx) return;
    const E = LEVEL.exit;
    const pos = at || { x: (E.x0 + E.x1) / 2, y: (E.y0 + E.y1) / 2, z: E.z, gain: 0.5 };
    const t = ctx.currentTime + 0.01;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(pos.gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    const p = pannerAt(pos.x, pos.y, pos.z);
    p.connect(master);
    o.connect(g).connect(p);
    o.start(t);
    o.stop(t + 0.24);
    freeOnEnd(o, g, p);
  }

  function footstep() {
    if (!ctx) return;
    const t = ctx.currentTime + 0.001;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 520 + Math.random() * 160;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    src.connect(f).connect(g).connect(master);
    src.start(t, Math.random() * 0.6, 0.1);
    src.stop(t + 0.1);
    freeOnEnd(src, g, f);
  }

  function land(strength) {
    if (!ctx) return;
    const s = Math.max(0.2, Math.min(1, Math.abs(strength || 0) / 22));
    const t = ctx.currentTime + 0.001;

    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 300;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3 + 0.5 * s, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12 + 0.1 * s);
    src.connect(f).connect(g).connect(master);
    src.start(t, Math.random() * 0.5, 0.25);
    src.stop(t + 0.3);
    freeOnEnd(src, g, f);

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90 + 40 * s, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.16 + 0.08 * s);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.25 + 0.45 * s, t + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.2 + 0.12 * s);
    o.connect(og).connect(master);
    o.start(t);
    o.stop(t + 0.34);
    freeOnEnd(o, og);
  }

  function knock() {
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.01;
    for (let i = 0; i < 3; i++) {
      const t = t0 + i * 0.12;
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer();
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 620;
      f.Q.value = 1.4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.7, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      src.connect(f).connect(g).connect(master);
      src.start(t, Math.random() * 0.5, 0.08);
      src.stop(t + 0.09);
      freeOnEnd(src, g, f);

      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 180 - i * 8;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(0.22, t + 0.004);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.connect(og).connect(master);
      o.start(t);
      o.stop(t + 0.1);
      freeOnEnd(o, og);
    }
  }

  function sonar() {
    if (!ctx) return;
    // a crisp chirp sweeping down, then two quieter echoes tailing off
    const t0 = ctx.currentTime + 0.01;
    for (let i = 0; i < 3; i++) {
      const t = t0 + i * 0.17;
      const amp = [0.42, 0.2, 0.08][i];
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(1500 + i * 60, t);
      o.frequency.exponentialRampToValueAtTime(560 - i * 40, t + 0.26);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + 0.32);
      freeOnEnd(o, g);
    }
  }

  function death() {
    if (!ctx) return;
    const t = ctx.currentTime + 0.01;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 1.15);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 700;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.25);
    o.connect(f).connect(g).connect(master);
    o.start(t);
    o.stop(t + 1.3);
    freeOnEnd(o, g, f);
  }

  function win() {
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.01;
    [392, 523.25, 659.25, 783.99].forEach((hz, i) => {
      const t = t0 + i * 0.11;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.34, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + 0.3);
      freeOnEnd(o, g);
    });
  }
}
