// RELAY 3D — the world, and the three private ways of looking at it.
//
//   world group  (layer 0)  neutral geometry, fogged, no state, no meaning  -> Runner cam, Bridge cam
//   board group  (layer 1)  schematic + state colours + labels + hazard     -> Operator view, Bridge board
//   chalk        (layer 2)  the Bridge's marks on the Runner's visor        -> Runner cam, Bridge cam
//
// One scene, one renderer, several viewports: the Runner's cam cannot show what the
// Operator's board shows, by construction rather than by convention.
import * as THREE from '../vendor/three.module.js';
import { LEVEL } from '../../shared/level3d.js';
import { liftTop } from '../../shared/sim3d.js';

export const LAYER = { WORLD: 0, BOARD: 1, CHALK: 2 };

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
  const chalkG = new THREE.Group();
  const ghostG = new THREE.Group();
  scene.add(world, board, chalkG, ghostG);
  world.layers.set(LAYER.WORLD);
  board.layers.set(LAYER.BOARD);
  chalkG.layers.set(LAYER.CHALK);
  ghostG.layers.set(LAYER.WORLD);
  // groups inherit layer only for themselves; children need it too
  const setLayers = (obj, layer) => obj.traverse((o) => o.layers.set(layer));

  // ---------------------------------------------------------------- materials
  const texFloor = concreteTexture();
  texFloor.repeat.set(6, 24);
  const texWall = ribTexture();
  texWall.repeat.set(20, 2);
  const texCat = concreteTexture();
  texCat.repeat.set(4, 4);

  const M = {
    floor: new THREE.MeshStandardMaterial({ map: texFloor, color: 0xffffff, roughness: 0.96, metalness: 0.03 }),
    wall: new THREE.MeshStandardMaterial({ map: texWall, color: 0xffffff, roughness: 0.9, metalness: 0.08 }),
    catwalk: new THREE.MeshStandardMaterial({ map: texCat, color: 0xd2dbe8, roughness: 0.7, metalness: 0.2 }),
    rail: new THREE.MeshStandardMaterial({ color: COL.rail, roughness: 0.6, metalness: 0.35 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x8a97ad, roughness: 0.45, metalness: 0.6 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xcfe8ff, emissiveIntensity: 2.0, roughness: 0.4 }),
    boards: new THREE.MeshBasicMaterial({ color: COL.boardFloor, transparent: true, opacity: 0.62, fog: false, side: THREE.DoubleSide }),
    boardWall: new THREE.MeshBasicMaterial({ color: COL.boardWall, transparent: true, opacity: 0.4, fog: false, side: THREE.DoubleSide }),
    boardRail: new THREE.MeshBasicMaterial({ color: 0x3f6084, transparent: true, opacity: 0.9, fog: false }),
  };

  // ------------------------------------------------------------ static world
  for (const b of LEVEL.boxes) {
    if (b.kind === 'floor') world.add(boxMesh(b, M.floor));
    else if (b.kind === 'wall') world.add(boxMesh(b, M.wall));
    else if (b.kind === 'catwalk') world.add(boxMesh(b, M.catwalk));
    else if (b.kind === 'rail' || b.kind === 'lip') world.add(boxMesh(b, M.rail));
  }

  // the lie: a floor run over the hole, made of exactly the same material
  const phantom = { x0: -4, x1: 4, y0: -1, y1: 0, z0: LEVEL.phantom.z0, z1: LEVEL.phantom.z1 };
  world.add(boxMesh(phantom, M.floor));

  // decor: pillars, overhead trusses, lamp strips (no colliders)
  const decor = new THREE.Group();
  for (let z = -4; z < 66; z += LEVEL.props.pillarEvery) {
    for (const sx of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.5, 5, 0.5), M.metal);
      p.position.set(sx * 3.55, 2.5, z);
      p.castShadow = true;
      decor.add(p);
    }
  }
  for (let z = 0; z < 68; z += LEVEL.props.trussEvery) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.34, 0.5), M.metal);
    t.position.set(0, 4.9, z);
    t.castShadow = true;
    decor.add(t);
  }
  for (let z = 2; z < 66; z += 5) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.14, 0.42), M.lamp);
    l.position.set(0, 4.72, z);
    decor.add(l);
  }
  world.add(decor);

  // lights
  scene.add(new THREE.HemisphereLight(0x4a5f85, 0x0d1219, 1.5));
  const sun = new THREE.DirectionalLight(0xd8e6ff, 1.5);
  sun.position.set(14, 26, -8);
  sun.target.position.set(0, 0, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40;
  sun.shadow.camera.bottom = -40;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 130;
  sun.shadow.bias = -0.0009;
  scene.add(sun, sun.target);
  for (const z of [4, 18, 32, 46, 58, 66]) {
    const pl = new THREE.PointLight(0xcfe4ff, 15, 24, 2);
    pl.position.set(0, 4.3, z);
    scene.add(pl);
  }
  for (const z of [51, 55]) {
    const pl = new THREE.PointLight(0xcfe4ff, 10, 16, 2);
    pl.position.set(0, 7.4, z); // over the lift and the catwalk
    scene.add(pl);
  }

  // ------------------------------------------------------------ dynamic world
  const spanMesh = new THREE.Mesh(new THREE.BoxGeometry(LEVEL.span.x1 - LEVEL.span.x0, LEVEL.span.h, LEVEL.span.z1 - LEVEL.span.z0), M.metal);
  spanMesh.castShadow = true;
  spanMesh.receiveShadow = true;
  world.add(spanMesh);

  const L = LEVEL.lift;
  const liftMesh = new THREE.Mesh(new THREE.BoxGeometry(L.x1 - L.x0, 0.35, L.z1 - L.z0), M.metal);
  liftMesh.castShadow = true;
  liftMesh.receiveShadow = true;
  world.add(liftMesh);

  const E = LEVEL.exit;
  const doorMesh = new THREE.Mesh(new THREE.BoxGeometry(E.x1 - E.x0, E.y1 - E.y0, 0.4), M.metal);
  doorMesh.castShadow = true;
  world.add(doorMesh);

  // ------------------------------------------------------------------- board
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x8fd8ff, transparent: true, opacity: 0.5, fog: false });
  for (const b of LEVEL.boxes) {
    const mat = b.kind === 'floor' || b.kind === 'catwalk' ? M.boards : b.kind === 'wall' ? M.boardWall : M.boardRail;
    const m = boxMesh(b, mat);
    m.castShadow = false;
    m.receiveShadow = false;
    board.add(m);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), edgeMat);
    e.position.copy(m.position);
    board.add(e);
  }

  const mkBoardBox = (x0, x1, y0, y1, z0, z1, color, opacity = 0.55) =>
    new THREE.Mesh(
      new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, fog: false }),
    );
  const boardSpan = mkBoardBox(LEVEL.span.x0, LEVEL.span.x1, LEVEL.span.y, 0, LEVEL.span.z0, LEVEL.span.z1, COL.ok, 0.5);
  const boardLift = mkBoardBox(L.x0, L.x1, L.down, L.down + 0.35, L.z0, L.z1, COL.accent, 0.5);
  const boardDoor = mkBoardBox(E.x0, E.x1, E.y0, E.y1, E.z, E.z + 0.4, COL.warn, 0.5);
  const boardHazard = mkBoardBox(-4, 4, -1.2, 0.06, LEVEL.phantom.z0, LEVEL.phantom.z1, COL.bad, 0.42);
  board.add(boardSpan, boardLift, boardDoor, boardHazard);

  const labels = [
    { t: 'START', c: '#8ea3c4', p: new THREE.Vector3(0, 1.2, 0) },
    { t: 'SPAN  z18', c: '#39e08a', p: new THREE.Vector3(0, 0.6, 22) },
    { t: 'PHANTOM FLOOR  z44', c: '#ff5347', p: new THREE.Vector3(0, 0.6, 40.5) },
    { t: 'LIFT  z51', c: '#5ad1ff', p: new THREE.Vector3(-1.6, 0.6, 53) },
    { t: 'CATWALK JUMP  z57', c: '#ffb04a', p: new THREE.Vector3(0, 8.4, 56) },
    { t: 'TWO-KEY EXIT  z63', c: '#ffb04a', p: new THREE.Vector3(0, 10.4, 62) },
  ];
  for (const l of labels) {
    const s = makeLabel(l.t, l.c, true);
    s.position.copy(l.p);
    s.layers.set(LAYER.BOARD);
    board.add(s);
  }
  setLayers(board, LAYER.BOARD);
  setLayers(world, LAYER.WORLD);
  setLayers(chalkG, LAYER.CHALK);
  setLayers(ghostG, LAYER.WORLD);

  // ------------------------------------------------------------- cameras
  const runnerCam = new THREE.PerspectiveCamera(76, 16 / 9, 0.08, 80);
  runnerCam.layers.enable(LAYER.WORLD);
  runnerCam.layers.enable(LAYER.CHALK);

  const operatorCam = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 400);
  operatorCam.layers.set(LAYER.BOARD);
  fitOrthoToLevel();

  function levelCorners() {
    const p = [];
    const xs = [-4.4, 4.4];
    const ys = [-2.5, 9];
    const zs = [-6.4, 68];
    for (const x of xs) for (const y of ys) for (const z of zs) p.push(new THREE.Vector3(x, y, z));
    return p;
  }

  function fitOrthoToLevel() {
    const center = new THREE.Vector3(0, 1.6, 30);
    // elevation from the side and slightly behind: the gantry runs across the
    // screen, heights read properly, and the fitted box hugs the level
    const dir = new THREE.Vector3(0.88, 0.33, -0.34).normalize();
    operatorCam.position.copy(center).addScaledVector(dir, 120);
    operatorCam.lookAt(center);
    operatorCam.updateMatrixWorld();
    const inv = new THREE.Matrix4().copy(operatorCam.matrixWorld).invert();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of levelCorners()) {
      const v = c.clone().applyMatrix4(inv);
      minX = Math.min(minX, v.x);
      maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y);
      maxY = Math.max(maxY, v.y);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const w = maxX - minX;
    const h = maxY - minY;
    operatorCam.userData.base = { cx, cy, w, h };
    operatorCam.left = cx - w / 2;
    operatorCam.right = cx + w / 2;
    operatorCam.top = cy + h / 2;
    operatorCam.bottom = cy - h / 2;
    operatorCam.updateProjectionMatrix();
  }

  // --------------------------------------------------------------- chalk marks
  let chalkSeen = 0;
  const chalkMeshes = [];
  function syncChalk(state) {
    if (state.chalk.length === chalkSeen) return;
    for (const m of chalkMeshes) chalkG.remove(m);
    chalkMeshes.length = 0;
    for (const k of state.chalk) {
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: COL.chalk, fog: false, transparent: true, opacity: 0.95 });
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.9, 4), mat);
      cone.position.y = 1.9;
      if (k.dir === 'left') cone.rotation.z = Math.PI / 2;
      else if (k.dir === 'right') cone.rotation.z = -Math.PI / 2;
      else if (k.dir === 'down') cone.rotation.z = Math.PI;
      else cone.rotation.x = -Math.PI / 2;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 6), mat);
      beam.position.y = 1.1;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.5, 20), mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      g.add(cone, beam, ring);
      g.traverse((o) => o.layers.set(LAYER.CHALK));
      g.position.set(k.x, k.y, k.z);
      chalkG.add(g);
      chalkMeshes.push(g);
    }
    chalkSeen = state.chalk.length;
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
      const mat = new THREE.MeshBasicMaterial({ color: 0xff6b6b, transparent: true, opacity: 0.5, fog: false });
      for (let i = 0; i < src.length; i += 4) {
        const g = src[i];
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.11, 6, 6), mat);
        m.position.set(g.x, g.y + 0.9, g.z);
        ghostG.add(m);
      }
    }
  }

  // ------------------------------------------------------------------ update
  function update(state, view) {
    // runner camera
    const r = view.runner;
    runnerCam.position.set(r.x, r.y + 1.55, r.z);
    runnerCam.rotation.set(view.pitch || 0, r.yaw + Math.PI, 0, 'YXZ');
    // knock shake: the Runner feels it, and the Bridge sees the same shake on the
    // Runner's cam (the Bridge is deaf, so the shake is his only knock cue)
    if (view.shake > 0) {
      const t = performance.now() * 0.001;
      const a = 0.04 * Math.min(1, view.shake / 0.35);
      runnerCam.rotation.x += Math.sin(t * 71) * a;
      runnerCam.rotation.y += Math.sin(t * 59 + 1.7) * a * 0.7;
      runnerCam.rotation.z += Math.sin(t * 83 + 0.4) * a;
      runnerCam.position.x += Math.sin(t * 67 + 2.2) * a * 0.3;
      runnerCam.position.y += Math.sin(t * 79 + 1.1) * a * 0.3;
    }

    // dynamic world meshes (neutral: shape only, never state)
    const sp = state.span;
    let ext = 0;
    if (sp.phase === 'moving') ext = 1 - Math.max(0, sp.timer) / 0.7;
    else if (sp.phase === 'extended') ext = 1;
    else if (sp.phase === 'retracting') ext = Math.max(0, sp.timer) / 0.5;
    spanMesh.visible = ext > 0.01;
    spanMesh.scale.z = Math.max(0.001, ext);
    spanMesh.position.set(0, LEVEL.span.y + LEVEL.span.h / 2, LEVEL.span.z0 + ((LEVEL.span.z1 - LEVEL.span.z0) * ext) / 2);

    liftMesh.position.set((L.x0 + L.x1) / 2, state.lift.y + 0.175, (L.z0 + L.z1) / 2);
    doorMesh.position.set((E.x0 + E.x1) / 2, E.y0 + (E.y1 - E.y0) / 2 + state.exit.open * 3.6, E.z + 0.2);

    // board overlays (state colours, invisible to the Runner by layer)
    boardSpan.visible = sp.phase !== 'out';
    boardSpan.scale.z = Math.max(0.001, ext);
    boardSpan.position.z = LEVEL.span.z0 + ((LEVEL.span.z1 - LEVEL.span.z0) * ext) / 2;
    boardSpan.material.color.set(sp.phase === 'extended' ? COL.ok : sp.phase === 'out' ? COL.bad : COL.warn);

    boardLift.position.y = state.lift.y + 0.175;
    boardDoor.position.y = E.y0 + (E.y1 - E.y0) / 2 + state.exit.open * 3.6;
    boardDoor.material.color.set(state.exit.open > 0.9 ? COL.ok : state.exit.armed ? COL.warn : COL.bad);
    boardHazard.material.opacity = 0.28 + 0.18 * Math.abs(Math.sin(state.t * 3));

    syncChalk(state);
    syncGhost(view.ghost, !state.dead);
  }

  // --------------------------------------------------------------- rendering
  const tmpM = new THREE.Matrix4();
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
  groundPlane.position.set(0, 0, 30);
  groundPlane.updateMatrixWorld(true);
  scene.add(groundPlane);
  groundPlane.layers.set(LAYER.BOARD); // only ever picked on purpose

  const ray = new THREE.Raycaster();
  function pick(cam, px, py, rect) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const nx = ((px * dpr - rect.x) / rect.w) * 2 - 1;
    const ny = -(((py * dpr - rect.y) / rect.h) * 2 - 1);
    ray.setFromCamera(new THREE.Vector2(nx, ny), cam);
    ray.layers.set(cam === operatorCam ? LAYER.BOARD : LAYER.WORLD);
    const targets = [];
    for (const c of scene.children) if (c.visible && c !== groundPlane) targets.push(c);
    let p = null;
    const hits = ray.intersectObjects(targets, true);
    if (hits.length) p = hits[0].point;
    else {
      ray.layers.mask = -1;
      const flat = ray.intersectObject(groundPlane, false);
      if (flat.length) p = flat[0].point;
    }
    if (!p) return null;
    return { x: Math.max(-3.6, Math.min(3.6, p.x)), y: 0, z: Math.max(0.5, Math.min(69, p.z)) };
  }

  return { renderer, scene, world, board, runnerCam, operatorCam, update, render, resize, pick, fitOrthoToLevel, liftTopClient: (s) => liftTop(s) };
}
