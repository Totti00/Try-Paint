// scene3d.js — parti comuni della scena three.js (viste delle parti e video 3D):
// renderer, luci da studio, caricamento di model.glb (un nodo per parte, nome = key),
// analisi geometrica delle parti (asse delle viti, testa, diametro), materiali, contorni, rig.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { highlightTint, hexToRgb } from './text.js';

export { THREE };

const DEG = Math.PI / 180;

// ------------------------------------------------------------------------------- renderer/luci

export function makeRenderer(canvas, W, H) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

/**
 * Luci da studio scalate sul raggio del modello (mm): ambiente RoomEnvironment, emisfero,
 * luce chiave con ombre morbide, luce di riempimento, pavimento invisibile che riceve l'ombra.
 */
export function setupStudio(renderer, scene, { radius, shadowColor = 0x2b211a, shadowOpacity = 0.2, mapSize = 2048 }) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  const R = Math.max(1, radius);
  const hemi = new THREE.HemisphereLight(0xffffff, 0xd8cec3, 0.9);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff8f0, 2.1);
  key.position.set(-0.36 * 7 * R, 0.82 * 7 * R, 0.45 * 7 * R);
  key.castShadow = true;
  key.shadow.mapSize.set(mapSize, mapSize);
  const S = 2.2 * R;
  Object.assign(key.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 7 * R - 3 * R, far: 7 * R + 3.5 * R });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = Math.max(0.2, R * 0.0016);
  key.shadow.radius = 3;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0xf4f0ff, 0.45);
  fill.position.set(1.3 * R, 0.65 * R, -0.45 * R);
  scene.add(fill);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(R * 60, R * 60).rotateX(-Math.PI / 2),
    new THREE.ShadowMaterial({ color: shadowColor, opacity: shadowOpacity, depthWrite: false }));
  floor.receiveShadow = true;
  floor.renderOrder = -1;
  scene.add(floor);
  return { key, fill, hemi, floor };
}

// ------------------------------------------------------------------------------- caricamento

/**
 * Carica model.glb normalizzato. Ogni nodo figlio della scena con nome = key e' una parte.
 * @param {string} url
 * @param {object[]} partsSummary  PartsSummary (ordine e nomi); se assente si usano i nodi del file
 * @returns {Promise<{ root: THREE.Object3D, parts: object[], byKey: Map, box: THREE.Box3 }>}
 */
export async function loadPartsModel(url, partsSummary = null) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const nodes = new Map();
  root.traverse((o) => {
    const k = (o.userData && o.userData.key) || null;
    if (k && !nodes.has(k)) nodes.set(k, o);
  });
  if (!nodes.size) {
    // GLB senza extras: si usano i figli diretti con nome
    const top = root.children.length === 1 && !root.children[0].isMesh ? root.children[0] : root;
    for (const c of top.children) if (c.name) nodes.set(c.name, c);
  }
  const order = partsSummary && partsSummary.length ? partsSummary.map((p) => p.key) : [...nodes.keys()];
  const summaryByKey = new Map((partsSummary || []).map((p) => [p.key, p]));
  const parts = [];
  for (const key of order) {
    const node = nodes.get(key);
    if (!node) continue;
    const meshes = [];
    node.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o); });
    if (!meshes.length) continue;
    const sum = summaryByKey.get(key) || {};
    const box = new THREE.Box3().setFromObject(node, true);
    parts.push({
      key, node, meshes,
      name: sum.name || node.userData.name || key,
      group: sum.similar_group || node.userData.similar_group || key,
      box, center: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()),
      triangles: meshes.reduce((n, m) => n + triCount(m.geometry), 0),
    });
  }
  if (!parts.length) throw new Error('Il modello 3D non contiene parti riconoscibili (model.glb vuoto?)');
  const box = new THREE.Box3();
  for (const p of parts) box.union(p.box);
  return { root, parts, byKey: new Map(parts.map((p) => [p.key, p])), box };
}

export const triCount = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;

// ------------------------------------------------------------------------------- analisi parti

function jacobiEigen(m) {
  // m: matrice simmetrica 3x3 (array di righe). Restituisce { values:[3], vectors:[[3],[3],[3]] (colonne) }
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off < 1e-18) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-20) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const values = [a[0][0], a[1][1], a[2][2]];
  const vectors = [0, 1, 2].map((j) => [v[0][j], v[1][j], v[2][j]]);
  return { values, vectors };
}

/** campioni (centroide, area) dei triangoli di una lista di mesh, in coordinate del nodo parte */
function triangleSamples(meshes, rootNode, maxTris = 30000) {
  const out = [];
  const inv = new THREE.Matrix4().copy(rootNode.matrixWorld).invert();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (const m of meshes) {
    const g = m.geometry, pos = g.attributes.position, idx = g.index;
    const n = triCount(g);
    const step = Math.max(1, Math.floor(n / maxTris));
    const M = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    for (let i = 0; i < n; i += step) {
      const i0 = idx ? idx.getX(3 * i) : 3 * i, i1 = idx ? idx.getX(3 * i + 1) : 3 * i + 1, i2 = idx ? idx.getX(3 * i + 2) : 3 * i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(M);
      b.fromBufferAttribute(pos, i1).applyMatrix4(M);
      c.fromBufferAttribute(pos, i2).applyMatrix4(M);
      const area = e1.subVectors(b, a).cross(e2.subVectors(c, a)).length() / 2;
      if (!(area > 0)) continue;
      out.push({ x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3, w: area * step, pts: [a.clone(), b.clone(), c.clone()] });
    }
  }
  return out;
}

/**
 * Analisi di forma di una parte: assi principali, forma (asta/disco/altro), asse di simmetria,
 * lato della testa (per le viti), lunghezza e diametro. Coordinate locali del nodo (mm).
 */
export function analyzePart(part) {
  part.node.updateMatrixWorld(true);
  const S = triangleSamples(part.meshes, part.node);
  let W = 0, cx = 0, cy = 0, cz = 0;
  for (const s of S) { W += s.w; cx += s.w * s.x; cy += s.w * s.y; cz += s.w * s.z; }
  if (!(W > 0)) return { shape: 'other', axis: null, centroid: new THREE.Vector3(), sigma: [0, 0, 0], area: 0 };
  cx /= W; cy /= W; cz /= W;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const s of S) {
    const d = [s.x - cx, s.y - cy, s.z - cz];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += s.w * d[i] * d[j];
  }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] /= W;
  const { values, vectors } = jacobiEigen(C);
  const ord = [0, 1, 2].sort((i, j) => values[j] - values[i]);
  const sig = ord.map((i) => Math.sqrt(Math.max(0, values[i])));
  const vec = ord.map((i) => new THREE.Vector3(...vectors[i]).normalize());
  const r12 = sig[1] / (sig[0] || 1), r23 = sig[2] / (sig[1] || 1);
  let shape = 'other', axis = null;
  if (r23 > 0.8 && r12 < 0.82) { shape = 'rod'; axis = vec[0]; }
  else if (r12 > 0.85 && r23 < 0.75) { shape = 'disc'; axis = vec[2]; }
  else if (r12 > 0.85 && r23 > 0.85) { shape = 'compact'; axis = null; }
  const centroid = new THREE.Vector3(cx, cy, cz);
  const info = { shape, axis, centroid, sigma: sig, area: W, principal: vec };
  if (axis) {
    // estensione assiale e raggio alle due estremita' (testa = estremita' piu' larga)
    let tmin = Infinity, tmax = -Infinity;
    const tmp = new THREE.Vector3();
    for (const s of S) for (const p of s.pts) { const t = tmp.subVectors(p, centroid).dot(axis); if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
    const len = tmax - tmin || 1;
    let rLo = 0, rHi = 0, rMid = 0;
    for (const s of S) for (const p of s.pts) {
      tmp.subVectors(p, centroid);
      const t = tmp.dot(axis);
      const r = Math.sqrt(Math.max(0, tmp.lengthSq() - t * t));
      const u = (t - tmin) / len;
      if (u < 0.18) rLo = Math.max(rLo, r);
      else if (u > 0.82) rHi = Math.max(rHi, r);
      else rMid = Math.max(rMid, r);
    }
    info.length = len;
    info.tmin = tmin; info.tmax = tmax;
    info.radius = Math.max(rLo, rHi, rMid);
    // direzione di inserimento = dalla testa (larga) verso la punta (stretta)
    if (shape === 'rod' && Math.max(rLo, rHi) > 1.2 * Math.min(rLo, rHi)) {
      info.insertDir = rHi > rLo ? axis.clone().negate() : axis.clone();
      info.headKnown = true;
      info.diameter = 2 * Math.max(Math.min(rLo, rHi), rMid * 0.8);
    } else {
      info.insertDir = axis.clone();
      info.headKnown = false;
      info.diameter = 2 * (shape === 'disc' ? info.radius : Math.min(rMid || info.radius, info.radius));
    }
  }
  return info;
}

// ------------------------------------------------------------------------------- materiali

const ROLE_MATERIAL = {
  component: { color: 0xf3f1ed, roughness: 0.55, metalness: 0.0 },
  hardware: { color: 0xd2d5d8, roughness: 0.28, metalness: 0.85 },
  ignore: { color: 0xe9e4de, roughness: 0.7, metalness: 0.0 },
};

function isGarish(color) {
  // colori di prova dei CAD (rosso/verde/blu puri ecc.): molto saturi e di luminosita' media
  const c = color.clone().convertLinearToSRGB();
  const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
  const l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return s > 0.62 && l > 0.2 && l < 0.82;
}

/**
 * Prepara materiali e contorni delle parti. I colori del CAD vengono mantenuti se "da materiale"
 * (tessiture, colori poco saturi e non tutti uguali); altrimenti tavolozza per ruolo.
 * @param roles Map key -> 'component'|'hardware'|'ignore'
 */
export function styleParts(parts, { roles, theme, edgeOpacity = 0.4, ink = '#1F1C1A', maxEdgeTris = 250000 }) {
  const all = parts.flatMap((p) => p.meshes);
  const colors = new Set();
  for (const m of all) {
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    if (mat && mat.color && !mat.map) colors.add(mat.color.getHexString());
  }
  const uniform = colors.size <= 1;
  const inkC = new THREE.Color(ink);
  for (const p of parts) {
    const role = roles.get(p.key) || 'component';
    p.role = role;
    p.edges = [];
    for (const m of p.meshes) {
      const src = Array.isArray(m.material) ? m.material[0] : m.material;
      let mat;
      const keep = src && (src.map || (!uniform && src.color && !isGarish(src.color)) || src.isMeshBasicMaterial);
      if (keep && src.isMeshBasicMaterial) {
        mat = src.clone();
        m.userData.noEdges = true;
        m.userData.basic = true;
      } else if (keep) {
        mat = new THREE.MeshStandardMaterial({
          color: src.color ? src.color.clone() : new THREE.Color(0xf3f1ed),
          map: src.map || null,
          roughness: src.roughness !== undefined ? Math.max(0.2, src.roughness) : 0.6,
          metalness: src.metalness !== undefined ? src.metalness : 0.0,
          vertexColors: !!src.vertexColors,
        });
      } else {
        mat = new THREE.MeshStandardMaterial(ROLE_MATERIAL[role] || ROLE_MATERIAL.component);
      }
      mat.side = THREE.DoubleSide;
      mat.shadowSide = THREE.BackSide;
      m.material = mat;
      m.castShadow = !m.userData.basic;
      m.receiveShadow = true;
      m.userData.baseColor = mat.color ? mat.color.clone() : null;
      m.userData.baseEmissive = mat.emissive ? mat.emissive.clone() : null;
      m.userData.baseCast = m.castShadow;
      if (!m.userData.noEdges && triCount(m.geometry) <= maxEdgeTris) {
        const eg = new THREE.EdgesGeometry(m.geometry, 30);
        const lm = new THREE.LineBasicMaterial({ color: inkC.clone(), transparent: true, opacity: edgeOpacity, depthWrite: false });
        const ls = new THREE.LineSegments(eg, lm);
        ls.userData.isEdge = true;
        ls.userData.baseOpacity = edgeOpacity;
        ls.raycast = () => {};
        m.add(ls);
        p.edges.push(ls);
      }
    }
  }
  return { uniformColors: uniform, tint: new THREE.Color(highlightTint(theme.accent)), accent: new THREE.Color(theme.accent) };
}

// ------------------------------------------------------------------------------- rig

/**
 * Rig delle parti: ogni parte resta appesa al gruppo "assembly" (capovolgimenti) e si muove con
 *  p  = spostamento (mm) nel sistema del montato,
 *  s  = rotazione di avvitamento (rad) attorno al proprio asse passante per il baricentro,
 *  o  = opacita', h = evidenziazione arancio, g = "fantasma" (viste delle parti).
 */
export class Rig {
  constructor(scene, model, { theme, ink = '#1F1C1A' }) {
    this.parts = model.parts;
    this.byKey = model.byKey;
    this.assembly = new THREE.Group();
    this.assembly.name = 'assembly';
    this.assembly.matrixAutoUpdate = false;
    scene.add(this.assembly);
    this.tint = new THREE.Color(highlightTint(theme.accent));
    this.accent = new THREE.Color(theme.accent);
    this.glow = new THREE.Color(theme.accent);
    this.ink = new THREE.Color(ink);
    this.ghostColor = new THREE.Color(0xcfc8c0);
    this.edgeK = 1;
    this.q = new THREE.Quaternion();
    this.v = new THREE.Vector3();
    for (const p of this.parts) {
      p.base = p.node.position.clone();         // = centro del box (posizione di montaggio)
      p.baseQ = p.node.quaternion.clone();
      this.assembly.add(p.node);
      p.state = { o: -1, h: -1, g: -1, ek: -1 };
      p.pivot = p.info && p.info.centroid ? p.info.centroid.clone() : new THREE.Vector3();
      p.spinAxis = p.info && p.info.axis ? p.info.axis.clone() : new THREE.Vector3(0, 1, 0);
    }
  }

  setFrame(m4) {
    this.assembly.matrix.copy(m4);
    this.assembly.matrixWorldNeedsUpdate = true;
  }

  setPart(p, st) {
    const node = p.node;
    // rotazione di avvitamento attorno al baricentro: pos = base + off + (pivot - R*pivot)
    if (st.s) {
      this.q.setFromAxisAngle(p.spinAxis, st.s);
      node.quaternion.copy(p.baseQ).multiply(this.q);
      this.v.copy(p.pivot).applyQuaternion(this.q).negate().add(p.pivot).applyQuaternion(p.baseQ);
    } else {
      node.quaternion.copy(p.baseQ);
      this.v.set(0, 0, 0);
    }
    node.position.set(p.base.x + st.p[0] + this.v.x, p.base.y + st.p[1] + this.v.y, p.base.z + st.p[2] + this.v.z);
    this.setLook(p, st.o, st.h || 0, st.g || 0);
  }

  setEdgeScale(k) {
    if (Math.abs(k - this.edgeK) < 0.004) return;
    this.edgeK = k;
  }

  /** opacita' / evidenziazione / fantasma, ricalcolati solo se cambiano */
  setLook(p, o, h, g) {
    const S = p.state;
    if (Math.abs(o - S.o) < 1e-4 && Math.abs(h - S.h) < 1e-4 && Math.abs(g - S.g) < 1e-4 && Math.abs(this.edgeK - S.ek) < 1e-4) return;
    S.o = o; S.h = h; S.g = g; S.ek = this.edgeK;
    p.node.visible = o > 0.003;
    const ghostA = 1 - 0.82 * g;                 // fantasma: molto trasparente
    const alpha = o * ghostA;
    const tr = alpha < 0.999;
    for (const m of p.meshes) {
      const mat = m.material;
      mat.transparent = tr;
      mat.opacity = alpha;
      mat.depthWrite = alpha > 0.35;
      m.castShadow = m.userData.baseCast && alpha > 0.55;
      m.renderOrder = g > 0.5 ? 2 : 0;
      if (mat.color && m.userData.baseColor && !m.userData.basic) {
        mat.color.copy(m.userData.baseColor);
        if (g > 0) mat.color.lerp(this.ghostColor, g);
        if (h > 0) mat.color.lerp(this.tint, 0.62 * h);
      }
      if (mat.emissive && m.userData.baseEmissive) {
        mat.emissive.copy(this.glow).multiplyScalar(0.15 * h).add(m.userData.baseEmissive);
      }
    }
    for (const e of p.edges) {
      const base = Math.min(1, e.userData.baseOpacity * this.edgeK) * (1 - 0.7 * g);
      e.material.color.copy(this.ink).lerp(this.accent, h);
      e.material.opacity = (base + (0.9 - base) * h) * o;
      e.visible = o > 0.01;
    }
  }
}

// ------------------------------------------------------------------------------- camera

/**
 * Distanza della camera per inquadrare dei punti, con direzione (az, el in gradi; az 0 = da +Z,
 * 90 = da +X) e area utile in NDC: x tra xLo e xHi, y tra yLo e yHi. Restituisce
 * { target, dist, sx, sy }: il soggetto viene centrato nell'area utile con il decentramento ottico
 * (setViewOffset, vedi poseOrbit).
 */
export function frameCamera(points, { az, el, fov = 30, aspect = 16 / 9, hx = 0.86, xLo = null, xHi = null, yLo = -0.5, yHi = 0.8, minDist = 1 }) {
  const A = az * DEG, E = el * DEG;
  const w = new THREE.Vector3(Math.cos(E) * Math.sin(A), Math.sin(E), Math.cos(E) * Math.cos(A));   // verso la camera
  const r = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), w).normalize();
  const u = new THREE.Vector3().crossVectors(w, r).normalize();
  const tv = Math.tan(fov * DEG / 2), th = tv * aspect;
  const x0n = xLo ?? -hx, x1n = xHi ?? hx;
  const hxx = (x1n - x0n) / 2, xc = (x1n + x0n) / 2;
  const hy = (yHi - yLo) / 2, yc = (yHi + yLo) / 2;
  const box = new THREE.Box3().setFromPoints(points);
  const target = box.getCenter(new THREE.Vector3());
  let dist = minDist;
  const q = new THREE.Vector3();
  for (let iter = 0; iter < 4; iter++) {
    dist = minDist;
    for (const p of points) {
      q.copy(p).sub(target);
      const qw = q.dot(w), qr = Math.abs(q.dot(r)), qu = Math.abs(q.dot(u));
      dist = Math.max(dist, qw + qr / (hxx * th), qw + qu / (hy * tv));
    }
    // ricentra la proiezione (la prospettiva sposta il centro apparente)
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const p of points) {
      q.copy(p).sub(target);
      const z = dist - q.dot(w);
      if (z <= 1e-6) continue;
      const x = q.dot(r) / (z * th), y = q.dot(u) / (z * tv);
      a0 = Math.min(a0, x); a1 = Math.max(a1, x); b0 = Math.min(b0, y); b1 = Math.max(b1, y);
    }
    if (!isFinite(a0)) break;
    const mx = (a0 + a1) / 2, my = (b0 + b1) / 2;
    if (Math.abs(mx) < 0.005 && Math.abs(my) < 0.005) break;
    target.addScaledVector(r, mx * dist * th).addScaledVector(u, my * dist * tv);
  }
  return { target, dist, sx: -xc / 2, sy: yc / 2, w, r, u };
}

/** posiziona una camera orbitale (target, dist, az, el, fov, sy = decentramento verticale) */
export function poseOrbit(cam, W, H, { target, dist, az, el, fov = 30, sx = 0, sy = 0 }) {
  const A = az * DEG, E = el * DEG;
  cam.position.set(target[0] + dist * Math.cos(E) * Math.sin(A), target[1] + dist * Math.sin(E), target[2] + dist * Math.cos(E) * Math.cos(A));
  cam.fov = fov;
  cam.near = Math.max(0.5, dist * 0.02);
  cam.far = dist * 40 + 10;
  cam.up.set(0, 1, 0);
  cam.lookAt(target[0], target[1], target[2]);
  cam.setViewOffset(W, H, W * sx, H * sy, W, H);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
}

export function colorFromHex(hex) {
  const c = hexToRgb(hex) || [255, 126, 0];
  return new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
}
