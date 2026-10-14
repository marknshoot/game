// RELAY 3D — the world, and the three private ways of looking at it.
//
//   world  (layer 0)  neutral geometry, fogged, no state, no meaning  -> Runner cam, Bridge cam
//   board  (layer 1)  schematic + state colours + labels + stamps     -> Operator board, Bridge board
//   chalk  (layer 2)  the Bridge's marks on the Runner's visor        -> Runner cam, Bridge cam, both boards
//   secret (layer 3)  which hall tiles are lies                       -> the Operator's board ONLY
//
// One scene, one renderer, several viewports: the Runner's cam cannot show what the boards
// show, and the Bridge's copy of the board cannot show the lies, by construction (layer
// masks), not by convention. The Operator has to stamp them for the Bridge.
import * as THREE from '../vendor/three.module.js';
import { LEVEL, hallTiles, spanX, LANE_W } from '../../shared/level3d.js';
import { TUNING, liftTop, spanExtent } from '../../shared/sim3d.js';

export const LAYER = { WORLD: 0, BOARD: 1, CHALK: 2, SECRET: 3 };

const COL = {
  floor: 0x2a3140,
  wall: 0x1b2230,
  rail: 0x39465e,
  span: 0x55607a,
  lift: 0x4a566e,
  door: 0x3c4658,
  boardFloor: 0x1d3a52,
  boardWall: 0x152b3d,
  ok: 0x39e08a,
  warn: 0xffb04a,
  bad: 0xff5347,
  accent: 0x5ad1ff,
  chalk: 0xffd257,
};

// ---------------------------------------------------------------- sonar wave
// One shared set of uniforms, injected into every "real" surface material. The hall's
// lying tiles use M.floor, so they light up exactly like real floor when the wave sweeps
// them — the deception survives the scan.
const sonarUniforms = {
  uSonarCenter: { value: new THREE.Vector3(0, -999, 0) },
  uSonarRadius: { value: -10.0 },
  uSonarWidth: { value: 1.8 },
  uSonarColor: { value: new THREE.Color(0x38bdf8) },
  uSonarIntensity: { value: 0.0 },
};

function attachSonar(mat) {
  mat.defines = { ...(mat.defines || {}), USE_UV: '' };
  mat.customProgramCacheKey = () => 'relay-sonar';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSonarCenter = sonarUniforms.uSonarCenter;
    shader.uniforms.uSonarRadius = sonarUniforms.uSonarRadius;
    shader.uniforms.uSonarWidth = sonarUniforms.uSonarWidth;
    shader.uniforms.uSonarColor = sonarUniforms.uSonarColor;
    shader.uniforms.uSonarIntensity = sonarUniforms.uSonarIntensity;
    shader.vertexShader = 'varying vec3 vWorldPos;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n\tvWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
    );
    shader.fragmentShader =
      'uniform vec3 uSonarCenter;\nuniform float uSonarRadius;\nuniform float uSonarWidth;\nuniform vec3 uSonarColor;\nuniform float uSonarIntensity;\nvarying vec3 vWorldPos;\n' +
      shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
	{
		float d = distance( vWorldPos, uSonarCenter );
		float w = smoothstep( uSonarWidth, 0.0, abs( d - uSonarRadius ) );
		gl_FragColor.rgb += uSonarColor * w * uSonarIntensity;
	}`,
      );
  };
  return mat;
}

// shared one-shot resources: chalk marks and the death ghost trail are rebuilt
// whenever their count changes, so their geometry/material must not be per-mark
const CHALK_MAT = new THREE.MeshBasicMaterial({ color: COL.chalk, fog: false, transparent: true, opacity: 0.95 });
const CHALK_CONE_GEO = new THREE.ConeGeometry(0.34, 0.9, 4);
const CHALK_BEAM_GEO = new THREE.CylinderGeometry(0.05, 0.05, 2.2, 6);
const CHALK_RING_GEO = new THREE.RingGeometry(0.4, 0.5, 20);
const GHOST_MAT = new THREE.MeshBasicMaterial({ color: 0xff6b6b, transparent: true, opacity: 0.5, fog: false });
const GHOST_GEO = new THREE.SphereGeometry(0.11, 6, 6);

// ------------------------------------------------------------------ textures
function concreteTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#3b4453';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    const v = 26 + Math.random() * 40;
    g.fillStyle = `rgba(${v},${v + 4},${v + 12},0.55)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  g.strokeStyle = 'rgba(10,12,18,0.75)';
  g.lineWidth = 2;
  for (let i = 0; i <= 256; i += 64) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 256);
    g.moveTo(0, i);
    g.lineTo(256, i);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function ribTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#2b3444';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#212938';
  for (let y = 0; y < 64; y += 16) g.fillRect(0, y, 64, 7);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function makeLabel(text, color = '#5ad1ff', screenSpace = true) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(4,10,18,0.86)';
  g.fillRect(0, 0, 512, 96);
  g.strokeStyle = color;
  g.lineWidth = 4;
  g.strokeRect(2, 2, 508, 92);
  g.fillStyle = color;
  g.font = 'bold 46px ui-monospace, monospace';
  g.textBaseline = 'middle';
  g.fillText(text, 18, 52);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false, sizeAttenuation: false }),
  );
  sprite.scale.set(screenSpace ? 9.5 : 6.4, screenSpace ? 1.8 : 1.2, 1);
  return sprite;
}

const boxMesh = (b, mat) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0), mat);
  m.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
};

function stripeTexture(a = '#d9a521', b = '#15181f') {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = b;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = a;
  for (let i = -64; i < 128; i += 22) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 11, 0);
    g.lineTo(i + 11 - 64, 64);
    g.lineTo(i - 64, 64);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------------- world
export function createWorld(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.autoClear = false;
  renderer.setClearColor(0x05070c, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05070c, 0.085); // ~15 m of useful sight: the Runner's whole horizon

  const world = new THREE.Group();
  const board = new THREE.Group();
  const secret = new THREE.Group();
  const chalkG = new THREE.Group();
  const ghostG = new THREE.Group();
  const stampG = new THREE.Group();
  scene.add(world, board, secret, chalkG, ghostG, stampG);
  const setLayers = (obj, layer) => obj.traverse((o) => o.layers.set(layer));

  // ---------------------------------------------------------------- materials
  const texFloor = concreteTexture();
  texFloor.repeat.set(6, 24);
  const texTile = concreteTexture();
  texTile.repeat.set(2, 4);
  const texWall = ribTexture();
  texWall.repeat.set(20, 2);
  const texCat = concreteTexture();
  texCat.repeat.set(4, 4);
  const texStripe = stripeTexture();
  texStripe.repeat.set(6, 2);
  const texPad = stripeTexture('#b8901c', '#1a1d24');
  texPad.repeat.set(4, 1);

  const M = {
    floor: new THREE.MeshStandardMaterial({ map: texTile, color: 0xffffff, roughness: 0.96, metalness: 0.03 }),
    corridor: new THREE.MeshStandardMaterial({ map: texFloor, color: 0xffffff, roughness: 0.96, metalness: 0.03 }),
    wall: new THREE.MeshStandardMaterial({ map: texWall, color: 0xffffff, roughness: 0.9, metalness: 0.08 }),
    chamber: new THREE.MeshStandardMaterial({ map: texWall, color: 0x8796b0, roughness: 0.95, metalness: 0.05 }),
    catwalk: new THREE.MeshStandardMaterial({ map: texCat, color: 0xd2dbe8, roughness: 0.7, metalness: 0.2 }),
    rail: new THREE.MeshStandardMaterial({ color: COL.rail, roughness: 0.6, metalness: 0.35 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x8a97ad, roughness: 0.45, metalness: 0.6 }),
    press: new THREE.MeshStandardMaterial({ map: texStripe, color: 0xffffff, roughness: 0.55, metalness: 0.4 }),
    pad: new THREE.MeshStandardMaterial({ map: texPad, color: 0xffffff, roughness: 0.8, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -2 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xcfe8ff, emissiveIntensity: 2.0, roughness: 0.4 }),
    beacon: new THREE.MeshStandardMaterial({ color: 0x0b1626, emissive: 0x2a8cff, emissiveIntensity: 1.6, roughness: 0.5 }),
    boards: new THREE.MeshBasicMaterial({ color: COL.boardFloor, transparent: true, opacity: 0.62, fog: false, side: THREE.DoubleSide }),
    boardWall: new THREE.MeshBasicMaterial({ color: COL.boardWall, transparent: true, opacity: 0.4, fog: false, side: THREE.DoubleSide }),
    boardRail: new THREE.MeshBasicMaterial({ color: 0x3f6084, transparent: true, opacity: 0.9, fog: false }),
    boardTile: new THREE.MeshBasicMaterial({ color: 0x24506e, transparent: true, opacity: 0.7, fog: false }),
  };
  // the Runner's sonar glows on the architecture, and on the lying tiles exactly as on true ones
  for (const key of ['floor', 'corridor', 'wall', 'chamber', 'catwalk', 'rail', 'metal', 'press', 'pad']) attachSonar(M[key]);

  // ------------------------------------------------------------ static world
  for (const b of LEVEL.boxes) {
    const mat = { floor: M.corridor, wall: M.wall, deco: M.chamber, catwalk: M.catwalk, rail: M.rail, lip: M.rail }[b.kind];
    if (!mat) continue;
    const m = boxMesh(b, mat);
    if (b.kind === 'deco') m.castShadow = false;
    world.add(m);
  }

  // the hall: nine identical tiles. Which ones are lies is a board secret.
  const H = LEVEL.hall;
  for (const t of hallTiles(null)) {
    const m = boxMesh({ ...t, x0: t.x0 + 0.02, x1: t.x1 - 0.02, z0: t.z0 + 0.02, z1: t.z1 - 0.02 }, M.floor);
    world.add(m);
  }

  // station pads: hatched plates where the Runner stands until he commits
  for (const st of LEVEL.stations) {
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(st.y > 1 ? 5 : 8, 1.2), M.pad);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(0, st.y + 0.012, st.z);
    pad.receiveShadow = true;
    world.add(pad);
  }

  // decor: corridor pillars, trusses, lamps (no colliders)
  const decor = new THREE.Group();
  const inHall = (z) => z > LEVEL.chamber.z0 - 0.5 && z < LEVEL.chamber.z1 + 0.5;
  for (let z = -4; z < 64; z += LEVEL.props.pillarEvery) {
    if (inHall(z)) continue;
    for (const sx of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.5, 5, 0.5), M.metal);
      p.position.set(sx * 3.55, 2.5, z);
      p.castShadow = true;
      decor.add(p);
    }
  }
  for (let z = 0; z < 64; z += LEVEL.props.trussEvery) {
    if (inHall(z) || (z > 55 && z < 59)) continue;
    const t = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.34, 0.5), M.metal);
    t.position.set(0, 4.9, z);
    t.castShadow = true;
    decor.add(t);
  }
  for (let z = 2; z < 64; z += 5) {
    if (inHall(z)) continue;
    const l = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.14, 0.42), M.lamp);
    l.position.set(0, 4.72, z);
    decor.add(l);
  }
  // the chamber: colossal pillars and girders the sonar sweeps across — the vista
  const C = LEVEL.chamber;
  for (const z of [32.5, 39, 45.5]) {
    for (const sx of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(1.6, C.y1 - C.y0, 1.6), M.metal);
      p.position.set(sx * 9.5, (C.y0 + C.y1) / 2, z);
      decor.add(p);
      const band = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.18, 1.7), M.beacon);
      band.position.set(sx * 9.5, 9, z);
      decor.add(band);
    }
    const g = new THREE.Mesh(new THREE.BoxGeometry(2 * C.x, 0.7, 0.9), M.metal);
    g.position.set(0, 13, z);
    decor.add(g);
  }
  for (const sx of [-1, 1]) {
    for (let y = -6; y <= 12; y += 6) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, C.z1 - C.z0 - 1), M.beacon);
      strip.position.set(sx * (C.x - 0.05), y, (C.z0 + C.z1) / 2);
      decor.add(strip);
    }
  }
  // the press frame
  const P = LEVEL.press;
  for (const sx of [-1, 1]) {
    const col = new THREE.Mesh(new THREE.BoxGeometry(0.5, 5, 2.6), M.metal);
    col.position.set(sx * 3.75, 2.5, (P.z0 + P.z1) / 2);
    decor.add(col);
  }
  world.add(decor);

  // lights
  scene.add(new THREE.HemisphereLight(0x5c7299, 0x161e2a, 1.8));
  const sun = new THREE.DirectionalLight(0xd8e6ff, 1.8);
  sun.position.set(14, 30, 20);
  sun.target.position.set(0, 0, 44);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -55, right: 55, top: 55, bottom: -55, near: 1, far: 160 });
  sun.shadow.bias = -0.0009;
  scene.add(sun, sun.target);
  for (const z of [4, 18, 26, 52, 58, 62]) {
    const pl = new THREE.PointLight(0xcfe4ff, 15, 24, 2);
    pl.position.set(0, 4.3, z);
    scene.add(pl);
  }
  for (const z of [33, 45]) {
    const pl = new THREE.PointLight(0x5aa0ff, 30, 30, 2); // cold, high, far: the chamber
    pl.position.set(0, 12, z);
    scene.add(pl);
  }
  for (const z of [68, 80]) {
    const pl = new THREE.PointLight(0xcfe4ff, 12, 18, 2);
    pl.position.set(0, 7.4, z);
    scene.add(pl);
  }
  // the collapse front carries its own red light
  const collapseLight = new THREE.PointLight(0xff4a2a, 0, 12, 2);
  scene.add(collapseLight);

  // ------------------------------------------------------------ dynamic world
  const spanMesh = new THREE.Mesh(new THREE.BoxGeometry(LANE_W, LEVEL.span.h, LEVEL.span.z1 - LEVEL.span.z0), M.metal);
  spanMesh.castShadow = true;
  spanMesh.receiveShadow = true;
  world.add(spanMesh);

  const pressMesh = new THREE.Mesh(new THREE.BoxGeometry(P.x1 - P.x0 - 0.04, P.h, P.z1 - P.z0), M.press);
  pressMesh.castShadow = true;
  world.add(pressMesh);

  const L = LEVEL.lift;
  const liftMesh = new THREE.Mesh(new THREE.BoxGeometry(L.x1 - L.x0, 0.35, L.z1 - L.z0), M.metal);
  liftMesh.castShadow = true;
  liftMesh.receiveShadow = true;
  world.add(liftMesh);

  const E = LEVEL.exit;
  const doorMesh = new THREE.Mesh(new THREE.BoxGeometry(E.x1 - E.x0, E.y1 - E.y0, 0.4), M.metal);
  doorMesh.castShadow = true;
  world.add(doorMesh);

  // the catwalk in 1 m slices, so it can fall away behind him
  const CW = LEVEL.catwalk;
  const slices = [];
  const sliceGeo = new THREE.BoxGeometry(CW.x1 - CW.x0, 0.3, 0.98);
  for (const [z0, z1] of CW.segs) {
    for (let z = z0; z < z1; z += 1) {
      const m = new THREE.Mesh(sliceGeo, M.catwalk);
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData = { z0: z, z1: Math.min(z1, z + 1), fall: 0, spin: (Math.random() - 0.5) * 2 };
      m.position.set(0, CW.y - 0.15, z + 0.5);
      world.add(m);
      slices.push(m);
    }
  }

  // ------------------------------------------------------------------- board
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x8fd8ff, transparent: true, opacity: 0.5, fog: false });
  const boardBox = (b, mat) => {
    const m = boxMesh(b, mat);
    m.castShadow = m.receiveShadow = false;
    board.add(m);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), edgeMat);
    e.position.copy(m.position);
    board.add(e);
    return m;
  };
  for (const b of LEVEL.boxes) {
    if (b.kind === 'deco') continue;
    boardBox(b, b.kind === 'floor' ? M.boards : b.kind === 'wall' ? M.boardWall : M.boardRail);
  }
  for (const [z0, z1] of CW.segs) boardBox({ x0: CW.x0, x1: CW.x1, y0: CW.y - 0.3, y1: CW.y, z0, z1 }, M.boards);
  // all nine hall tiles look the same on the board too...
  for (const t of hallTiles(null)) boardBox({ ...t, x0: t.x0 + 0.08, x1: t.x1 - 0.08, z0: t.z0 + 0.08, z1: t.z1 - 0.08 }, M.boardTile);
  // ...except on the Operator's copy, where the lies are marked (SECRET layer)
  const lieMat = new THREE.MeshBasicMaterial({ color: COL.bad, transparent: true, opacity: 0.55, fog: false, depthTest: false });
  const lieGeo = new THREE.BoxGeometry(LANE_W - 0.3, 0.12, H.segLen - 0.3);
  const lies = hallTiles(null).map((t) => {
    const m = new THREE.Mesh(lieGeo, lieMat);
    m.position.set((t.x0 + t.x1) / 2, 0.1, (t.z0 + t.z1) / 2);
    m.userData = { seg: t.seg, lane: t.lane };
    m.renderOrder = 5;
    secret.add(m);
    return m;
  });

  const mkBoardBox = (x0, x1, y0, y1, z0, z1, color, opacity = 0.55) =>
    new THREE.Mesh(
      new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, fog: false }),
    );
  // span: the three slots faintly, the rolled lane in its state colour
  for (let lane = 0; lane < 3; lane++) {
    const slot = mkBoardBox(-1, 1, LEVEL.span.y, 0, LEVEL.span.z0, LEVEL.span.z1, 0x2a3b52, 0.25);
    slot.scale.x = (LANE_W - 0.2) / 2;
    slot.position.set(H.x0 + LANE_W * (lane + 0.5), LEVEL.span.y / 2, (LEVEL.span.z0 + LEVEL.span.z1) / 2);
    board.add(slot);
  }
  const boardSpan = mkBoardBox(0, LANE_W - 0.1, LEVEL.span.y, 0.05, LEVEL.span.z0, LEVEL.span.z1, COL.bad, 0.75);
  const boardPress = mkBoardBox(P.x0, P.x1, 0, P.h, P.z0, P.z1, COL.bad, 0.55);
  const boardLift = mkBoardBox(L.x0, L.x1, L.down, L.down + 0.35, L.z0, L.z1, COL.accent, 0.5);
  const boardDoor = mkBoardBox(E.x0, E.x1, E.y0, E.y1, E.z, E.z + 0.4, COL.warn, 0.5);
  const boardCollapse = mkBoardBox(CW.x0 - 0.5, CW.x1 + 0.5, CW.y - 1.5, CW.y + 2.5, -0.15, 0.15, COL.bad, 0.6);
  // centred geometry: put the overlays where their things are (update only moves y)
  boardLift.position.set((L.x0 + L.x1) / 2, L.down + 0.175, (L.z0 + L.z1) / 2);
  boardDoor.position.set((E.x0 + E.x1) / 2, (E.y0 + E.y1) / 2, E.z + 0.2);
  boardCollapse.visible = false;
  board.add(boardSpan, boardPress, boardLift, boardDoor, boardCollapse);

  const labels = [
    { t: 'START', c: '#8ea3c4', p: new THREE.Vector3(0, 1.4, 1) },
    { t: 'SPAN  z18', c: '#39e08a', p: new THREE.Vector3(0, 1.0, 21) },
    { t: 'DARK HALL', c: '#ff5347', p: new THREE.Vector3(0, 4.5, 39) },
    { t: 'PRESS  z56', c: '#ffb04a', p: new THREE.Vector3(0, 6.2, 56) },
    { t: 'LIFT  z60', c: '#5ad1ff', p: new THREE.Vector3(0, 7.2, 61) },
    { t: 'GAP  z72', c: '#ffb04a', p: new THREE.Vector3(0, 7.4, 73) },
    { t: 'TWO-KEY EXIT', c: '#ffb04a', p: new THREE.Vector3(0, 10.4, 84) },
  ];
  for (const l of labels) {
    const s = makeLabel(l.t, l.c, true);
    s.position.copy(l.p);
    board.add(s);
  }
  setLayers(world, LAYER.WORLD);
  setLayers(ghostG, LAYER.WORLD);
  setLayers(board, LAYER.BOARD);
  setLayers(stampG, LAYER.BOARD);
  setLayers(secret, LAYER.SECRET);
  setLayers(chalkG, LAYER.CHALK);

  // ------------------------------------------------------------- cameras
  const runnerCam = new THREE.PerspectiveCamera(76, 16 / 9, 0.08, 120);
  runnerCam.layers.set(LAYER.WORLD);
  runnerCam.layers.enable(LAYER.CHALK);

  // the Operator's board: everything, including the lies
  const operatorCam = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 400);
  operatorCam.layers.set(LAYER.BOARD);
  operatorCam.layers.enable(LAYER.SECRET);
  operatorCam.layers.enable(LAYER.CHALK);
  fitOrthoToLevel(operatorCam);
  // the Bridge's copy of the board: the same view without the SECRET layer
  const bridgeBoardCam = operatorCam.clone();
  bridgeBoardCam.layers.set(LAYER.BOARD);
  bridgeBoardCam.layers.enable(LAYER.CHALK);

  function levelCorners() {
    const p = [];
    for (const x of [-4.4, 4.4]) for (const y of [-1.5, 8]) for (const z of [-6.4, 90.4]) p.push(new THREE.Vector3(x, y, z));
    return p;
  }

  function fitOrthoToLevel(cam) {
    const center = new THREE.Vector3(0, 1.6, 42);
    // high and to the side: the gantry runs across the screen, the lanes read as rows and
    // the heights (lift, catwalk) still read as heights
    const dir = new THREE.Vector3(0.62, 0.74, -0.26).normalize();
    cam.position.copy(center).addScaledVector(dir, 140);
    cam.up.set(0, 1, 0);
    cam.lookAt(center);
    cam.updateMatrixWorld();
    const inv = new THREE.Matrix4().copy(cam.matrixWorld).invert();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of levelCorners()) {
      const v = c.clone().applyMatrix4(inv);
      minX = Math.min(minX, v.x);
      maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y);
      maxY = Math.max(maxY, v.y);
    }
    const pad = 1.06;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const w = (maxX - minX) * pad;
    const h = (maxY - minY) * pad;
    cam.userData.base = { cx, cy, w, h };
    cam.left = cx - w / 2;
    cam.right = cx + w / 2;
    cam.top = cy + h / 2;
    cam.bottom = cy - h / 2;
    cam.updateProjectionMatrix();
  }

  // --------------------------------------------------------------- chalk marks
  let chalkKey = '';
  const chalkMeshes = [];
  function syncChalk(state) {
    const key = state.chalk.map((k) => `${k.x},${k.z},${k.dir}`).join('|');
    if (key === chalkKey) return;
    chalkKey = key;
    for (const m of chalkMeshes) chalkG.remove(m);
    chalkMeshes.length = 0;
    for (const k of state.chalk) {
      const g = new THREE.Group();
      const cone = new THREE.Mesh(CHALK_CONE_GEO, CHALK_MAT);
      cone.position.y = 1.9;
      if (k.dir === 'left') cone.rotation.z = -Math.PI / 2; // the Runner's left is +X
      else if (k.dir === 'right') cone.rotation.z = Math.PI / 2;
      else if (k.dir === 'down') cone.rotation.z = Math.PI;
      else cone.rotation.x = Math.PI / 2;
      const beam = new THREE.Mesh(CHALK_BEAM_GEO, CHALK_MAT);
      beam.position.y = 1.1;
      const ring = new THREE.Mesh(CHALK_RING_GEO, CHALK_MAT);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      g.add(cone, beam, ring);
      g.traverse((o) => o.layers.set(LAYER.CHALK));
      g.position.set(k.x, k.y, k.z);
      chalkG.add(g);
      chalkMeshes.push(g);
    }
  }

  // --------------------------------------------------------------- stamps (board)
  let stampKey = '';
  const stampTex = new Map();
  function stampSprite(icon) {
    if (!stampTex.has(icon)) {
      const c = document.createElement('canvas');
      c.width = c.height = 96;
      const g = c.getContext('2d');
      const col = icon === '✓' ? '#39e08a' : icon === '⧗' ? '#ffb04a' : '#ff5347';
      g.fillStyle = 'rgba(4,10,18,0.85)';
      g.beginPath();
      g.arc(48, 48, 44, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = col;
      g.lineWidth = 6;
      g.stroke();
      g.fillStyle = col;
      g.font = 'bold 54px ui-sans-serif, system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(icon, 48, 52);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      stampTex.set(icon, t);
    }
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: stampTex.get(icon), depthTest: false, transparent: true, fog: false }));
    s.renderOrder = 10;
    s.scale.set(2.4, 2.4, 1);
    return s;
  }
  function syncStamps(state) {
    const key = state.stamps.map((k) => `${k.icon}${k.x},${k.z},${k.t}`).join('|');
    if (key === stampKey) return;
    stampKey = key;
    while (stampG.children.length) stampG.remove(stampG.children[0]);
    for (const k of state.stamps) {
      const s = stampSprite(k.icon);
      s.position.set(k.x, 0.8, k.z);
      s.layers.set(LAYER.BOARD);
      stampG.add(s);
    }
  }

  // -------------------------------------------------------------- ghost trail
  let ghostCount = 0;
  function syncGhost(trail, alive) {
    const src = trail || [];
    const want = !alive ? src.length : 0;
    if (want === ghostCount) return;
    while (ghostG.children.length) ghostG.remove(ghostG.children[0]);
    ghostCount = want;
    if (!alive) {
      for (let i = 0; i < src.length; i += 4) {
        const g = src[i];
        const m = new THREE.Mesh(GHOST_GEO, GHOST_MAT);
        m.position.set(g.x, g.y + 0.9, g.z);
        m.layers.set(LAYER.WORLD);
        ghostG.add(m);
      }
    }
  }

  // sonar pulse: the Runner's scan, expanding from where he fired it. In the chamber it
  // carries further, so one pulse sweeps the whole vault.
  const sonar = { t: 0, active: false, duration: 1.2, maxRadius: 26 };
  function triggerSonar(x, y, z) {
    const big = z > LEVEL.chamber.z0 - 3 && z < LEVEL.chamber.z1;
    sonar.t = 0;
    sonar.active = true;
    sonar.duration = big ? 2.0 : 1.2;
    sonar.maxRadius = big ? 40 : 26;
    sonarUniforms.uSonarCenter.value.set(x, y, z);
    sonarUniforms.uSonarRadius.value = 0;
    sonarUniforms.uSonarIntensity.value = 1.2;
  }

  // game-feel state: head bob, landing dip, speed FOV
  let bobTimer = 0;
  let bobAmp = 0;
  let dip = 0;
  let dipVel = 0;
  let airVy = 0;
  let prevGround = true;
  let layoutKey = '';

  // ------------------------------------------------------------------ update
  function update(state, view, dt = 1 / 60) {
    const rr = state.runner;
    const speed = Math.hypot(rr.vx, rr.vz);

    if (sonar.active) {
      sonar.t += dt;
      const p = Math.min(1, sonar.t / sonar.duration);
      sonarUniforms.uSonarRadius.value = p * sonar.maxRadius;
      sonarUniforms.uSonarIntensity.value = 1.2 * (1 - p);
      if (p >= 1) {
        sonar.active = false;
        sonarUniforms.uSonarRadius.value = -10;
        sonarUniforms.uSonarIntensity.value = 0;
      }
    }

    const bobTarget = rr.ground && speed > 1.5 && !state.dead ? 1 : 0;
    bobAmp += (bobTarget - bobAmp) * Math.min(1, dt * 8);
    if (bobTarget > 0.5) bobTimer += dt * (5.5 + speed * 1.1);

    if (!rr.ground && rr.vy < 0) airVy = Math.max(airVy, -rr.vy);
    if (!prevGround && rr.ground) {
      dipVel -= Math.min(2.4, 0.2 + airVy * 0.14);
      airVy = 0;
    }
    prevGround = rr.ground;
    const sdt = Math.min(dt, 0.05);
    dipVel += (-90 * dip - 13 * dipVel) * sdt;
    dip = Math.max(-0.15, Math.min(0.05, dip + dipVel * sdt));

    const targetFov = 75 + 7 * Math.min(1, speed / TUNING.runSpeed);
    if (Math.abs(runnerCam.fov - targetFov) > 0.02) {
      runnerCam.fov += (targetFov - runnerCam.fov) * Math.min(1, dt * 5);
      runnerCam.updateProjectionMatrix();
    }

    const r = view.runner;
    runnerCam.position.set(r.x, r.y + 1.55, r.z);
    runnerCam.rotation.set(view.pitch || 0, r.yaw + Math.PI, 0, 'YXZ');
    runnerCam.position.y += Math.sin(bobTimer) * 0.035 * bobAmp;
    runnerCam.rotation.z += Math.cos(bobTimer * 0.5) * 0.005 * bobAmp;
    runnerCam.position.y += dip;
    if (view.shake > 0) {
      const t = performance.now() * 0.001;
      const a = 0.04 * Math.min(1, view.shake / 0.35);
      runnerCam.rotation.x += Math.sin(t * 71) * a;
      runnerCam.rotation.y += Math.sin(t * 59 + 1.7) * a * 0.7;
      runnerCam.rotation.z += Math.sin(t * 83 + 0.4) * a;
      runnerCam.position.x += Math.sin(t * 67 + 2.2) * a * 0.3;
      runnerCam.position.y += Math.sin(t * 79 + 1.1) * a * 0.3;
    }

    // ---- dynamic world (neutral: shape only, never state)
    const ext = spanExtent(state);
    const [sx0, sx1] = spanX(state.layout);
    spanMesh.visible = ext > 0.01;
    spanMesh.scale.z = Math.max(0.001, ext);
    spanMesh.position.set((sx0 + sx1) / 2, LEVEL.span.y + LEVEL.span.h / 2, LEVEL.span.z0 + ((LEVEL.span.z1 - LEVEL.span.z0) * ext) / 2);

    pressMesh.position.set(0, state.press.y + P.h / 2, (P.z0 + P.z1) / 2);
    liftMesh.position.set((L.x0 + L.x1) / 2, state.lift.y + 0.175, (L.z0 + L.z1) / 2);
    doorMesh.position.set((E.x0 + E.x1) / 2, E.y0 + (E.y1 - E.y0) / 2 + state.exit.open * 3.6, E.z + 0.2);

    // catwalk slices fall once the collapse front passes them
    const col = state.collapse;
    for (const m of slices) {
      const u = m.userData;
      const gone = col.active && col.z >= u.z1;
      if (!gone) {
        u.fall = 0;
        m.visible = true;
        m.position.y = CW.y - 0.15;
        m.rotation.set(0, 0, 0);
        continue;
      }
      u.fall += dt;
      m.position.y = CW.y - 0.15 - 0.5 * 30 * u.fall * u.fall;
      m.rotation.x = u.fall * 1.6;
      m.rotation.z = u.fall * u.spin;
      m.visible = m.position.y > -25;
    }
    collapseLight.intensity = col.active ? 22 + 8 * Math.sin(state.t * 23) : 0;
    collapseLight.position.set(0, CW.y + 0.6, col.z - 0.5);

    // ---- board overlays (state colours, never on the Runner's layer)
    boardSpan.visible = true;
    boardSpan.scale.z = state.span.phase === 'out' ? 1 : Math.max(0.02, ext);
    boardSpan.position.set(sx0 + 0.05 + (LANE_W - 0.1) / 2, 0.12, LEVEL.span.z0 + ((LEVEL.span.z1 - LEVEL.span.z0) * (state.span.phase === 'out' ? 1 : ext)) / 2);
    boardSpan.material.opacity = state.span.phase === 'out' ? 0.35 : 0.8;
    boardSpan.material.color.set(state.span.phase === 'extended' ? COL.ok : state.span.phase === 'out' ? COL.accent : COL.warn);

    boardPress.position.set(0, state.press.y + P.h / 2, (P.z0 + P.z1) / 2);
    boardPress.material.color.set(state.press.phase === 'up' ? COL.ok : state.press.phase === 'down' ? COL.bad : COL.warn);
    boardLift.position.y = state.lift.y + 0.175;
    boardDoor.position.y = E.y0 + (E.y1 - E.y0) / 2 + state.exit.open * 3.6;
    boardDoor.material.color.set(state.exit.open > 0.9 ? COL.ok : state.exit.armed ? COL.warn : COL.bad);
    boardCollapse.visible = col.active;
    boardCollapse.position.set(0, CW.y, col.z);

    const lk = JSON.stringify(state.layout?.hall);
    if (lk !== layoutKey) {
      layoutKey = lk;
      for (const m of lies) m.visible = !!state.layout && state.layout.hall[m.userData.seg] !== m.userData.lane;
    }
    lieMat.opacity = 0.42 + 0.18 * Math.abs(Math.sin(state.t * 3));

    syncChalk(state);
    syncStamps(state);
    syncGhost(view.ghost, !state.dead);
  }

  // --------------------------------------------------------------- rendering
  function render(views) {
    renderer.setScissorTest(false);
    renderer.clear();
    for (const v of views) {
      const { x, y, w, h, camera } = v;
      if (w < 4 || h < 4) continue;
      renderer.setViewport(x, y, w, h);
      renderer.setScissor(x, y, w, h);
      renderer.setScissorTest(true);
      if (camera.isPerspectiveCamera) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      } else if (camera.userData.base) {
        // fill the viewport with the whole level, whatever the window shape
        const b = camera.userData.base;
        const aspect = w / h;
        let hw = b.w / 2;
        let hh = b.h / 2;
        if (b.w / b.h < aspect) hw = hh * aspect;
        else hh = hw / aspect;
        camera.left = b.cx - hw;
        camera.right = b.cx + hw;
        camera.top = b.cy + hh;
        camera.bottom = b.cy - hh;
        camera.updateProjectionMatrix();
      }
      renderer.render(scene, camera);
    }
    renderer.setScissorTest(false);
  }

  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(320, Math.floor(rect.width * dpr));
    const h = Math.max(240, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    renderer.setSize(w, h, false);
    return { w, h, dpr };
  }

  // Ray from a click inside a viewport, in world space (used for chalk + stamps).
  const groundPlane = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshBasicMaterial({ visible: false }));
  groundPlane.rotation.x = -Math.PI / 2;
  groundPlane.position.set(0, 0, 40);
  groundPlane.updateMatrixWorld(true);
  scene.add(groundPlane);
  groundPlane.layers.set(LAYER.BOARD);

  const ray = new THREE.Raycaster();
  function pick(cam, px, py, rect) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const nx = ((px * dpr - rect.x) / rect.w) * 2 - 1;
    const ny = -(((py * dpr - rect.y) / rect.h) * 2 - 1);
    ray.setFromCamera(new THREE.Vector2(nx, ny), cam);
    const onBoard = cam !== runnerCam;
    ray.layers.set(onBoard ? LAYER.BOARD : LAYER.WORLD);
    const targets = [];
    for (const c of [onBoard ? board : world]) if (c.visible) targets.push(c);
    let p = null;
    const hits = ray.intersectObjects(targets, true).filter((h) => h.object.isMesh && !h.object.isSprite);
    if (hits.length) p = hits[0].point;
    else {
      const flat = ray.intersectObject(groundPlane, false);
      if (flat.length) p = flat[0].point;
    }
    if (!p) return null;
    return { x: Math.max(-3.6, Math.min(3.6, p.x)), y: Math.max(-1, Math.min(8, p.y)), z: Math.max(0.5, Math.min(89, p.z)) };
  }

  return {
    renderer,
    scene,
    world,
    board,
    secret,
    runnerCam,
    operatorCam,
    bridgeBoardCam,
    update,
    render,
    resize,
    pick,
    triggerSonar,
    sonarUniforms,
    liftTopClient: (s) => liftTop(s),
    // project a world point into a board camera's NDC (tests and the HUD use it)
    project: (cam, x, y, z) => new THREE.Vector3(x, y, z).project(cam),
  };
}
