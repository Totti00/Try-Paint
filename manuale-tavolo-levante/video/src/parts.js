// =============================================================================
//  parts.js — MODELLO PARAMETRICO APPROSSIMATO del Tavolo Levante
// -----------------------------------------------------------------------------
//  Questo modulo e' il "punto di sostituzione" (swap seam): restituisce degli
//  Object3D con NOMI FISSI, gia' posizionati nella loro posizione di MONTAGGIO
//  FINALE (coordinate del tavolo assemblato, millimetri):
//
//      X = lunghezza (1800), Y = alto (pavimento = 0), Z = larghezza (+Z = fronte)
//
//  Nomi richiesti dalla timeline:
//      F1_L, F1_R            fianchi (sinistro x<0, destro x>0)
//      T1_A, T1_B            traversi superiori (A = fronte z>0, B = retro z<0)
//      T2                    traverso inferiore
//      P1                    piano a doghe (doghe + listelli sottostanti)
//      M8_01 … M8_10         viti M8x20 con flangia      (userData.axis)
//      W_01  … W_10          rondelle in nylon 17x2x8.1  (userData.axis)
//      WS_1  … WS_6          viti da legno 4x20          (userData.axis)
//
//  Ogni vite/rondella ha userData.axis = versore che punta DENTRO il materiale
//  (direzione di avvitamento). La timeline anima solo SPOSTAMENTI RELATIVI alla
//  posizione finale, quindi il modello CAD reale (GLB con gli stessi nomi, vedi
//  cad-loader.js e README) puo' sostituire questo file senza toccare la timeline.
// =============================================================================

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---- quote principali (mm) --------------------------------------------------
export const DIMS = {
  L: 1800, W: 800, H: 750,
  frame: { depth: 100, tube: 50 },            // tubo fianco: 100 lungo X, 50 nel piano del fianco
  // faccia interna a z = ±352; bordo alto 3 mm sotto le doghe (725); fori M8 nella fascia
  // sotto lo spigolo del fianco (come img-010), 32 mm sotto il traverso alto del fianco (700)
  t1: { len: 1780, h: 80, t: 22, yTop: 722, zIn: 352, yHoles: 668 },
  t2: { len: 1694, h: 20, w: 40, y: 25 },
  top: { len: 1598, slats: 7, gap: 8, t: 25 },
  batten: { w: 60, h: 27, len: 690, x: [-755, 0, 755] },
  bracket: { w: 36, leg: 40, t: 3, yLeg: 698 },  // yLeg = faccia superiore della gamba orizzontale = fondo dei listelli
  slot: { w: 26, h: 88 },                     // asola verticale del montante (T1: 22 x 80)
  holesT1: [28, 68],                          // profondita' fori viti T1 dentro il montante (da x=±800)
  holeT2: 35,                                 // UNICO foro di serraggio di T2 sul traverso basso del fianco (dalla faccia interna)
};

const XF = DIMS.L / 2 - DIMS.frame.depth;     // 800: faccia interna dei fianchi
const T1Y = DIMS.t1.yTop - DIMS.t1.h / 2;     // 682: asse di T1 (centro dell'asola)
const HY = DIMS.t1.yHoles;                    // 668: asse dei fori M8 di T1
const T1Z = DIMS.t1.zIn + DIMS.t1.t / 2;      // 363: asse di T1 (e dell'asola) in Z

// Punti notevoli usati da timeline/camera (in coordinate del tavolo assemblato).
//  (la timeline li usa come target delle inquadrature ravvicinate e delle etichette)
export const JOINTS = {
  slotT1_L_front: [-XF, T1Y, T1Z],            // asola del montante anteriore di F1_L
  holesT1_L_front: [-XF - 48, HY, DIMS.W / 2 - DIMS.frame.tube],    // centro delle 2 viti M8 01-02
  holeT2_L: [-XF - DIMS.holeT2, DIMS.frame.tube, 0],              // foro di serraggio di T2 su F1_L (vite M8_09)
  t2Top_L: [-XF, DIMS.t2.y + DIMS.t2.h / 2, 0],                  // dorso di T2 dove esce dall'asola di F1_L (freccia del passo 4)
  bracket_L_back: [-755, DIMS.bracket.yLeg, -330],                 // angolare + vite WS_1 (fronte a tavolo capovolto)
};

// ---- PRNG deterministico ----------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- materiali di base (il rig li clona per parte) --------------------------
export function makeMaterials(THREE) {
  const wood = new THREE.MeshStandardMaterial({ color: 0xc2c2c2, roughness: 0.82, metalness: 0 });   // tarato per rendere ~#AC9C84
  wood.map = makeWoodTexture(THREE);
  return {
    alu: new THREE.MeshStandardMaterial({ color: 0xf3f1ed, roughness: 0.55, metalness: 0.0 }),
    hole: new THREE.MeshBasicMaterial({ color: 0x4a4440, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    // asola: grigio caldo piu' chiaro dei fori, cosi' a traverso inserito resta solo un filo sottile
    slot: new THREE.MeshBasicMaterial({ color: 0x6e6660, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    wood,
    bracket: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.42, metalness: 0.55 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xd2d5d8, roughness: 0.26, metalness: 0.9 }),
    socket: new THREE.MeshBasicMaterial({ color: 0x3a3a3a }),
    nylon: new THREE.MeshStandardMaterial({ color: 0xf4f3ef, roughness: 0.62, metalness: 0 }),
  };
}

function makeWoodTexture(THREE) {
  const rnd = mulberry32(7);
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#AC9C84';
  g.fillRect(0, 0, c.width, c.height);
  // venature lungo U (= lunghezza della doga)
  for (let i = 0; i < 70; i++) {
    const y0 = rnd() * c.height;
    const amp = 2 + rnd() * 6, f = 0.004 + rnd() * 0.01, ph = rnd() * 6.28;
    g.strokeStyle = rnd() < 0.5 ? 'rgba(115,98,77,0.20)' : 'rgba(196,182,160,0.22)';
    g.lineWidth = 0.6 + rnd() * 1.8;
    g.beginPath();
    for (let x = 0; x <= c.width; x += 16) {
      const y = y0 + Math.sin(x * f + ph) * amp;
      x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// ---- helper geometrici ------------------------------------------------------
function roundedRectShape(THREE, w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** geometria piatta (rivolta a +Z) orientata secondo `normal` e centrata in `center` */
function placeFlat(THREE, geom, normal, center, lift = 0.35) {
  const n = new THREE.Vector3(...normal).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  geom.applyQuaternion(q);
  geom.translate(center[0] + n.x * lift, center[1] + n.y * lift, center[2] + n.z * lift);
  return geom;
}

const ni = (g) => (g.index ? g.toNonIndexed() : g);

function mesh(THREE, geom, mat, opts = {}) {
  const m = new THREE.Mesh(geom, mat);
  m.castShadow = opts.cast !== false;
  m.receiveShadow = opts.receive !== false;
  if (opts.role) m.userData.role = opts.role;
  if (opts.noEdges) m.userData.noEdges = true;
  return m;
}

function boxAt(THREE, sx, sy, sz, cx, cy, cz) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate(cx, cy, cz);
  return g;
}

// ---- parti ------------------------------------------------------------------
function buildFrame(THREE, M, side) {
  // side = -1 (sinistro) | +1 (destro)
  const { W, H } = DIMS, d = DIMS.frame.depth, tb = DIMS.frame.tube;
  const grp = new THREE.Group();
  grp.name = side < 0 ? 'F1_L' : 'F1_R';

  // anello chiuso: rettangolo esterno con foro, estruso lungo X
  const shape = new THREE.Shape();
  shape.moveTo(-W / 2, 0); shape.lineTo(W / 2, 0); shape.lineTo(W / 2, H); shape.lineTo(-W / 2, H); shape.lineTo(-W / 2, 0);
  const hole = new THREE.Path();
  hole.moveTo(-W / 2 + tb, tb); hole.lineTo(-W / 2 + tb, H - tb); hole.lineTo(W / 2 - tb, H - tb); hole.lineTo(W / 2 - tb, tb); hole.lineTo(-W / 2 + tb, tb);
  shape.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  g.rotateY(Math.PI / 2);                     // estrusione lungo +X, forma nel piano Z-Y
  g.translate(side > 0 ? XF : -XF - d, 0, 0);
  grp.add(mesh(THREE, g, M.alu));

  // linee di giunzione a 45° (taglio a quartabuono) sulle due facce del fianco
  const pts = [];
  for (const xf of [XF - 0.25, XF + d + 0.25]) {
    const x = side * xf;
    for (const sz of [-1, 1]) {
      pts.push(x, H, sz * W / 2, x, H - tb, sz * (W / 2 - tb));
      pts.push(x, 0, sz * W / 2, x, tb, sz * (W / 2 - tb));
    }
  }
  const mg = new THREE.BufferGeometry();
  mg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const miter = new THREE.LineSegments(mg, new THREE.LineBasicMaterial({ color: 0x1f1c1a, transparent: true, opacity: 0.22 }));
  miter.userData.isEdge = true;
  grp.add(miter);

  // asole e fori (decal scuri)
  const decals = [], slots = [];
  const faceN = [-side, 0, 0];                 // faccia rivolta verso l'altro fianco
  const xFace = side * XF;
  for (const sz of [-1, 1]) {
    // asola verticale per T1 sul montante
    const sg = new THREE.ShapeGeometry(roundedRectShape(THREE, DIMS.slot.w, DIMS.slot.h, 5), 4);
    slots.push(placeFlat(THREE, sg, faceN, [xFace, T1Y, sz * T1Z]));
    // 2 fori sulla faccia interna del montante (verso l'asse del tavolo)
    for (const hd of DIMS.holesT1) {
      const cg = new THREE.CircleGeometry(4.6, 20);
      decals.push(placeFlat(THREE, cg, [0, 0, -sz], [side * (XF + hd), HY, sz * (W / 2 - tb)]));
    }
  }
  // asola orizzontale per T2 al centro del traverso basso
  slots.push(placeFlat(THREE, new THREE.ShapeGeometry(roundedRectShape(THREE, 44, 24, 5), 4), faceN, [xFace, 25, 0]));
  // UN solo foro di serraggio per T2 sulla faccia superiore del traverso basso
  decals.push(placeFlat(THREE, new THREE.CircleGeometry(4.6, 20), [0, 1, 0], [side * (XF + DIMS.holeT2), tb, 0]));
  grp.add(mesh(THREE, mergeGeometries(decals), M.hole, { cast: false, noEdges: true }));
  grp.add(mesh(THREE, mergeGeometries(slots), M.slot, { cast: false, noEdges: true }));
  return grp;
}

function buildBracket(THREE, M, x, sz) {
  // angolare a L rivettato sulla faccia interna di T1; sz = lato (+1 fronte, -1 retro)
  const { w, leg, t } = DIMS.bracket;
  const zIn = DIMS.t1.zIn, yTop = DIMS.bracket.yLeg;   // gamba orizzontale sotto il listello, ~24 mm sotto il bordo di T1
  const parts = [];
  // gamba verticale (piano XY), con asola orizzontale
  const vs = new THREE.Shape();
  vs.moveTo(-w / 2, 0); vs.lineTo(w / 2, 0); vs.lineTo(w / 2, leg - t); vs.lineTo(-w / 2, leg - t); vs.lineTo(-w / 2, 0);
  const vhole = new THREE.Path(roundedRectShape(THREE, 14, 6, 2.9).getPoints(6).map(p => new THREE.Vector2(p.x, p.y + 14)));
  vs.holes.push(vhole);
  const vg = new THREE.ExtrudeGeometry(vs, { depth: t, bevelEnabled: false, curveSegments: 6 });
  vg.translate(x, yTop - leg, sz > 0 ? zIn - t : -zIn);
  parts.push(vg);
  // gamba orizzontale (piano XZ) verso l'interno, con asola lungo Z per la vite da legno
  // (costruita senza specchiature per non invertire le normali)
  const y0 = sz > 0 ? -leg : 0, y1 = sz > 0 ? 0 : leg, yc = sz > 0 ? -20 : 20;
  const hs = new THREE.Shape();
  hs.moveTo(-w / 2, y0); hs.lineTo(w / 2, y0); hs.lineTo(w / 2, y1); hs.lineTo(-w / 2, y1); hs.lineTo(-w / 2, y0);
  hs.holes.push(new THREE.Path(roundedRectShape(THREE, 6, 18, 2.9).getPoints(6).map(p => new THREE.Vector2(p.x, p.y + yc))));
  const hg = new THREE.ExtrudeGeometry(hs, { depth: t, bevelEnabled: false, curveSegments: 6 });
  hg.rotateX(Math.PI / 2);                    // shape y -> +z, estrusione -> -y (spessore verso il basso)
  hg.translate(x, yTop, sz > 0 ? zIn : -zIn);
  parts.push(hg);
  const merged = mergeGeometries(parts.map(ni));
  return mesh(THREE, merged, M.bracket, { role: 'bracket' });
}

function buildT1(THREE, M, sz) {
  const { len, h, t, yTop, zIn } = DIMS.t1;
  const grp = new THREE.Group();
  grp.name = sz > 0 ? 'T1_A' : 'T1_B';
  grp.add(mesh(THREE, boxAt(THREE, len, h, t, 0, yTop - h / 2, sz * (zIn + t / 2)), M.alu));
  for (const x of DIMS.batten.x) grp.add(buildBracket(THREE, M, x, sz));
  // fori sulle estremita' (faccia interna)
  const decals = [];
  for (const sx of [-1, 1]) for (const hd of DIMS.holesT1) {
    decals.push(placeFlat(THREE, new THREE.CircleGeometry(4.6, 20), [0, 0, -sz], [sx * (XF + hd), HY, sz * zIn], 0.3));
  }
  grp.add(mesh(THREE, mergeGeometries(decals), M.hole, { cast: false, noEdges: true }));
  return grp;
}

function buildT2(THREE, M) {
  const { len, h, w, y } = DIMS.t2;
  const grp = new THREE.Group();
  grp.name = 'T2';
  grp.add(mesh(THREE, boxAt(THREE, len, h, w, 0, y, 0), M.alu));
  const decals = [];
  for (const sx of [-1, 1]) decals.push(placeFlat(THREE, new THREE.CircleGeometry(4.6, 20), [0, 1, 0], [sx * (XF + DIMS.holeT2), y + h / 2, 0], 0.3));
  grp.add(mesh(THREE, mergeGeometries(decals), M.hole, { cast: false, noEdges: true }));
  return grp;
}

function buildTop(THREE, M) {
  const { len, slats, gap, t } = DIMS.top;
  const { W, H } = DIMS;
  const grp = new THREE.Group();
  grp.name = 'P1';
  const sw = (W - (slats - 1) * gap) / slats;
  const rnd = mulberry32(11);
  for (let i = 0; i < slats; i++) {
    const z = -W / 2 + sw / 2 + i * (sw + gap);
    const g = boxAt(THREE, len, t, sw, 0, H - t / 2, z);
    // variazione della venatura per doga
    const uv = g.attributes.uv, dv = rnd(), du = rnd();
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 1.6 + du, uv.getY(k) * 0.42 + dv);
    grp.add(mesh(THREE, g, M.wood));
  }
  const b = DIMS.batten;
  for (const x of b.x) {
    const g = boxAt(THREE, b.w, b.h, b.len, x, H - t - b.h / 2, 0);
    const uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 0.5 + 0.3, uv.getY(k) * 0.3 + rnd());
    grp.add(mesh(THREE, g, M.wood));
  }
  return grp;
}

// --- minuteria: costruita lungo +Y locale (asse = dentro il materiale), contatto in y = 0
function orient(THREE, obj, axis, pos) {
  obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...axis));
  obj.position.set(...pos);
  obj.userData.axis = axis.slice();
  obj.updateMatrix();
  return obj;
}

function buildM8(THREE, M, name, axis, pos) {
  const grp = new THREE.Group();
  grp.name = name;
  const shank = new THREE.CylinderGeometry(4, 4, 20, 16, 1, true).translate(0, 8, 0);
  const flange = new THREE.CylinderGeometry(8, 8, 1, 28).translate(0, -2.5, 0);
  const R = 8.9, hgt = 3.4;
  const dome = new THREE.SphereGeometry(R, 28, 6, 0, Math.PI * 2, 0, Math.acos((R - hgt) / R));
  dome.rotateX(Math.PI);                      // calotta verso -Y (fuori dal materiale)
  grp.add(mesh(THREE, mergeGeometries([ni(shank), ni(flange), ni(fixDome(dome, -3))]), M.steel));
  const sock = new THREE.CylinderGeometry(2.7, 2.7, 0.6, 6).translate(0, -6.35, 0);
  grp.add(mesh(THREE, sock, M.socket, { cast: false, noEdges: true }));
  return orient(THREE, grp, axis, pos);
}

function fixDome(geo, baseY) {
  // porta la base della calotta (y massimo dopo la rotazione) esattamente a baseY
  geo.computeBoundingBox();
  geo.translate(0, baseY - geo.boundingBox.max.y, 0);
  return geo;
}

function buildWasher(THREE, M, name, axis, pos) {
  const prof = [[4.05, -2], [8.5, -2], [8.5, 0], [4.05, 0], [4.05, -2]].map(p => new THREE.Vector2(p[0], p[1]));
  const g = new THREE.LatheGeometry(prof, 32);
  const m = mesh(THREE, g, M.nylon);
  const grp = new THREE.Group();
  grp.name = name;
  grp.add(m);
  return orient(THREE, grp, axis, pos);
}

function buildWoodScrew(THREE, M, name, axis, pos) {
  const grp = new THREE.Group();
  grp.name = name;
  const head = new THREE.CylinderGeometry(2.2, 4, 2.2, 24).translate(0, -1.1, 0);
  const shank = new THREE.CylinderGeometry(2, 2, 16, 12, 1, true).translate(0, 8, 0);
  const tip = new THREE.CylinderGeometry(0.2, 2, 4, 12).rotateX(Math.PI).translate(0, 18, 0);
  // filetto stilizzato: piccoli anelli
  const rings = [];
  for (let k = 0; k < 6; k++) rings.push(ni(new THREE.TorusGeometry(2.05, 0.45, 4, 14).rotateX(Math.PI / 2).translate(0, 3 + k * 2.4, 0)));
  grp.add(mesh(THREE, mergeGeometries([ni(head), ni(shank), ni(tip), ...rings]), M.steel));
  const cross = mergeGeometries([new THREE.BoxGeometry(4.6, 0.5, 1.0), new THREE.BoxGeometry(1.0, 0.5, 4.6)]).translate(0, -2.3, 0);
  grp.add(mesh(THREE, cross, M.socket, { cast: false, noEdges: true }));
  return orient(THREE, grp, axis, pos);
}

/** Posizioni finali della minuteria (coordinate del tavolo assemblato). */
export function fastenerLayout() {
  const W = DIMS.W, tb = DIMS.frame.tube;
  const m8 = [];
  // ordine: L-fronte, L-retro, R-fronte, R-retro (2 viti ciascuno), poi T2 L, T2 R
  for (const sx of [-1, 1]) for (const sz of [1, -1]) for (const hd of DIMS.holesT1) {
    m8.push({ axis: [0, 0, sz], pos: [sx * (XF + hd), HY, sz * (W / 2 - tb)] });
  }
  for (const sx of [-1, 1]) m8.push({ axis: [0, -1, 0], pos: [sx * (XF + DIMS.holeT2), tb, 0] });
  // viti da legno: nell'asola della gamba orizzontale degli angolari, dal basso verso il listello
  const ws = [];
  const yLeg = DIMS.bracket.yLeg - DIMS.bracket.t;
  for (const sz of [-1, 1]) for (const x of [-755, 0, 755]) ws.push({ axis: [0, 1, 0], pos: [x, yLeg, sz * 330] });
  return { m8, ws };
}

/**
 * Costruisce il modello parametrico.
 * @returns {{ parts: Record<string, THREE.Object3D>, materials: object }}
 */
export function buildParametricModel(THREE) {
  const M = makeMaterials(THREE);
  const parts = {};
  const add = (o) => { parts[o.name] = o; };
  add(buildFrame(THREE, M, -1));
  add(buildFrame(THREE, M, +1));
  add(buildT1(THREE, M, +1));
  add(buildT1(THREE, M, -1));
  add(buildT2(THREE, M));
  add(buildTop(THREE, M));
  const { m8, ws } = fastenerLayout();
  m8.forEach((f, i) => {
    const id = String(i + 1).padStart(2, '0');
    add(buildM8(THREE, M, 'M8_' + id, f.axis, f.pos));
    add(buildWasher(THREE, M, 'W_' + id, f.axis, f.pos));
  });
  ws.forEach((f, i) => add(buildWoodScrew(THREE, M, 'WS_' + (i + 1), f.axis, f.pos)));
  return { parts, materials: M };
}
