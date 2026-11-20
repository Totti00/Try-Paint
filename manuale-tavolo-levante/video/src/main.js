// main.js — scena three.js, luci, rig e funzione deterministica window.renderAt(t).
//
// Parametri URL:
//   ?w=1920&h=1080   dimensione del fotogramma (default: finestra)
//   ?render          modalita' render (nessun loop in tempo reale; usata da render.mjs)
//   ?t=42.5          (anteprima) parte da questo istante
//   ?cad=model.glb   usa il modello CAD reale al posto di parts.js (vedi README)

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildParametricModel, makeMaterials, JOINTS } from './parts.js';
import { Rig } from './rig.js';
import { buildTimeline } from './timeline.js';
import { compileTrack, evalPart, evalChannel } from './anim.js';
import { Overlay } from './overlay.js';

const qs = new URLSearchParams(location.search);
const RENDER_MODE = qs.has('render');
const W = +qs.get('w') || window.innerWidth;
const H = +qs.get('h') || window.innerHeight;
const DEG = Math.PI / 180;

async function loadFonts() {
  const specs = [
    '400 30px "Barlow"', '500 30px "Barlow"', '600 30px "Barlow"', '700 30px "Barlow"',
    '500 30px "Barlow Semi Condensed"', '600 30px "Barlow Semi Condensed"', '700 30px "Barlow Semi Condensed"', '800 30px "Barlow Semi Condensed"',
    '600 30px "Barlow Condensed"', '700 30px "Barlow Condensed"', '800 30px "Barlow Condensed"',
  ];
  await Promise.all(specs.map((f) => document.fonts.load(f, 'Aàèéìòù×—’0123456789')));
  await document.fonts.ready;
}

async function loadModel() {
  const param = buildParametricModel(THREE);
  if (!qs.get('cad')) return param;
  const { loadCadModel } = await import('./cad-loader.js');
  const cad = await loadCadModel(THREE, qs.get('cad'), {
    brandMaterials: qs.get('cadMaterials') !== 'keep' ? makeMaterials(THREE) : null,
    rotY: +(qs.get('cadRotY') || 0),
  });
  // le parti mancanti nel CAD (es. minuteria) restano quelle parametriche
  return { parts: { ...param.parts, ...cad.parts } };
}

function makeHelpers(scene) {
  const helpers = {};
  // asse di simmetria tratteggiato sul pavimento (passo 1)
  const dashes = [];
  for (let z = -640; z < 640; z += 72) dashes.push(new THREE.PlaneGeometry(12, 44).rotateX(-Math.PI / 2).translate(120, 1.5, z + 22));
  const dg = dashes.reduce((acc, g) => { acc.push(g.toNonIndexed()); return acc; }, []);
  const merged = new THREE.BufferGeometry();
  const pos = [];
  for (const g of dg) pos.push(...g.attributes.position.array);
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const mirrorMat = new THREE.MeshBasicMaterial({ color: 0xff7e00, transparent: true, opacity: 0, depthWrite: false });
  const mirror = new THREE.Mesh(merged, mirrorMat);
  mirror.renderOrder = 2;
  scene.add(mirror);
  helpers.MIRROR = (st) => { mirrorMat.opacity = 0.9 * st.o; mirror.visible = st.o > 0.002; };

  // anello arancio sul foro di serraggio piu' interno di T2 (passo 4)
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xff7e00, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const ring = new THREE.Mesh(new THREE.RingGeometry(8, 12, 32).rotateX(-Math.PI / 2), ringMat);
  ring.position.set(...JOINTS.holeT2_L_inner).add(new THREE.Vector3(0, 0.8, 0));
  ring.renderOrder = 3;
  scene.add(ring);
  helpers.HOLEMARK = (st, t) => {
    ringMat.opacity = st.o;
    ring.visible = st.o > 0.002;
    const k = 1 + 0.18 * Math.sin(t * 9);
    ring.scale.set(k, 1, k);
  };
  return helpers;
}

/** aloni arancio attorno alla minuteria evidenziata: rendono leggibili le viti nelle inquadrature larghe */
function makeHalos(scene, rig) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = '#fff'; g.lineWidth = 10;
  g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const halos = [];
  for (const name of Object.keys(rig.parts)) {
    if (!/^(M8_|WS_)/.test(name)) continue;
    const mat = new THREE.SpriteMaterial({ map: tex, color: 0xff7e00, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    const sp = new THREE.Sprite(mat);
    sp.renderOrder = 10;
    sp.visible = false;
    scene.add(sp);
    halos.push({ name, sp, mat });
  }
  return halos;
}

async function init() {
  await loadFonts();

  const canvas = document.getElementById('gl');
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8cec3, 0.9));
  const key = new THREE.DirectionalLight(0xfff8f0, 2.1);
  key.position.set(-2300, 5200, 2900);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -2600, right: 2600, top: 2600, bottom: -2600, near: 1000, far: 14000 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 1.5;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0xf4f0ff, 0.45);
  fill.position.set(3000, 1500, -1000);
  scene.add(fill);

  // pavimento invisibile che riceve solo le ombre
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000).rotateX(-Math.PI / 2),
    new THREE.ShadowMaterial({ color: 0x2b211a, opacity: 0.2 }));
  floor.receiveShadow = true;
  scene.add(floor);

  const model = await loadModel();
  const rig = new Rig(THREE, scene, model.parts);
  const helpers = makeHelpers(scene);
  const halos = makeHalos(scene, rig);

  const axes = {};
  for (const [n, o] of Object.entries(model.parts)) if (o.userData.axis) axes[n] = o.userData.axis;
  const tl = buildTimeline({ axes, joints: JOINTS });
  const tracks = Object.fromEntries(Object.entries(tl.tracks).map(([n, k]) => [n, compileTrack(k)]));
  const groups = Object.fromEntries(Object.entries(tl.groups).map(([n, k]) => [n, compileTrack(k)]));

  // camera: la lista di keyframe e' divisa in "inquadrature" ai keyframe con `cut`;
  // all'inizio di ogni inquadratura c'e' una dissolvenza incrociata di `cut` secondi
  // (true = DISSOLVE_DEFAULT, 0 = stacco netto).
  const DISSOLVE_DEFAULT = 0.4;
  const shots = [];
  for (const k of tl.camera) {
    if (!shots.length || (k.cut !== undefined && k.cut !== false)) {
      shots.push({ t0: k.t, dis: shots.length ? (k.cut === true ? DISSOLVE_DEFAULT : +k.cut) : 0, keys: [] });
    }
    shots[shots.length - 1].keys.push({ t: k.t, target: k.target, ld: Math.log(k.dist), az: k.az, el: k.el, fov: k.fov, sx: k.sx, sy: k.sy, ease: k.ease });
  }
  for (const sh of shots) sh.track = compileTrack(sh.keys);
  const shotIndexAt = (t) => {
    let i = 0;
    while (i + 1 < shots.length && shots[i + 1].t0 <= t) i++;
    return i;
  };

  const camera = new THREE.PerspectiveCamera(30, W / H, 40, 60000);     // inquadratura corrente
  const camPrev = new THREE.PerspectiveCamera(30, W / H, 40, 60000);    // inquadratura uscente (dissolvenza)
  const camTarget = new THREE.Vector3();
  // copia dell'inquadratura uscente, sopra il canvas WebGL: ha lo stesso fondale in CSS,
  // quindi con opacita' 1-u realizza una vera dissolvenza incrociata dello strato 3D
  const ghost = document.getElementById('ghost');
  ghost.width = W; ghost.height = H;
  ghost.style.width = W + 'px'; ghost.style.height = H + 'px';
  const gctx = ghost.getContext('2d');
  // nei primi piani il fondale si scurisce appena: l'alluminio bianco si stacca dal fondo
  const dimEl = document.getElementById('dim');
  const DIM_RGB = '150,130,110';
  const dimFor = (dist) => 0.17 * Math.min(1, Math.max(0, (2100 - dist) / 1100));

  const stage = document.getElementById('stage');
  stage.style.transform = `scale(${W / 1920})`;
  const overlay = new Overlay(stage, tl);
  await Promise.all(overlay.images().map((img) => (img.complete ? img.decode() : new Promise((r) => { img.onload = r; img.onerror = r; })).catch(() => {})));

  const v = new THREE.Vector3();
  let projCam = camera;
  const project = (part, point) => {
    rig.anchorWorld(part, point, v);
    v.project(projCam);
    return { x: (v.x + 1) * 960, y: (1 - v.y) * 540, behind: v.z > 1 };
  };

  /** posa una camera secondo un'inquadratura all'istante t; restituisce la distanza */
  function poseCamera(cam, shot, t) {
    const ch = shot.track;
    const tg = evalChannel(ch.target, t, [0, 0, 0]);
    const dist = Math.exp(evalChannel(ch.ld, t, Math.log(4000)));
    const az = evalChannel(ch.az, t, 30) * DEG, el = evalChannel(ch.el, t, 20) * DEG;
    camTarget.set(tg[0], tg[1], tg[2]);
    cam.position.set(tg[0] + dist * Math.cos(el) * Math.sin(az), tg[1] + dist * Math.sin(el), tg[2] + dist * Math.cos(el) * Math.cos(az));
    cam.fov = evalChannel(ch.fov, t, 30);
    cam.lookAt(camTarget);
    // decentramento ottico: sy>0 alza il soggetto (spazio per la didascalia), sx>0 lo sposta a sinistra
    cam.setViewOffset(W, H, W * evalChannel(ch.sx, t, 0), H * evalChannel(ch.sy, t, 0.085), W, H);
    cam.updateMatrixWorld(true);
    return dist;
  }

  // aloni: solo quando la camera e' lontana (nei primi piani la vite si vede gia')
  function updateHalos(hl, dist) {
    const far = Math.min(1, Math.max(0, (dist - 1400) / 900));
    for (const H of halos) {
      const a = (hl[H.name] || 0) * far;
      H.sp.visible = a > 0.01;
      if (!H.sp.visible) continue;
      const P = rig.parts[H.name];
      rig.anchorWorld(H.name, [P.center.x, P.center.y, P.center.z], H.sp.position);
      H.mat.opacity = 0.95 * a;
      const k = 90 + 60 * (1 - a);
      H.sp.scale.set(k, k, 1);
    }
  }
  // contorni piu' marcati nei primi piani: 0.4 -> ~0.66 sotto i 1200 mm
  const edgeScaleFor = (dist) => 1 + 0.65 * Math.min(1, Math.max(0, (2200 - dist) / 1000));

  function renderAt(t) {
    const hl = {};
    for (const [name, ch] of Object.entries(tracks)) {
      const st = evalPart(ch, t);
      hl[name] = st.h * st.o;
      if (rig.parts[name]) rig.setPart(name, st);
      else if (helpers[name]) helpers[name](st, t);
    }
    for (const [name, ch] of Object.entries(groups)) {
      rig.setGroup(name, { p: evalChannel(ch.p, t, [0, 0, 0]), r: evalChannel(ch.r, t, [0, 0, 0]) });
    }
    scene.updateMatrixWorld(true);
    // camera orbitale: target + distanza (interpolata in log) + azimut/elevazione
    const si = shotIndexAt(t), shot = shots[si];
    const u = si > 0 && shot.dis > 0 ? (t - shot.t0) / shot.dis : 1;
    let distPrev = null;
    if (u < 1) {
      // dissolvenza: prima l'inquadratura uscente, copiata nel canvas "ghost"
      distPrev = poseCamera(camPrev, shots[si - 1], t);
      rig.setEdgeScale(edgeScaleFor(distPrev));
      updateHalos(hl, distPrev);
      renderer.render(scene, camPrev);
      gctx.clearRect(0, 0, W, H);
      gctx.drawImage(canvas, 0, 0, W, H);
      const a = 1 - (u * u * (3 - 2 * u));
      const dp = dimFor(distPrev).toFixed(3);
      ghost.style.backgroundImage = `linear-gradient(rgba(${DIM_RGB},${dp}), rgba(${DIM_RGB},${dp})), var(--studio)`;
      ghost.style.opacity = a.toFixed(4);
      ghost.style.visibility = 'visible';
    } else {
      ghost.style.visibility = 'hidden';
    }
    const dist = poseCamera(camera, shot, t);
    dimEl.style.opacity = dimFor(dist).toFixed(3);
    rig.setEdgeScale(edgeScaleFor(dist));
    updateHalos(hl, dist);
    // le etichette seguono l'inquadratura dominante
    const dominant = u < 0.5 ? camPrev : camera;
    projCam = dominant;
    overlay.update(t, project, { dist: u < 0.5 ? distPrev : dist });
    renderer.render(scene, camera);
    return t;
  }

  window.renderAt = renderAt;
  window.__debug = { scene, rig, camera, shots: shots.map((s) => ({ t0: s.t0, dis: s.dis })) };          // per verifiche automatiche (vedi README)
  window.timeline = {
    duration: tl.duration, fps: tl.fps,
    steps: tl.steps.map(({ id, n, title, t0, t1 }) => ({ id, n, title, t0: +t0.toFixed(2), t1: +t1.toFixed(2) })),
  };
  renderAt(+qs.get('t') || 0);

  if (!RENDER_MODE) startPreview(renderAt, tl.duration);
  return true;
}

/** anteprima interattiva nel browser: spazio = pausa, frecce = ±2 s, cursore in basso */
function startPreview(renderAt, duration) {
  const bar = document.createElement('input');
  Object.assign(bar, { type: 'range', min: 0, max: duration, step: 0.01, value: 0 });
  Object.assign(bar.style, { position: 'fixed', left: '2%', right: '2%', bottom: '6px', width: '96%', zIndex: 10, opacity: 0.6 });
  document.body.appendChild(bar);
  let t = +qs.get('t') || 0, playing = true, last = performance.now();
  bar.addEventListener('input', () => { t = +bar.value; });
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') playing = !playing;
    if (e.code === 'ArrowRight') t = Math.min(duration, t + 2);
    if (e.code === 'ArrowLeft') t = Math.max(0, t - 2);
  });
  const loop = (now) => {
    if (playing) t = (t + (now - last) / 1000) % duration;
    last = now;
    bar.value = t;
    renderAt(t);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

window.ready = init().catch((e) => { console.error(e); window.initError = String(e && e.stack || e); throw e; });
