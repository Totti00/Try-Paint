// cad-loader.js — adattatore per il modello CAD reale (GLB con nodi nominati).
//
// Convenzioni attese (vedi README, sezione "Sostituire il modello"):
//  * glTF e' Y-in-alto; il tavolo assemblato con la lunghezza lungo X
//    (altrimenti usare ?cadRotY=90). Unita' metri o millimetri (rilevate da sole).
//  * Nodi con i nomi: F1_L F1_R T1_A T1_B T2 P1 [M8_01..10 W_01..10 WS_1..6].
//    I nodi mancanti vengono presi dal modello parametrico (parts.js).
//  * Minuteria: l'asse +Y locale del nodo punta DENTRO il materiale
//    (direzione di avvitamento), oppure si passa una tabella `axes`.
//  * Il modello viene normalizzato: centro in X/Z = 0, appoggio a terra Y = 0.

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const PART_NAMES = [
  'F1_L', 'F1_R', 'T1_A', 'T1_B', 'T2', 'P1',
  ...Array.from({ length: 10 }, (_, i) => 'M8_' + String(i + 1).padStart(2, '0')),
  ...Array.from({ length: 10 }, (_, i) => 'W_' + String(i + 1).padStart(2, '0')),
  ...Array.from({ length: 6 }, (_, i) => 'WS_' + (i + 1)),
];

const MATERIAL_FOR = (name) =>
  name === 'P1' ? 'wood' : name.startsWith('W_') ? 'nylon' : /^(M8_|WS_)/.test(name) ? 'steel' : 'alu';

export async function loadCadModel(THREE, url, { axes = {}, brandMaterials = null, rotY = 0 } = {}) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  if (rotY) root.rotation.y = rotY * Math.PI / 180;
  root.updateMatrixWorld(true);

  // unita' e normalizzazione dell'origine
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const unit = Math.max(size.x, size.y, size.z) < 20 ? 1000 : 1;   // metri -> mm
  const center = box.getCenter(new THREE.Vector3());
  const norm = new THREE.Matrix4()
    .makeScale(unit, unit, unit)
    .premultiply(new THREE.Matrix4().makeTranslation(-center.x * unit, -box.min.y * unit, -center.z * unit));

  const parts = {};
  for (const name of PART_NAMES) {
    const node = root.getObjectByName(name);
    if (!node) continue;
    const world = node.matrixWorld.clone().premultiply(norm);
    const holder = new THREE.Group();
    holder.name = name;
    node.parent.remove(node);
    node.matrixAutoUpdate = true;
    world.decompose(node.position, node.quaternion, node.scale);
    holder.add(node);
    node.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      if (brandMaterials) o.material = brandMaterials[MATERIAL_FOR(name)];
    });
    if (/^(M8_|W_|WS_)/.test(name)) {
      const q = new THREE.Quaternion();
      world.decompose(new THREE.Vector3(), q, new THREE.Vector3());
      const a = axes[name] || new THREE.Vector3(0, 1, 0).applyQuaternion(q).toArray().map((v) => Math.round(v * 1e4) / 1e4);
      holder.userData.axis = a;
    }
    parts[name] = holder;
  }
  const missing = PART_NAMES.filter((n) => !parts[n]);
  if (missing.length) console.warn('[cad-loader] nodi non trovati, uso il modello parametrico:', missing.join(', '));
  return { parts, missing };
}
