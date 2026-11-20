// rig.js — avvolge le parti con nome in nodi-perno e applica gli stati animati.
//
//  scene
//   └─ ASSEMBLY           (capovolgimento finale del tavolo)
//       ├─ STRUCT         (struttura in alluminio: F1, T1, T2, viti M8, rondelle)
//       └─ TOP            (piano P1 + viti da legno)
//
// Ogni parte viene appesa a un nodo-perno posto al centro del suo bounding box
// (calcolato nella posizione di montaggio). Le tracce della timeline danno solo
// spostamenti (p), rotazioni attorno al perno (r), rotazione attorno al proprio
// asse di avvitamento (s), opacita' (o) ed evidenziazione arancio (h, hb).

const ORANGE = 0xff7e00;          // contorni evidenziati
const TINT = 0xffc25a;            // colore verso cui si tinge la superficie (resa ~#FAD0A0, tinta ~30°)
const TINT_GLOW = 0xffa63a;       // piccola emissione per non spegnere le parti in ombra
const INK = 0x1f1c1a;
const EDGE_OPACITY = 0.4;

export const GROUP_OF = (name) => (name === 'P1' || name.startsWith('WS_') ? 'TOP' : 'STRUCT');

export class Rig {
  constructor(THREE, scene, parts, { edgeAngle = 30 } = {}) {
    this.THREE = THREE;
    this.parts = {};
    this.groups = {};
    this.tmpQ = new THREE.Quaternion();
    this.tmpQ2 = new THREE.Quaternion();
    this.tmpE = new THREE.Euler();
    this.tmpV = new THREE.Vector3();
    this.orange = new THREE.Color(ORANGE);
    this.tint = new THREE.Color(TINT);
    this.tintGlow = new THREE.Color(TINT_GLOW);
    this.ink = new THREE.Color(INK);
    this.edgeK = 1;                         // moltiplicatore dell'opacita' dei contorni (primi piani)

    const mkGroup = (name, parent, pivot) => {
      const g = new THREE.Group();
      g.name = name;
      g.matrixAutoUpdate = false;
      g.userData.pivot = pivot;
      parent.add(g);
      this.groups[name] = g;
      return g;
    };
    const asm = mkGroup('ASSEMBLY', scene, [0, 375, 0]);
    mkGroup('STRUCT', asm, [0, 375, 0]);
    mkGroup('TOP', asm, [0, 375, 0]);

    for (const [name, obj] of Object.entries(parts)) this.addPart(name, obj, edgeAngle);
  }

  addPart(name, obj, edgeAngle) {
    const THREE = this.THREE;
    const group = this.groups[GROUP_OF(name)];
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    const node = new THREE.Group();
    node.name = name + '__node';
    node.position.copy(center);
    group.add(node);
    node.updateMatrixWorld(true);
    node.attach(obj);                       // conserva la trasformazione di montaggio

    const meshes = [], edges = [];
    obj.traverse((o) => {
      if (o.isMesh) {
        o.material = o.material.clone();
        o.userData.baseCast = o.castShadow;
        o.userData.baseEmissive = o.material.emissive ? o.material.emissive.clone() : null;
        o.userData.baseColor = o.material.color ? o.material.color.clone() : null;
        meshes.push(o);
      } else if (o.isLineSegments && o.userData.isEdge) {
        o.material = o.material.clone();
        o.userData.baseOpacity = o.material.opacity;
        edges.push(o);
      }
    });
    // contorni tecnici sottili
    for (const m of meshes) {
      if (m.userData.noEdges) continue;
      const eg = new THREE.EdgesGeometry(m.geometry, edgeAngle);
      const lm = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: EDGE_OPACITY });
      const ls = new THREE.LineSegments(eg, lm);
      ls.userData.isEdge = true;
      ls.userData.baseOpacity = EDGE_OPACITY;
      ls.userData.role = m.userData.role;
      ls.raycast = () => {};
      m.add(ls);
      edges.push(ls);
    }
    const axis = obj.userData.axis ? new THREE.Vector3(...obj.userData.axis).normalize() : null;
    this.parts[name] = { node, obj, center, meshes, edges, axis, lastO: -1, lastH: -1, lastHb: -1 };
  }

  setGroup(name, st) {
    const THREE = this.THREE;
    const g = this.groups[name];
    const pv = g.userData.pivot;
    const p = st.p || [0, 0, 0], r = st.r || [0, 0, 0];
    this.tmpE.set(r[0], r[1], r[2]);
    this.tmpQ.setFromEuler(this.tmpE);
    const R = new THREE.Matrix4().makeRotationFromQuaternion(this.tmpQ);
    const A = new THREE.Matrix4().makeTranslation(p[0] + pv[0], p[1] + pv[1], p[2] + pv[2]);
    const B = new THREE.Matrix4().makeTranslation(-pv[0], -pv[1], -pv[2]);
    g.matrix.copy(A).multiply(R).multiply(B);
    g.matrixWorldNeedsUpdate = true;
  }

  setPart(name, st) {
    const P = this.parts[name];
    if (!P) return;
    const { node, center } = P;
    node.position.set(center.x + st.p[0], center.y + st.p[1], center.z + st.p[2]);
    this.tmpE.set(st.r[0], st.r[1], st.r[2]);
    node.quaternion.setFromEuler(this.tmpE);
    if (P.axis && st.s) {
      this.tmpQ2.setFromAxisAngle(P.axis, st.s);
      node.quaternion.multiply(this.tmpQ2);
    }
    this.setOpacity(P, st.o);
    this.setHighlight(P, st.h, st.hb);
  }

  setOpacity(P, o) {
    if (Math.abs(o - P.lastO) < 1e-4) return;
    P.lastO = o;
    P.node.visible = o > 0.003;
    const tr = o < 0.999;
    for (const m of P.meshes) {
      m.material.transparent = tr;
      m.material.opacity = o;
      m.material.depthWrite = o > 0.35;
      m.castShadow = m.userData.baseCast && o > 0.55;
    }
    for (const e of P.edges) e.material.opacity = Math.min(1, e.userData.baseOpacity * this.edgeK) * o;
    P.lastH = -1;                            // forza il ricalcolo dei contorni
  }

  /** contorni piu' marcati nei primi piani (l'alluminio bianco si stacca dal fondale chiaro) */
  setEdgeScale(k) {
    if (Math.abs(k - this.edgeK) < 0.005) return;
    this.edgeK = k;
    for (const P of Object.values(this.parts)) P.lastO = -1;   // forza il ricalcolo
  }

  setHighlight(P, h, hb) {
    if (Math.abs(h - P.lastH) < 1e-4 && Math.abs(hb - P.lastHb) < 1e-4) return;
    P.lastH = h; P.lastHb = hb;
    for (const m of P.meshes) {
      const k = Math.max(h, m.userData.role === 'bracket' ? hb : 0);
      // si tinge il colore di base (non l'emissione, che col tone mapping vira al rosa);
      // i materiali "basic" (fori, asole, cava esagonale) non vengono tinti
      if (m.material.emissive) {
        m.material.color.copy(m.userData.baseColor).lerp(this.tint, 0.62 * k);
        m.material.emissive.copy(this.tintGlow).multiplyScalar(0.15 * k).add(m.userData.baseEmissive);
      }
    }
    for (const e of P.edges) {
      const k = Math.max(h, e.userData.role === 'bracket' ? hb : 0);
      const base = Math.min(1, e.userData.baseOpacity * this.edgeK);
      e.material.color.copy(this.ink).lerp(this.orange, k);
      e.material.opacity = (base + (0.9 - base) * k) * Math.max(P.lastO, 0);
    }
  }

  /** punto in coordinate di montaggio della parte -> coordinate mondo attuali */
  anchorWorld(name, point, out) {
    const P = this.parts[name];
    out = out || new this.THREE.Vector3();
    out.set(point[0] - P.center.x, point[1] - P.center.y, point[2] - P.center.z);
    return out.applyMatrix4(P.node.matrixWorld);
  }
}
