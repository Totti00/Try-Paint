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
const LENS_SHIFT = 0.085;      // sposta il soggetto verso l'alto (spazio per la didascalia)
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

  const axes = {};
  for (const [n, o] of Object.entries(model.parts)) if (o.userData.axis) axes[n] = o.userData.axis;
  const tl = buildTimeline({ axes });
  const tracks = Object.fromEntries(Object.entries(tl.tracks).map(([n, k]) => [n, compileTrack(k)]));
  const groups = Object.fromEntries(Object.entries(tl.groups).map(([n, k]) => [n, compileTrack(k)]));
  const cam = compileTrack(tl.camera.map((k) => ({ t: k.t, target: k.target, ld: Math.log(k.dist), az: k.az, el: k.el, fov: k.fov, ease: k.ease })));

  const camera = new THREE.PerspectiveCamera(30, W / H, 40, 60000);
  const camTarget = new THREE.Vector3();

  const stage = document.getElementById('stage');
  stage.style.transform = `scale(${W / 1920})`;
  const overlay = new Overlay(stage, tl);
  await Promise.all(overlay.images().map((img) => (img.complete ? img.decode() : new Promise((r) => { img.onload = r; img.onerror = r; })).catch(() => {})));

  const v = new THREE.Vector3();
  const project = (part, point) => {
    rig.anchorWorld(part, point, v);
    v.project(camera);
    return { x: (v.x + 1) * 960, y: (1 - v.y) * 540, behind: v.z > 1 };
  };

  function renderAt(t) {
    for (const [name, ch] of Object.entries(tracks)) {
      const st = evalPart(ch, t);
      if (rig.parts[name]) rig.setPart(name, st);
      else if (helpers[name]) helpers[name](st, t);
    }
    for (const [name, ch] of Object.entries(groups)) {
      rig.setGroup(name, { p: evalChannel(ch.p, t, [0, 0, 0]), r: evalChannel(ch.r, t, [0, 0, 0]) });
    }
    // camera orbitale: target + distanza (interpolata in log) + azimut/elevazione
    const tg = evalChannel(cam.target, t, [0, 0, 0]);
    const dist = Math.exp(evalChannel(cam.ld, t, Math.log(4000)));
    const az = evalChannel(cam.az, t, 30) * DEG, el = evalChannel(cam.el, t, 20) * DEG;
    camTarget.set(tg[0], tg[1], tg[2]);
    camera.position.set(tg[0] + dist * Math.cos(el) * Math.sin(az), tg[1] + dist * Math.sin(el), tg[2] + dist * Math.cos(el) * Math.cos(az));
    camera.fov = evalChannel(cam.fov, t, 30);
    camera.lookAt(camTarget);
    camera.setViewOffset(W, H, 0, H * LENS_SHIFT, W, H);   // chiama updateProjectionMatrix
    camera.updateMatrixWorld(true);
    scene.updateMatrixWorld(true);
    overlay.update(t, project);
    renderer.render(scene, camera);
    return t;
  }

  window.renderAt = renderAt;
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
