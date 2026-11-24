// importer.js — pagina headless per:
//  window.importModel({ url, ext, fileName, upAxis })  -> legge STEP/IGES (occt-import-js), GLB/GLTF,
//      OBJ, STL; individua le parti; normalizza (mm, Y in alto, centrato, a terra); raggruppa le parti
//      identiche; scrive model.glb (PUT /__upload/model.glb) e restituisce { parts, meta }.
//  window.renderViews({ glbUrl, parts, max, width, height, theme, dir }) -> viste PNG per Claude.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import {
  makeRenderer, setupStudio, loadPartsModel, analyzePart, styleParts, Rig, frameCamera, poseOrbit, triCount,
} from './scene3d.js';
import { resolveTheme } from './text.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const progress = (pct, msg) => { try { window.__progress && window.__progress(Math.round(pct), msg); } catch { /* facoltativo */ } };
const tick = () => new Promise((r) => setTimeout(r, 0));

// ------------------------------------------------------------------------------------ lettura

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('impossibile caricare ' + src));
    document.head.appendChild(s);
  });
}

let occtPromise = null;
async function getOcct() {
  if (!occtPromise) {
    occtPromise = (async () => {
      if (!window.occtimportjs) await loadScript('/vendor/occt/occt-import-js.js');
      return window.occtimportjs({ locateFile: (name) => '/vendor/occt/' + name });
    })();
  }
  return occtPromise;
}

function srgbColor(rgb) {
  return new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
}

/** STEP/IGES -> una parte per mesh di occt (ogni mesh e' un prodotto/solido con nome) */
async function parseOcct(buf, ext) {
  progress(12, 'Avvio del lettore CAD (OpenCascade)…');
  const occt = await getOcct();
  progress(20, 'Lettura della geometria CAD e triangolazione…');
  await tick();
  const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.0015, angularDeflection: 0.5 };
  const data = new Uint8Array(buf);
  const res = ext === 'iges' || ext === 'igs' ? occt.ReadIgesFile(data, params) : occt.ReadStepFile(data, params);
  if (!res || !res.success) throw new Error('Il file CAD non è leggibile (STEP/IGES non valido o non supportato).');
  if (!res.meshes || !res.meshes.length) throw new Error('Il file CAD non contiene solidi o superfici da mostrare (se è un assieme che rimanda ad altri file, esportarlo dal CAD come file unico con tutte le parti).');
  const parts = [];
  const walk = (node, parentName) => {
    for (const mi of node.meshes || []) {
      const m = res.meshes[mi];
      if (!m || !m.attributes || !m.attributes.position) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
      if (m.attributes.normal) g.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
      if (m.index) g.setIndex(m.index.array.length > 65535 ? new THREE.Uint32BufferAttribute(m.index.array, 1) : new THREE.Uint16BufferAttribute(m.index.array, 1));
      if (!g.attributes.normal) g.computeVertexNormals();
      let color = m.color;
      if (!color && m.brep_faces && m.brep_faces.length) {
        // colore prevalente delle facce
        const tally = new Map();
        for (const f of m.brep_faces) if (f.color) {
          const k = f.color.join(',');
          tally.set(k, (tally.get(k) || 0) + (f.last - f.first + 1));
        }
        let best = null, n = 0;
        for (const [k, c] of tally) if (c > n) { n = c; best = k; }
        if (best) color = best.split(',').map(Number);
      }
      const mat = new THREE.MeshStandardMaterial({ color: color ? srgbColor(color) : new THREE.Color(0xcccccc), roughness: 0.6, metalness: 0.05 });
      const mesh = new THREE.Mesh(g, mat);
      mesh.updateMatrixWorld(true);
      parts.push({ name: (m.name || node.name || parentName || '').trim(), meshes: [mesh] });
    }
    for (const c of node.children || []) walk(c, node.name || parentName);
  };
  walk(res.root, '');
  return { parts, unitsKnown: true };
}

const GENERIC_NAME = /^(mesh|object|obj|body|solid|shape|part|geometry|node|group|primitive|polysurface|brep|default|untitled|component|corpo|parte)?[\s_.\-#]*\d*$/i;
const isGeneric = (n) => !n || GENERIC_NAME.test(String(n).trim());

/** GLB/GLTF -> parti: nodi con geometria; i figli senza nome (foglie) confluiscono nel nodo padre con nome */
async function parseGltf(buf, url) {
  const draco = new DRACOLoader().setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/');
  const loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const gltf = await loader.parseAsync(buf, base);
  draco.dispose();
  const scene = gltf.scene || (gltf.scenes && gltf.scenes[0]);
  if (!scene) throw new Error('Il file glTF non contiene una scena.');
  scene.updateMatrixWorld(true);
  const assoc = gltf.parser.associations;
  const isNode = (o) => { const a = assoc.get(o); return !!(a && a.nodes !== undefined); };
  const named = (o) => !!(o.userData && o.userData.name && !isGeneric(o.userData.name));
  const isRealMesh = (o) => o.isMesh && !o.isLine && !o.isPoints && o.geometry && o.geometry.attributes.position;
  const containsMesh = (o) => { let f = false; o.traverse((c) => { if (isRealMesh(c)) f = true; }); return f; };
  const ownMeshes = (o) => [...(isRealMesh(o) ? [o] : []), ...o.children.filter((c) => isRealMesh(c) && !isNode(c))];
  const childNodes = (o) => o.children.filter((c) => (isNode(c) || !isRealMesh(c)) && containsMesh(c));
  const allMeshes = (o) => { const a = []; o.traverse((c) => { if (isRealMesh(c)) a.push(c); }); return a; };
  const parts = [];
  const nameOf = (o, meshes) => (o.userData && o.userData.name) || (meshes[0] && !/^mesh_\d+$/.test(meshes[0].name) ? meshes[0].name : '') || o.name || '';
  const visit = (o) => {
    const own = ownMeshes(o);
    const kids = childNodes(o);
    const absorb = named(o) ? kids.filter((k) => !named(k) && childNodes(k).length === 0) : [];
    const meshes = [...own, ...absorb.flatMap(allMeshes)];
    if (meshes.length) parts.push({ name: nameOf(o, meshes), meshes });
    for (const k of kids) if (!absorb.includes(k)) visit(k);
  };
  for (const c of scene.children) visit(c);
  return { parts, unitsKnown: false };
}

async function parseObj(buf, url) {
  const text = new TextDecoder().decode(buf);
  const loader = new OBJLoader();
  const mtl = /^\s*mtllib\s+(.+?)\s*$/m.exec(text);
  if (mtl) {
    try {
      const base = url.slice(0, url.lastIndexOf('/') + 1);
      const r = await fetch(base + encodeURIComponent(mtl[1]));
      if (r.ok) {
        const mats = new MTLLoader().parse(await r.text(), base);
        mats.preload();
        loader.setMaterials(mats);
      }
    } catch { /* materiali facoltativi */ }
  }
  const group = loader.parse(text);
  group.updateMatrixWorld(true);
  const meshes = [];
  group.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o); });
  // stesso nome + box che si toccano = stessa parte (es. oggetti spezzati per materiale)
  const items = meshes.map((m) => ({ name: (m.name || '').trim(), meshes: [m], box: new THREE.Box3().setFromObject(m) }));
  const all = new THREE.Box3();
  for (const it of items) all.union(it.box);
  const tol = all.getSize(new THREE.Vector3()).length() * 0.002;
  const out = [];
  for (const it of items) {
    const near = it.box.clone().expandByScalar(tol);
    const tgt = it.name && !isGeneric(it.name) ? out.find((o) => o.name === it.name && o.box.intersectsBox(near)) : null;
    if (tgt) { tgt.meshes.push(...it.meshes); tgt.box.union(it.box); } else out.push(it);
  }
  return { parts: out.map(({ name, meshes: ms }) => ({ name, meshes: ms })), unitsKnown: false };
}

function parseStl(buf, fileName) {
  const g = new STLLoader().parse(buf);
  if (!g.attributes.normal) g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0xcccccc, vertexColors: !!g.hasColors });
  const mesh = new THREE.Mesh(g, mat);
  mesh.updateMatrixWorld(true);
  return { parts: [{ name: fileName.replace(/\.[^.]+$/, ''), meshes: [mesh] }], unitsKnown: false };
}

// ------------------------------------------------------------------------------------ utilita'

/** geometria con soli attributi utili, con indice (anche se l'originale non lo ha) */
function cleanGeometry(src, keepUv, keepColor) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', src.attributes.position.clone());
  if (src.attributes.normal) g.setAttribute('normal', src.attributes.normal.clone());
  if (keepUv && src.attributes.uv) g.setAttribute('uv', src.attributes.uv.clone());
  if (keepColor && src.attributes.color) g.setAttribute('color', src.attributes.color.clone());
  if (src.index) g.setIndex(src.index.clone());
  return g;
}

/** sotto-geometria compatta (solo i vertici usati) per un gruppo di materiale */
function subGeometry(src, start, count) {
  const idx = src.index;
  const map = new Map();
  const newIdx = [];
  for (let i = start; i < start + count; i++) {
    const v = idx ? idx.getX(i) : i;
    let n = map.get(v);
    if (n === undefined) { n = map.size; map.set(v, n); }
    newIdx.push(n);
  }
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) {
    const arr = new attr.array.constructor(map.size * attr.itemSize);
    for (const [v, n] of map) for (let k = 0; k < attr.itemSize; k++) arr[n * attr.itemSize + k] = attr.array[v * attr.itemSize + k];
    g.setAttribute(name, new THREE.BufferAttribute(arr, attr.itemSize, attr.normalized));
  }
  g.setIndex(map.size > 65535 ? new THREE.Uint32BufferAttribute(newIdx, 1) : new THREE.Uint16BufferAttribute(newIdx, 1));
  return g;
}

/** separa una mesh unica nei suoi pezzi connessi (STL/OBJ di assiemi esportati come un solo oggetto) */
function splitComponents(mesh, maxParts = 400) {
  const g = mesh.geometry, pos = g.attributes.position;
  const n = triCount(g);
  if (n < 2 || n > 3e6) return null;
  g.computeBoundingBox();
  const diag = g.boundingBox.getSize(new THREE.Vector3()).length() || 1;
  const q = diag * 1e-5;
  const key = (i) => Math.round(pos.getX(i) / q) + '_' + Math.round(pos.getY(i) / q) + '_' + Math.round(pos.getZ(i) / q);
  const weld = new Map();
  const vid = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    let w = weld.get(k);
    if (w === undefined) { w = weld.size; weld.set(k, w); }
    vid[i] = w;
  }
  const parent = new Int32Array(weld.size).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const idx = g.index;
  const vi = (k) => vid[idx ? idx.getX(k) : k];
  for (let t = 0; t < n; t++) { unite(vi(3 * t), vi(3 * t + 1)); unite(vi(3 * t), vi(3 * t + 2)); }
  const comp = new Map();
  for (let t = 0; t < n; t++) {
    const r = find(vi(3 * t));
    let a = comp.get(r);
    if (!a) { a = []; comp.set(r, a); }
    a.push(t);
  }
  if (comp.size < 2 || comp.size > maxParts) return null;
  // pezzi minuscoli (meno di 4 triangoli) restano uniti al primo pezzo
  const groups = [...comp.values()].sort((a, b) => a[0] - b[0]);
  const main = groups.filter((a) => a.length >= 4);
  if (main.length < 2) return null;
  const tiny = groups.filter((a) => a.length < 4).flat();
  if (tiny.length) main[0].push(...tiny);
  // pezzi piatti (decalcomanie, superfici senza spessore): uniti al pezzo solido piu' piccolo che li contiene
  const boxOf = (tris) => {
    const b = new THREE.Box3(), v = new THREE.Vector3();
    for (const t of tris) for (let k = 0; k < 3; k++) b.expandByPoint(v.fromBufferAttribute(pos, idx ? idx.getX(3 * t + k) : 3 * t + k));
    return b;
  };
  const info = main.map((tris) => { const b = boxOf(tris); const sz = b.getSize(new THREE.Vector3()); return { tris, b, sz, flat: Math.min(sz.x, sz.y, sz.z) < 0.02 * Math.max(sz.x, sz.y, sz.z) }; });
  const solid = info.filter((x) => !x.flat);
  if (solid.length) {
    for (const f of info.filter((x) => x.flat)) {
      const c = f.b.getCenter(new THREE.Vector3());
      const host = solid.filter((x) => x.b.clone().expandByScalar(diag * 0.003).containsPoint(c))
        .sort((a, b) => a.sz.length() - b.sz.length()).find((x) => x.sz.length() > f.sz.length());
      if (host) { host.tris.push(...f.tris); f.merged = true; }
    }
  }
  const finalGroups = info.filter((x) => !x.merged).map((x) => x.tris);
  if (finalGroups.length < 2) return null;
  return finalGroups.map((tris) => {
    const sub = new THREE.BufferGeometry();
    const order = [];
    for (const t of tris) order.push(3 * t, 3 * t + 1, 3 * t + 2);
    const map = new Map(); const newIdx = [];
    for (const k of order) { const v = idx ? idx.getX(k) : k; let m = map.get(v); if (m === undefined) { m = map.size; map.set(v, m); } newIdx.push(m); }
    for (const [name, attr] of Object.entries(g.attributes)) {
      const arr = new attr.array.constructor(map.size * attr.itemSize);
      for (const [v, m] of map) for (let c = 0; c < attr.itemSize; c++) arr[m * attr.itemSize + c] = attr.array[v * attr.itemSize + c];
      sub.setAttribute(name, new THREE.BufferAttribute(arr, attr.itemSize, attr.normalized));
    }
    sub.setIndex(map.size > 65535 ? new THREE.Uint32BufferAttribute(newIdx, 1) : new THREE.Uint16BufferAttribute(newIdx, 1));
    const m = new THREE.Mesh(sub, mesh.material);
    m.matrixWorld.copy(mesh.matrixWorld);
    m.matrixAutoUpdate = false;
    return m;
  });
}

/** statistiche per la scelta dell'asse verticale (coordinate sorgente) */
function axisStats(parts) {
  const box = new THREE.Box3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const tris = [];
  for (const p of parts) for (const m of p.meshes) {
    const g = m.geometry, pos = g.attributes.position, idx = g.index, n = triCount(g);
    const step = Math.max(1, Math.floor(n / 40000));
    for (let i = 0; i < n; i += step) {
      a.fromBufferAttribute(pos, idx ? idx.getX(3 * i) : 3 * i).applyMatrix4(m.matrixWorld);
      b.fromBufferAttribute(pos, idx ? idx.getX(3 * i + 1) : 3 * i + 1).applyMatrix4(m.matrixWorld);
      c.fromBufferAttribute(pos, idx ? idx.getX(3 * i + 2) : 3 * i + 2).applyMatrix4(m.matrixWorld);
      const area = e1.subVectors(b, a).cross(e2.subVectors(c, a)).length() / 2 * step;
      box.expandByPoint(a); box.expandByPoint(b); box.expandByPoint(c);
      tris.push([(a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3, area]);
    }
  }
  const size = box.getSize(new THREE.Vector3());
  const mean = [0, 0, 0];
  let W = 0;
  for (const t of tris) {
    W += t[3];
    mean[0] += t[3] * (t[0] - box.min.x) / (size.x || 1);
    mean[1] += t[3] * (t[1] - box.min.y) / (size.y || 1);
    mean[2] += t[3] * (t[2] - box.min.z) / (size.z || 1);
  }
  const m = mean.map((v) => (W > 0 ? v / W : 0.5));
  return { box, size, asym: m.map((v) => Math.abs(v - 0.5)), mean: m };
}

function decideUpAxis(stats, format, override, scale = 1) {
  if (override === 'y' || override === 'z') return { axis: override, reason: 'scelto dall’utente' };
  const { asym } = stats;
  const size = stats.size.clone().multiplyScalar(scale);
  const dz = asym[2] - asym[1];
  const fmt = format.toUpperCase();
  const fmtNum = (v) => v.toFixed(2).replace('.', ',');
  const detail = `asimmetria Y ${fmtNum(asym[1])}, Z ${fmtNum(asym[2])}; altezza con Y ${Math.round(size.y)}, con Z ${Math.round(size.z)}`;
  if (format === 'glb' || format === 'gltf' || format === 'obj') {
    // convenzione Y in alto, salvo prova evidente del contrario (modello Z-up esportato senza conversione)
    if (dz > 0.12 && size.z <= 1.15 * size.y) return { axis: 'z', reason: `${fmt} con Z in alto: la massa è distribuita in modo nettamente asimmetrico lungo Z (${detail})` };
    return { axis: 'y', reason: `${fmt}: Y in alto per convenzione (${detail})` };
  }
  // STEP/IGES/STL: spesso Z in alto. Asse verticale = quello lungo cui il modello è meno simmetrico
  // (piano in alto, basamento in basso…); a parità, quello che dà l'altezza minore (appoggio più ampio).
  if (dz > 0.06) return { axis: 'z', reason: `modello meno simmetrico lungo Z (${detail})` };
  if (dz < -0.06) return { axis: 'y', reason: `modello meno simmetrico lungo Y (${detail})` };
  if (size.y < 0.85 * size.z) return { axis: 'y', reason: `appoggio più ampio con Y in alto (${detail})` };
  if (size.z < 0.85 * size.y) return { axis: 'z', reason: `appoggio più ampio con Z in alto (${detail})` };
  return { axis: 'z', reason: `indeciso: Z in alto, come nella maggior parte dei CAD (${detail})` };
}

/** firma di forma (invariante per rotazione) per riconoscere le parti identiche */
function shapeSignature(geoms) {
  let tris = 0, verts = 0, W = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const pts = [];
  for (const g of geoms) {
    const pos = g.attributes.position, idx = g.index, n = triCount(g);
    tris += n; verts += pos.count;
    for (let i = 0; i < n; i++) {
      a.fromBufferAttribute(pos, idx ? idx.getX(3 * i) : 3 * i);
      b.fromBufferAttribute(pos, idx ? idx.getX(3 * i + 1) : 3 * i + 1);
      c.fromBufferAttribute(pos, idx ? idx.getX(3 * i + 2) : 3 * i + 2);
      const ar = e1.subVectors(b, a).cross(e2.subVectors(c, a)).length() / 2;
      W += ar;
      pts.push((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3, ar);
    }
  }
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < pts.length; i += 4) { mx += pts[i] * pts[i + 3]; my += pts[i + 1] * pts[i + 3]; mz += pts[i + 2] * pts[i + 3]; }
  if (W > 0) { mx /= W; my /= W; mz /= W; }
  const C = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < pts.length; i += 4) {
    const x = pts[i] - mx, y = pts[i + 1] - my, z = pts[i + 2] - mz, w = pts[i + 3];
    C[0] += w * x * x; C[1] += w * y * y; C[2] += w * z * z; C[3] += w * x * y; C[4] += w * x * z; C[5] += w * y * z;
  }
  // invarianti della matrice di covarianza (traccia, somma dei minori, determinante) -> autovalori
  const s = W > 0 ? 1 / W : 0;
  const [xx, yy, zz, xy, xz, yz] = C.map((v) => v * s);
  const i1 = xx + yy + zz;
  const i2 = xx * yy + yy * zz + zz * xx - xy * xy - xz * xz - yz * yz;
  const i3 = xx * (yy * zz - yz * yz) - xy * (xy * zz - yz * xz) + xz * (xy * yz - yy * xz);
  return { tris, verts, area: W, inv: [Math.sqrt(Math.max(0, i1)), Math.cbrt(Math.max(0, i2)) , Math.cbrt(Math.max(0, i3))] };
}

const close = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1e-9);

const r1 = (v) => Math.round(v * 10) / 10;
const fmtMm = (v) => String(Math.round(v * 10) / 10).replace('.', ',');

// ------------------------------------------------------------------------------------ import

async function importModel({ url, ext, fileName, upAxis = 'auto' }) {
  ext = String(ext || '').toLowerCase().replace(/^\./, '');
  progress(3, 'Lettura del file 3D…');
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('File 3D non trovato (' + resp.status + ')');
  const buf = await resp.arrayBuffer();
  if (!buf.byteLength) throw new Error('Il file 3D è vuoto.');

  let parsed;
  progress(8, 'Interpretazione del formato ' + ext.toUpperCase() + '…');
  if (ext === 'step' || ext === 'stp' || ext === 'iges' || ext === 'igs') parsed = await parseOcct(buf, ext);
  else if (ext === 'glb' || ext === 'gltf') parsed = await parseGltf(buf, url);
  else if (ext === 'obj') parsed = await parseObj(buf, url);
  else if (ext === 'stl') parsed = parseStl(buf, fileName || 'modello.stl');
  else throw new Error('Formato 3D non supportato: .' + ext + ' (ammessi STEP, STP, IGES, IGS, GLB, GLTF, OBJ, STL)');

  let rawParts = parsed.parts.filter((p) => p.meshes.length);
  if (!rawParts.length) throw new Error('Nel file 3D non ci sono superfici da mostrare.');
  let splitNote = null;
  if (rawParts.length === 1 && rawParts[0].meshes.length === 1) {
    const pieces = splitComponents(rawParts[0].meshes[0]);
    if (pieces) {
      const base = rawParts[0].name || 'Parte';
      rawParts = pieces.map((m, i) => ({ name: `${base} ${String(i + 1).padStart(2, '0')}`, meshes: [m] }));
      splitNote = `modello in un solo pezzo diviso in ${pieces.length} parti non collegate`;
    }
  }
  progress(45, `Normalizzazione: ${plural(rawParts.length, 'parte', 'parti')}…`);
  await tick();

  // unita' di misura
  const st0 = axisStats(rawParts);
  const maxDim = Math.max(st0.size.x, st0.size.y, st0.size.z);
  if (!(maxDim > 0) || !isFinite(maxDim)) throw new Error('Il modello 3D non ha dimensioni valide.');
  let scale = 1, unitNote;
  if (parsed.unitsKnown) unitNote = 'millimetri (convertiti dalle unità del file CAD)';
  else if (maxDim < 20) { scale = 1000; unitNote = `metri convertiti in millimetri (lato maggiore ${String(Math.round(maxDim * 1000) / 1000).replace('.', ',')})`; }
  else unitNote = 'millimetri (presunti: lato maggiore ' + Math.round(maxDim) + ')';

  const up = decideUpAxis(st0, ext === 'stp' ? 'step' : ext === 'igs' ? 'iges' : ext, upAxis, scale);
  const R = up.axis === 'z' ? new THREE.Matrix4().makeRotationX(-Math.PI / 2) : new THREE.Matrix4();
  const SR = new THREE.Matrix4().multiplyMatrices(R, new THREE.Matrix4().makeScale(scale, scale, scale));
  // box dopo scala e rotazione -> traslazione (centro X/Z, appoggio y = 0)
  const b2 = st0.box.clone().applyMatrix4(SR);
  const T = new THREE.Matrix4().makeTranslation(-(b2.min.x + b2.max.x) / 2, -b2.min.y, -(b2.min.z + b2.max.z) / 2);
  const N = new THREE.Matrix4().multiplyMatrices(T, SR);

  // cottura delle trasformazioni nelle geometrie
  const baked = [];
  let ti = 0;
  for (const rp of rawParts) {
    const geoms = [];
    for (const mesh of rp.meshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const M = new THREE.Matrix4().multiplyMatrices(N, mesh.matrixWorld);
      const flip = M.determinant() < 0;
      const chunks = Array.isArray(mesh.material) && mesh.geometry.groups.length > 1
        ? mesh.geometry.groups.map((gr) => ({ geom: subGeometry(mesh.geometry, gr.start, Math.min(gr.count, (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count) - gr.start)), mat: mats[gr.materialIndex] || mats[0] }))
        : [{ geom: mesh.geometry, mat: mats[0] }];
      for (const ch of chunks) {
        const src = ch.mat || new THREE.MeshStandardMaterial();
        const g = cleanGeometry(ch.geom, !!src.map, !!src.vertexColors);
        g.applyMatrix4(M);
        if (flip) {
          if (g.index) { const ix = g.index; for (let i = 0; i < ix.count; i += 3) { const t = ix.getX(i + 1); ix.setX(i + 1, ix.getX(i + 2)); ix.setX(i + 2, t); } }
          else g.setIndex([...Array(g.attributes.position.count).keys()].map((i) => (i % 3 === 1 ? i + 1 : i % 3 === 2 ? i - 1 : i)));
        }
        if (!g.attributes.normal) g.computeVertexNormals();
        geoms.push({ geom: g, mat: src });
      }
    }
    const box = new THREE.Box3();
    for (const { geom } of geoms) { geom.computeBoundingBox(); box.union(geom.boundingBox); }
    if (box.isEmpty()) continue;
    const center = box.getCenter(new THREE.Vector3());
    for (const { geom } of geoms) geom.translate(-center.x, -center.y, -center.z);
    baked.push({ name: rp.name, geoms, box, center });
    if (++ti % 25 === 0) { progress(45 + 25 * ti / rawParts.length, `Normalizzazione: parte ${ti} di ${rawParts.length}…`); await tick(); }
  }
  if (!baked.length) throw new Error('Nessuna parte valida nel modello 3D.');

  // chiavi, nomi, gruppi di parti identiche
  progress(72, 'Riconoscimento delle parti uguali…');
  await tick();
  const width = Math.max(2, String(baked.length).length);
  const reps = [];
  baked.forEach((b, i) => {
    b.key = 'p' + String(i + 1).padStart(width, '0');
    b.triangles = b.geoms.reduce((n, x) => n + triCount(x.geom), 0);
    b.sig = shapeSignature(b.geoms.map((x) => x.geom));
    const rep = reps.find((r) => r.sig.tris === b.sig.tris && r.sig.verts === b.sig.verts && close(r.sig.area, b.sig.area, 0.01)
      && r.sig.inv.every((v, k) => close(v, b.sig.inv[k], 0.02)));
    if (rep) b.group = rep.key; else { b.group = b.key; reps.push(b); }
    const nm = (b.name || '').replace(/\s+/g, ' ').trim();
    b.cleanName = !nm || /^mesh_\d+$/i.test(nm) ? '' : nm;
  });
  // parti senza nome: "Parte NN" (le parti uguali condividono il nome del gruppo)
  for (const b of baked) if (!b.cleanName) {
    const rep = baked.find((x) => x.key === b.group);
    b.cleanName = rep && rep.cleanName ? rep.cleanName : 'Parte ' + b.key.slice(1);
  }

  // scena da esportare: un gruppo per parte (nome = key, extras = nome e gruppo), centrato sulla parte
  progress(78, 'Scrittura del modello normalizzato (GLB)…');
  await tick();
  const exportRoot = new THREE.Group();
  exportRoot.name = 'modello';
  const toStd = (src) => {
    if (src && src.isMeshBasicMaterial) {
      const m = new THREE.MeshBasicMaterial({ color: src.color.clone(), map: src.map || null, vertexColors: !!src.vertexColors });
      m.side = THREE.DoubleSide;
      return m;
    }
    const m = new THREE.MeshStandardMaterial({
      color: src && src.color ? src.color.clone() : new THREE.Color(0xcccccc),
      map: src && src.map ? src.map : null,
      roughness: src && src.roughness !== undefined ? src.roughness : src && src.shininess !== undefined ? Math.max(0.15, 1 - Math.sqrt(src.shininess / 100)) : 0.6,
      metalness: src && src.metalness !== undefined ? src.metalness : 0,
      vertexColors: !!(src && src.vertexColors),
      transparent: false,
    });
    m.side = THREE.DoubleSide;
    m.name = (src && src.name) || '';
    return m;
  };
  const matCache = new Map();
  for (const b of baked) {
    const g = new THREE.Group();
    g.name = b.key;
    g.userData = { key: b.key, name: b.cleanName, similar_group: b.group };
    g.position.copy(b.center);
    for (const { geom, mat } of b.geoms) {
      let m = matCache.get(mat);
      if (!m) { m = toStd(mat); matCache.set(mat, m); }
      g.add(new THREE.Mesh(geom, m));
    }
    exportRoot.add(g);
  }
  const glb = await new GLTFExporter().parseAsync(exportRoot, { binary: true, onlyVisible: false, maxTextureSize: 2048 });
  progress(90, 'Salvataggio del modello…');
  const up1 = await fetch('/__upload/model.glb', { method: 'PUT', body: new Blob([glb]) });
  if (!up1.ok) throw new Error('Salvataggio di model.glb non riuscito (' + up1.status + ')');

  const total = new THREE.Box3();
  for (const b of baked) total.union(b.box);
  const size = total.getSize(new THREE.Vector3());
  const parts = baked.map((b) => {
    const s = b.box.getSize(new THREE.Vector3());
    return {
      key: b.key, name: b.cleanName,
      bbox_min: b.box.min.toArray().map(r1), bbox_max: b.box.max.toArray().map(r1),
      size: s.toArray().map(r1), center: b.center.toArray().map(r1),
      triangles: b.triangles, similar_group: b.group,
    };
  });
  const groups = new Set(parts.map((p) => p.similar_group));
  const meta = {
    version: 1,
    source_file: fileName || null,
    format: ext,
    unit_scale: scale,
    units: unitNote,
    up_axis_in_source: up.axis,
    up_axis_reason: up.reason,
    normalization: 'mm, Y in alto, centrato in X/Z, appoggiato a y = 0',
    size_mm: size.toArray().map(r1),
    size_text: `${fmtMm(size.x)} × ${fmtMm(size.z)} × ${fmtMm(size.y)} mm (larghezza × profondità × altezza)`,
    part_count: parts.length,
    group_count: groups.size,
    triangles: parts.reduce((n, p) => n + p.triangles, 0),
    split: splitNote,
  };
  progress(100, `Modello importato: ${plural(parts.length, 'parte', 'parti')}`);
  return { parts, meta };
}

// ------------------------------------------------------------------------------------ viste

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

async function renderViews({ glbUrl, parts: summary, max = 24, width = 640, height = 480, theme: themeIn, dir = 'viste_parti' }) {
  const theme = resolveTheme(themeIn);
  await Promise.all(['700 30px "Barlow Semi Condensed"', '500 30px "Barlow"', '600 30px "Barlow"'].map((f) => document.fonts.load(f, 'Aa×0')));
  const W = width, H = height;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const renderer = makeRenderer(canvas, W, H);
  const model = await loadPartsModel(glbUrl, summary);
  const sizeAll = model.box.getSize(new THREE.Vector3());
  const D = sizeAll.length() || 1;
  for (const p of model.parts) p.info = analyzePart(p);
  const roles = new Map(model.parts.map((p) => [p.key, (Math.max(p.size.x, p.size.y, p.size.z) < 0.12 * D && (p.info.shape === 'rod' || p.info.shape === 'disc')) ? 'hardware' : 'component']));
  const scene = new THREE.Scene();
  setupStudio(renderer, scene, { radius: D / 2, mapSize: 1024 });
  styleParts(model.parts, { roles, theme, ink: theme.ink });
  const rig = new Rig(scene, model, { theme, ink: theme.ink });
  rig.setFrame(new THREE.Matrix4());
  const cam = new THREE.PerspectiveCamera(30, W / H, 1, 1e7);
  const az = sizeAll.z > sizeAll.x * 1.15 ? 55 : 35, el = 26;
  const corners = (box) => { const c = []; for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) c.push(new THREE.Vector3(x, y, z)); return c; };
  const view = frameCamera(corners(model.box), { az, el, aspect: W / H, hx: 0.88, yLo: -0.86, yHi: 0.62 });
  const mainPose = { target: view.target.toArray(), dist: view.dist, az, el, sy: view.sy };

  const out2d = document.createElement('canvas');
  out2d.width = W; out2d.height = H;
  const g2 = out2d.getContext('2d');
  const setStyles = (focus) => {
    for (const p of model.parts) {
      const f = !focus || focus.has(p.key);
      rig.setPart(p, { p: [0, 0, 0], s: 0, o: 1, h: focus && f ? 1 : 0, g: focus && !f ? 1 : 0 });
    }
  };
  const drawGL = (pose, x, y, w, h) => {
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    poseOrbit(cam, w, h, pose);
    renderer.render(scene, cam);
    g2.drawImage(canvas, 0, 0, w, h, x, y, w, h);
    renderer.setSize(W, H, false);
  };
  const project = (v, pose, w, h) => {
    cam.aspect = w / h; poseOrbit(cam, w, h, pose);
    const p = v.clone().project(cam);
    return { x: (p.x + 1) / 2 * w, y: (1 - p.y) / 2 * h };
  };
  const label = (title, sub) => {
    g2.font = '700 26px "Barlow Semi Condensed"';
    const tw = g2.measureText(title).width;
    g2.font = '500 17px "Barlow"';
    const sw = sub ? g2.measureText(sub).width : 0;
    const w = Math.min(W - 24, Math.max(tw, sw) + 34);
    g2.fillStyle = 'rgba(255,255,255,0.92)';
    roundRect(g2, 12, 12, w, sub ? 66 : 44, 4); g2.fill();
    g2.fillStyle = theme.accent; g2.fillRect(12, 12, 6, sub ? 66 : 44);
    g2.fillStyle = theme.ink; g2.font = '700 26px "Barlow Semi Condensed"';
    g2.fillText(title, 28, 43, W - 50);
    if (sub) { g2.font = '500 17px "Barlow"'; g2.fillStyle = theme.muted; g2.fillText(sub, 28, 66, W - 50); }
  };
  const save = async (name) => {
    const blob = await new Promise((r) => out2d.toBlob(r, 'image/png'));
    const res = await fetch('/__upload/' + dir + '/' + name, { method: 'PUT', body: blob });
    if (!res.ok) throw new Error('Salvataggio della vista non riuscito (' + res.status + ')');
    return dir + '/' + name;
  };
  const bg = () => {
    const grad = g2.createRadialGradient(W * 0.52, H * 0.4, 10, W * 0.52, H * 0.4, W * 0.75);
    grad.addColorStop(0, '#FFFFFF'); grad.addColorStop(1, theme.beigeSoft);
    g2.fillStyle = grad; g2.fillRect(0, 0, W, H);
  };

  // gruppi di parti identiche, scelti per dimensione (e minuteria ripetuta)
  const groups = new Map();
  for (const p of model.parts) {
    const k = p.group || p.key;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const list = [...groups.entries()].map(([gk, ps]) => {
    const box = new THREE.Box3(); for (const p of ps) box.union(p.box);
    return { gk, parts: ps, count: ps.length, size: Math.max(ps[0].size.x, ps[0].size.y, ps[0].size.z), box, first: ps[0] };
  });
  const slots = Math.max(0, max - 1);
  let chosen;
  if (list.length <= slots) chosen = list;
  else {
    const multi = list.filter((g) => g.count > 1).sort((a, b) => b.count - a.count || b.size - a.size).slice(0, Math.ceil(slots / 3));
    const rest = list.filter((g) => !multi.includes(g)).sort((a, b) => b.size - a.size).slice(0, slots - multi.length);
    chosen = [...multi, ...rest];
  }
  chosen.sort((a, b) => model.parts.indexOf(a.first) - model.parts.indexOf(b.first));

  const results = [];
  // vista d'insieme
  bg(); setStyles(null); drawGL(mainPose, 0, 0, W, H);
  label('Vista d’insieme', `${plural(model.parts.length, 'parte', 'parti')}${model.parts.length > 1 ? `, ${groups.size} ${groups.size === 1 ? 'uguali' : 'diverse'}` : ''} · ${fmtMm(sizeAll.x)} × ${fmtMm(sizeAll.z)} × ${fmtMm(sizeAll.y)} mm`);
  results.push({ key: 'overview', label: `Vista d’insieme (${plural(model.parts.length, 'parte', 'parti')})`, file: await save('00_insieme.png'), keys: model.parts.map((p) => p.key) });

  let n = 0;
  for (const gr of chosen) {
    n++;
    progress(5 + 90 * n / chosen.length, `Vista ${n} di ${chosen.length}…`);
    const focus = new Set(gr.parts.map((p) => p.key));
    bg(); setStyles(focus); drawGL(mainPose, 0, 0, W, H);
    // dimensione proiettata: se piccola, cerchi arancio + riquadro di dettaglio
    const pc = corners(gr.box).map((v) => project(v, mainPose, W, H));
    const pw = Math.max(...pc.map((p) => p.x)) - Math.min(...pc.map((p) => p.x));
    const ph = Math.max(...pc.map((p) => p.y)) - Math.min(...pc.map((p) => p.y));
    const one = corners(gr.first.box).map((v) => project(v, mainPose, W, H));
    const onePx = Math.max(Math.max(...one.map((p) => p.x)) - Math.min(...one.map((p) => p.x)), Math.max(...one.map((p) => p.y)) - Math.min(...one.map((p) => p.y)));
    if (onePx < 26) {
      g2.strokeStyle = theme.accent; g2.lineWidth = 2.5;
      for (const p of gr.parts) {
        const c = project(p.center, mainPose, W, H);
        g2.beginPath(); g2.arc(c.x, c.y, 13, 0, Math.PI * 2); g2.stroke();
      }
    }
    if (onePx < 70 || Math.max(pw, ph) < 60) {
      // dettaglio: primo elemento del gruppo, inquadrato da vicino
      const iw = Math.round(W * 0.42), ih = Math.round(H * 0.42);
      const ix = W - iw - 12, iy = H - ih - 12;
      const s = gr.first.size;
      const ctx = gr.first.box.clone().expandByScalar(Math.max(s.x, s.y, s.z) * 0.9 + D * 0.01);
      const v2 = frameCamera(corners(ctx), { az, el: 32, aspect: iw / ih, hx: 0.9, yLo: -0.9, yHi: 0.9 });
      g2.fillStyle = '#FFFFFF'; g2.fillRect(ix - 3, iy - 3, iw + 6, ih + 6);
      const grad = g2.createLinearGradient(0, iy, 0, iy + ih); grad.addColorStop(0, '#FFFFFF'); grad.addColorStop(1, theme.beigeSoft);
      g2.fillStyle = grad; g2.fillRect(ix, iy, iw, ih);
      drawGL({ target: v2.target.toArray(), dist: v2.dist, az, el: 32, sy: 0 }, ix, iy, iw, ih);
      g2.strokeStyle = theme.ink; g2.lineWidth = 1.5; g2.strokeRect(ix - 0.5, iy - 0.5, iw + 1, ih + 1);
      g2.fillStyle = theme.ink; g2.fillRect(ix, iy, 74, 22);
      g2.fillStyle = '#FFFFFF'; g2.font = '600 14px "Barlow"'; g2.fillText('dettaglio', ix + 8, iy + 16);
    }
    const s = gr.first.size;
    const qty = gr.count > 1 ? ` ×${gr.count}` : '';
    const nm = gr.first.name || gr.first.key;
    label(`${gr.first.key}${qty}  ‘${nm}’`, `${fmtMm(s.x)} × ${fmtMm(s.z)} × ${fmtMm(s.y)} mm` + (gr.count > 1 ? ' · parti: ' + gr.parts.map((p) => p.key).slice(0, 8).join(', ') + (gr.count > 8 ? '…' : '') : ''));
    results.push({ key: gr.first.key, label: `${gr.first.key}${qty} ‘${nm}’`, file: await save(gr.first.key + '.png'), keys: gr.parts.map((p) => p.key) });
  }
  renderer.dispose();
  return results;
}

window.importModel = async (opts) => {
  try { return await importModel(opts); } catch (e) { throw new Error(e && e.message ? e.message : String(e)); }
};
window.renderViews = async (opts) => {
  try { return await renderViews(opts); } catch (e) { throw new Error(e && e.message ? e.message : String(e)); }
};
window.ready = Promise.resolve(true);
