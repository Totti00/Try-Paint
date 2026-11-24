// plan3d.js — interpreta un AnimationPlan sul modello normalizzato e produce la coreografia:
//  - tracce per parte { t, p (spostamento mm nel sistema del montato), s (avvitamento), o, h };
//  - segmenti del "telaio" del montato (capovolgimenti, sollevamenti) valutati analiticamente;
//  - finestre delle azioni (per la camera automatica), didascalie, etichette e quantita'.
// La camera viene calcolata dopo (planCamera), perche' ha bisogno di posare la scena e di
// lanciare raggi per evitare che le parti da mostrare siano coperte.
//
// Semantica delle azioni (coordinate del modello normalizzato: Y in alto, mm):
//  - le parti compaiono alla prima azione che le cita; quelle mai citate (e le 'ignore') ci sono dall'inizio;
//  - insert: la parte parte da `direction` (versore del MONDO, "da dove arriva") a distanza
//    distance_factor x (ingombro della parte lungo quella direzione), limitata a 0,1–0,95 diagonali;
//    con direction.y < -0,3 ("da sotto") o se la parte finirebbe sotto il pavimento, il montato si
//    solleva, la parte scivola sotto in orizzontale (componente orizzontale della direzione, altrimenti
//    da dietro) e il montato si riabbassa su di essa (es. struttura capovolta appoggiata sul piano);
//  - fasten: viti (parti "ad asta") lungo il proprio asse dalla testa verso la punta, girando; rondelle
//    sotto la testa le accompagnano, dadi dal lato della punta arrivano dall'altra parte; loose=true
//    lascia la vite fuori di circa un diametro; tighten le porta a battuta;
//  - flip: ruota tutto il montato attorno all'asse del MONDO (sollevando quanto serve) e lo riappoggia
//    a terra; le parti di `keys` non ancora montate compaiono prima. Alla fine il prodotto viene
//    raddrizzato automaticamente se il piano lo ha lasciato capovolto;
//  - highlight: arancio senza movimento;
//  - closeup_keys: primo piano (stacco con dissolvenza) durante le azioni che coinvolgono quelle parti.

import * as THREE from 'three';
import { EASE, clamp01, lerp, compileTrack, evalChannel } from './anim.js';
import { frameCamera } from './scene3d.js';

const TURN = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

// tempi (s)
export const TIMING = {
  intro: 4.2, components: 6.0, lead: 1.0, tail: 0.9, gap: 0.2, cut: 0.45, closeTail: 1.3,
  insert: 1.8, flip: 3.2, highlight: 1.8, finale: 6.0, end: 4.0, restore: 3.2,
};

function boxCorners(box) {
  const c = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) c.push(new THREE.Vector3(x, y, z));
  return c;
}

/** profilo di sollevamento: sale nel primo quarto, resta, scende nell'ultimo quarto */
function plateau(u, a = 0.25) {
  if (u <= 0 || u >= 1) return 0;
  if (u < a) return EASE.inOut(u / a);
  if (u > 1 - a) return EASE.inOut((1 - u) / a);
  return 1;
}

export class Choreography {
  /**
   * @param {object} o
   * @param {object} o.plan     AnimationPlan
   * @param {object} o.manual   ManualData
   * @param {object} o.model    { parts, byKey, box } (parti con .info da analyzePart)
   * @param {Map}    o.roles    key -> role
   * @param {Function} o.raycastFinal (origin, dir, maxDist, excludeKeys) -> { key, distance } | null (scena montata)
   */
  constructor({ plan, manual, model, roles, raycastFinal }) {
    this.plan = plan;
    this.manual = manual || {};
    this.model = model;
    this.roles = roles;
    this.raycastFinal = raycastFinal;
    this.parts = model.parts;
    this.byKey = model.byKey;
    this.size = model.box.getSize(new THREE.Vector3());
    this.D = this.size.length() || 1;
    this.center = model.box.getCenter(new THREE.Vector3());
    this.keys = new Map();               // key -> keyframes
    this.frameSegs = [];
    this.F = { q: new THREE.Quaternion(), t: new THREE.Vector3() };   // stato del telaio alla fine dei segmenti
    this.mounted = new Set();
    this.screw = new Map();              // key -> { off, s, followers:[{key, side}] }
    this.enter = new Map();              // key -> [[t0, t1]] (fuori dall'inquadratura mentre arriva)
    this.windows = [];                   // finestre delle azioni per la camera
    this.captions = [];
    this.tags = [];
    this.warnings = [];
    this.halo = new Set(this.parts.filter((p) => this.isSmall(p)).map((p) => p.key));
  }

  K(key, t, k) { let a = this.keys.get(key); if (!a) { a = []; this.keys.set(key, a); } a.push({ t, ...k }); }
  part(key) { return this.byKey.get(key); }
  isSmall(p) { return Math.max(p.size.x, p.size.y, p.size.z) < 0.08 * this.D; }
  isScrew(p) { return p.info && p.info.shape === 'rod' && (this.roles.get(p.key) === 'hardware' || this.isSmall(p)); }

  // ------------------------------------------------------------------------------- telaio
  frameAt(t) {
    let st = { q: new THREE.Quaternion(), t: new THREE.Vector3() };
    for (const s of this.frameSegs) {
      if (t >= s.t1) { st = s.end; continue; }
      if (t <= s.t0) break;
      return this.evalSeg(s, (t - s.t0) / (s.t1 - s.t0));
    }
    return st;
  }

  evalSeg(s, u) {
    const ur = s.rot ? EASE.inOut(clamp01((u - s.rot[0]) / (s.rot[1] - s.rot[0]))) : 0;
    const q = s.q0.clone().slerp(s.q1, ur);
    const up = s.posEase ? EASE.inOut(clamp01((u - s.posEase[0]) / (s.posEase[1] - s.posEase[0]))) : EASE.inOut(u);
    const pos = s.pos0.clone().lerp(s.pos1, up);
    pos.y += (s.L || 0) * plateau(u, s.plateau || 0.25);
    const tv = pos.sub(s.c.clone().applyQuaternion(q));
    return { q, t: tv };
  }

  pushSeg(s) {
    s.end = this.evalSeg(s, 1);
    this.frameSegs.push(s);
    this.F = { q: s.end.q.clone(), t: s.end.t.clone() };
  }

  /** box locale (sistema del modello) delle parti indicate */
  localBox(keys) {
    const b = new THREE.Box3();
    for (const k of keys) { const p = this.part(k); if (p) b.union(p.box); }
    return b;
  }

  /** y minima nel mondo delle parti indicate con un telaio (q, t) */
  minYWith(keys, q, t) {
    let m = Infinity;
    const v = new THREE.Vector3();
    for (const k of keys) {
      const p = this.part(k);
      if (!p) continue;
      for (const c of boxCorners(p.box)) { v.copy(c).applyQuaternion(q).add(t); if (v.y < m) m = v.y; }
    }
    return m;
  }

  /** capovolgimento del montato attorno a un asse del mondo, appoggiando poi a terra */
  flip(t0, dur, axisName, angleDeg) {
    const keys = [...this.mounted];
    if (!keys.length) return;
    const axis = AXES[axisName] || AXES.x;
    const R = new THREE.Quaternion().setFromAxisAngle(axis, (angleDeg || 180) * Math.PI / 180);
    const q0 = this.F.q.clone(), t0v = this.F.t.clone();
    const q1 = R.clone().multiply(q0);
    const lb = this.localBox(keys);
    const c = lb.getCenter(new THREE.Vector3());
    const pos0 = c.clone().applyQuaternion(q0).add(t0v);
    // dopo la rotazione: stessa X/Z del perno, appoggio a terra
    const pos1 = pos0.clone();
    const tTmp = pos1.clone().sub(c.clone().applyQuaternion(q1));
    pos1.y -= this.minYWith(keys, q1, tTmp);
    // sollevamento per non toccare terra durante la rotazione
    const aLocal = axis.clone().applyQuaternion(q0.clone().invert());
    let r = 0;
    for (const k of keys) for (const cn of boxCorners(this.part(k).box)) {
      const d = cn.clone().sub(c);
      d.sub(aLocal.clone().multiplyScalar(d.dot(aLocal)));
      r = Math.max(r, d.length());
    }
    const L = Math.max(0, r - Math.min(pos0.y, pos1.y)) + 0.06 * this.D;
    this.pushSeg({ type: 'flip', t0, t1: t0 + dur, q0, q1, c, pos0, pos1, L, rot: [0.2, 0.8], posEase: [0.2, 0.8] });
  }

  /** riporta il montato nell'orientamento del modello (telaio = identita') */
  restore(t0, dur) {
    const q0 = this.F.q.clone(), t0v = this.F.t.clone();
    const c = this.center.clone();
    const pos0 = c.clone().applyQuaternion(q0).add(t0v);
    const pos1 = c.clone();
    const qd = q0.clone().invert();                       // rotazione (mondo) da compiere
    const angle = 2 * Math.acos(Math.min(1, Math.abs(qd.w)));
    const sinH = Math.sqrt(Math.max(0, 1 - qd.w * qd.w));
    const axisW = sinH > 1e-6 ? new THREE.Vector3(qd.x / sinH, qd.y / sinH, qd.z / sinH) : new THREE.Vector3(1, 0, 0);
    const aLocal = axisW.clone().applyQuaternion(q0.clone().invert());
    let r = 0;
    for (const k of this.mounted) for (const cn of boxCorners(this.part(k).box)) {
      const d = cn.clone().sub(c);
      d.sub(aLocal.clone().multiplyScalar(d.dot(aLocal)));
      r = Math.max(r, d.length());
    }
    const L = angle > 0.05 ? Math.max(0, r - Math.min(pos0.y, pos1.y)) + 0.06 * this.D : 0.08 * this.D;
    this.pushSeg({ type: 'restore', t0, t1: t0 + dur, q0, q1: new THREE.Quaternion(), c, pos0, pos1, L, rot: [0.2, 0.8], posEase: [0.15, 0.85] });
  }

  /** spostamento verticale del montato (sollevare / abbassare) */
  moveFrame(t0, dur, dy) {
    const q = this.F.q.clone();
    const pos0 = this.F.t.clone(), pos1 = pos0.clone(); pos1.y += dy;
    this.pushSeg({ type: 'move', t0, t1: t0 + dur, q0: q, q1: q, c: new THREE.Vector3(), pos0, pos1, L: 0 });
  }

  worldToLocalDir(v) { return v.clone().applyQuaternion(this.F.q.clone().invert()); }

  // ------------------------------------------------------------------------------- azioni
  /** comparsa in posizione (parti non ancora montate) */
  appear(key, t, dur = 0.5) {
    if (this.mounted.has(key)) return;
    this.K(key, t, { o: 0, p: [0, 0, 0] });
    this.K(key, t + dur, { o: 1, ease: 'linear' });
    this.mounted.add(key);
  }

  flash(key, t0, t1, k = 1, ramp = 0.3) {
    this.K(key, t0, { h: 0 });
    this.K(key, t0 + ramp, { h: k });
    this.K(key, Math.max(t0 + ramp, t1 - ramp), { h: k });
    this.K(key, t1, { h: 0 });
  }

  /** distanza di partenza lungo una direzione (mm) */
  travel(p, dirLocal, factor) {
    const ext = Math.abs(p.size.x * dirLocal.x) + Math.abs(p.size.y * dirLocal.y) + Math.abs(p.size.z * dirLocal.z);
    const f = factor > 0 ? factor : 1.5;
    let d = f * Math.max(ext, 1);
    if (this.isSmall(p)) d = Math.max(d, 3 * Math.max(p.size.x, p.size.y, p.size.z), 0.04 * this.D);
    return Math.min(Math.max(d, 0.1 * this.D), 0.95 * this.D);
  }

  defaultDir(p) {
    const d = p.center.clone().sub(this.center);
    d.y = Math.max(0, d.y) + 0.5 * this.size.y;
    if (d.lengthSq() < 1e-6) return UP.clone();
    return d.normalize();
  }

  insert(a, t0) {
    const keys = a.keys.filter((k) => this.part(k));
    if (!keys.length) return 0.6;
    let dirW = a.direction && a.direction.length === 3 ? new THREE.Vector3(...a.direction) : null;
    if (dirW && dirW.lengthSq() < 1e-8) dirW = null;
    if (dirW) dirW.normalize();
    // nuova parte sotto il montato (da sotto) o sotto il pavimento: si solleva il montato
    const newKeys = keys.filter((k) => !this.mounted.has(k));
    const allAfter = [...this.mounted, ...newKeys];
    const minAfter = newKeys.length ? this.minYWith(allAfter, this.F.q, this.F.t) : 0;
    const raise = minAfter < -0.5 ? -minAfter : 0;
    const under = newKeys.length && this.mounted.size && ((dirW && dirW.y < -0.3) || raise > 0);
    if (under) return this.insertUnder(keys, newKeys, dirW, a.distance_factor, t0, raise);

    const stagger = keys.length > 1 ? Math.min(0.25, 1.2 / (keys.length - 1)) : 0;
    const mv = TIMING.insert * 0.85;
    keys.forEach((k, i) => {
      const p = this.part(k);
      const ts = t0 + i * stagger;
      if (this.mounted.has(k)) { this.flash(k, ts, ts + mv + 0.4); return; }
      const dL = this.worldToLocalDir(dirW || this.defaultDir(p).applyQuaternion(this.F.q));
      const dist = this.travel(p, dL, a.distance_factor);
      const off = dL.clone().multiplyScalar(dist).toArray();
      this.K(k, ts - 0.01, { p: off, ease: 'step' });
      this.K(k, ts, { o: 0 });
      this.K(k, ts + 0.35, { o: 1, ease: 'linear' });
      this.K(k, ts + mv, { p: [0, 0, 0], ease: 'out' });
      this.flash(k, ts, ts + mv + 0.6);
      this.addEnter(k, ts, ts + mv * 0.45);
      this.mounted.add(k);
    });
    return mv + stagger * (keys.length - 1) + 0.2;
  }

  insertUnder(keys, newKeys, dirW, factor, t0, raise) {
    const h = this.localBox(newKeys).getSize(new THREE.Vector3());
    const asmH = (() => { const b = this.localBox([...this.mounted]); return b.isEmpty() ? 0 : b.getSize(new THREE.Vector3()).y; })();
    const L = h.y + 0.18 * Math.max(asmH, h.y) + 0.02 * this.D;
    let horiz = dirW ? new THREE.Vector3(dirW.x, 0, dirW.z) : new THREE.Vector3();
    if (horiz.lengthSq() < 0.04) horiz.set(0, 0, -1);
    horiz.normalize();
    const up0 = t0, up1 = t0 + 0.9;
    this.moveFrame(up0, up1 - up0, raise + L);
    const F1 = { q: this.F.q.clone(), t: this.F.t.clone() };      // sollevato
    const finalT = F1.t.clone(); finalT.y -= L;                      // dopo l'abbassamento
    const ts = t0 + 0.55, mv = 1.6;
    const arr = ts + mv;
    const down0 = arr + 0.1, down1 = down0 + 1.0;
    this.moveFrame(down0, down1 - down0, -L);
    // la parte si muove nel mondo, a terra, mentre il telaio sale e scende: tracce dense
    const qInv = F1.q.clone().invert();
    for (const k of newKeys) {
      const p = this.part(k);
      const dL = horiz.clone().applyQuaternion(qInv);
      const dist = this.travel(p, dL, factor) ;
      const target = p.base.clone().applyQuaternion(F1.q).add(finalT);      // posizione finale nel mondo
      const step = 1 / 30;
      this.K(k, ts - 0.01, { o: 0 });
      this.K(k, ts, { o: 0 });
      this.K(k, ts + 0.35, { o: 1, ease: 'linear' });
      for (let t = ts; t <= down1 + 1e-6; t += step) {
        const u = clamp01((t - ts) / mv);
        const W = target.clone().addScaledVector(horiz, dist * (1 - EASE.out(u)));
        const Ft = this.frameAt(t);
        // locale = q^-1 (W - t) - base
        const loc = W.sub(Ft.t).applyQuaternion(Ft.q.clone().invert()).sub(p.base);
        this.K(k, t, { p: loc.toArray(), ease: 'linear' });
      }
      this.K(k, down1 + 0.01, { p: [0, 0, 0], ease: 'linear' });
      this.flash(k, ts, down1 + 0.4);
      this.addEnter(k, ts, ts + mv * 0.4);
      this.mounted.add(k);
    }
    for (const k of keys) if (!newKeys.includes(k)) this.flash(k, ts, down1);
    return down1 - t0 + 0.2;
  }

  addEnter(k, a, b) { let l = this.enter.get(k); if (!l) { l = []; this.enter.set(k, l); } l.push([a, b]); }

  /** direzione di avvitamento (dentro il materiale), nel sistema del modello */
  screwDir(p) {
    const info = p.info;
    if (!info || !info.insertDir) return UP.clone().negate();
    if (info.headKnown) return info.insertDir.clone();
    if (p._dir) return p._dir.clone();
    // testa non riconoscibile: verso il materiale piu' vicino
    const o = p.center.clone();
    const a = info.insertDir.clone();
    const reach = Math.max(info.length || 10, 10) * 4;
    const h1 = this.raycastFinal(o, a, reach, [p.key]);
    const h2 = this.raycastFinal(o, a.clone().negate(), reach, [p.key]);
    let d = a;
    if (h2 && (!h1 || h2.distance < h1.distance)) d = a.clone().negate();
    else if (!h1 && !h2) d = a.y > 0.5 ? a.clone().negate() : a;     // nessun indizio: dall'alto verso il basso
    p._dir = d.clone();
    return d;
  }

  /** abbina rondelle/dadi alla vite piu' vicina dello stesso gruppo di chiavi */
  pairFollowers(screws, others) {
    const pairs = new Map(screws.map((s) => [s.key, []]));
    const lone = [];
    for (const o of others) {
      let best = null, bd = Infinity;
      for (const s of screws) {
        const dir = this.screwDir(s);
        const rel = o.center.clone().sub(s.center);
        const along = rel.dot(dir);
        const radial = rel.clone().sub(dir.clone().multiplyScalar(along)).length();
        const lim = Math.max(s.size.x, s.size.y, s.size.z) * 1.6 + Math.max(o.size.x, o.size.y, o.size.z);
        if (radial < Math.max(s.info.radius || 0, 2) * 2.2 + 1 && Math.abs(along) < lim) {
          const d = rel.length();
          if (d < bd) { bd = d; best = { s, side: along > 0.25 * (s.info.length || 1) ? 'tip' : 'head' }; }
        }
      }
      if (best) pairs.get(best.s.key).push({ key: o.key, side: best.side });
      else lone.push(o);
    }
    return { pairs, lone };
  }

  fasten(a, t0) {
    const ps = a.keys.map((k) => this.part(k)).filter(Boolean);
    if (!ps.length) return 0.6;
    const screws = ps.filter((p) => this.isScrew(p));
    const others = ps.filter((p) => !screws.includes(p));
    const { pairs, lone } = this.pairFollowers(screws, others);
    const n = screws.length;
    const ds = n <= 2 ? 1.8 : n <= 4 ? 1.5 : 1.2;
    const st = n <= 1 ? 0 : n <= 4 ? 0.45 : Math.max(0.16, 2.6 / (n - 1));
    const loose = !!a.loose;
    screws.forEach((s, i) => {
      const ts = t0 + i * st;
      const dir = this.screwDir(s);
      const len = Math.max(s.info.length || 10, 1);
      const approach = Math.max(2.2 * len, 0.03 * this.D);
      const looseAmt = loose ? Math.min(Math.max(s.info.diameter || len * 0.3, 0.15 * len), 0.6 * len) : 0;
      const at = (d) => dir.clone().multiplyScalar(-d).toArray();
      const followers = pairs.get(s.key) || [];
      const pathKeys = [s.key, ...followers.filter((f) => f.side === 'head').map((f) => f.key)];
      for (const k of pathKeys) {
        if (!this.mounted.has(k)) {
          this.K(k, ts - 0.01, { p: at(approach), ease: 'step' });
          this.K(k, ts, { o: 0 });
          this.K(k, ts + 0.25, { o: 1, ease: 'linear' });
          this.mounted.add(k);
          this.addEnter(k, ts, ts + ds * 0.3);
        } else this.K(k, ts, { p: at(this.screw.get(s.key)?.off ?? 0) });
        this.K(k, ts + ds * 0.42, { p: at(looseAmt + 0.35 * len), ease: 'out' });
        this.K(k, ts + ds, { p: at(looseAmt), ease: 'inOut' });
        this.flash(k, ts, ts + ds + 0.6);
      }
      // dadi dal lato della punta: arrivano dall'altra parte e girano
      for (const f of followers.filter((x) => x.side === 'tip')) {
        const k = f.key;
        const bt = (d) => dir.clone().multiplyScalar(d).toArray();
        if (!this.mounted.has(k)) {
          this.K(k, ts - 0.01, { p: bt(approach), ease: 'step' });
          this.K(k, ts, { o: 0 });
          this.K(k, ts + 0.25, { o: 1, ease: 'linear' });
          this.mounted.add(k);
        }
        this.K(k, ts + ds * 0.42, { p: bt(looseAmt + 0.35 * len), ease: 'out' });
        this.K(k, ts + ds, { p: bt(looseAmt), ease: 'inOut' });
        this.K(k, ts + ds * 0.42, { s: 0 });
        this.K(k, ts + ds, { s: -3 * TURN, ease: 'inOut' });
        this.flash(k, ts, ts + ds + 0.6);
      }
      const prev = this.screw.get(s.key);
      const s0 = prev ? prev.s : 0;
      const turns = loose ? 3 : 4.5;
      this.K(s.key, ts + ds * 0.38, { s: s0 });
      this.K(s.key, ts + ds, { s: s0 + turns * TURN, ease: 'inOut' });
      this.screw.set(s.key, { off: looseAmt, s: s0 + turns * TURN, followers, dir });
    });
    // parti non abbinate (es. rondelle senza vite): entrano lungo il proprio asse
    lone.forEach((p, i) => {
      const ts = t0 + i * 0.2;
      if (this.mounted.has(p.key)) { this.flash(p.key, ts, ts + ds); return; }
      const dir = p.info && p.info.axis ? this.screwDir(p) : this.worldToLocalDir(UP.clone().negate());
      const d = this.travel(p, dir, 1.5);
      this.K(p.key, ts - 0.01, { p: dir.clone().multiplyScalar(-d).toArray(), ease: 'step' });
      this.K(p.key, ts, { o: 0 });
      this.K(p.key, ts + 0.3, { o: 1, ease: 'linear' });
      this.K(p.key, ts + ds, { p: [0, 0, 0], ease: 'out' });
      this.flash(p.key, ts, ts + ds + 0.5);
      this.mounted.add(p.key);
    });
    if (n >= 2) this.addTag(screws.map((s) => s.key), t0 + 0.3, t0 + ds + st * (n - 1) + 0.5, n, a);
    return ds + st * Math.max(0, n - 1) + (lone.length ? 0.2 * lone.length : 0) + 0.1;
  }

  tighten(a, t0) {
    const ps = a.keys.map((k) => this.part(k)).filter(Boolean);
    if (!ps.length) return 0.6;
    const screws = ps.filter((p) => this.isScrew(p) || this.screw.has(p.key));
    const n = screws.length;
    const ds = 0.95;
    const st = n <= 1 ? 0 : n <= 4 ? 0.35 : Math.max(0.12, 2.2 / (n - 1));
    const listed = new Set(a.keys);
    screws.forEach((s, i) => {
      const ts = t0 + i * st;
      let state = this.screw.get(s.key);
      const dir = state ? state.dir : this.screwDir(s);
      if (!state) {
        // mai avvitata: compare lenta e si serra
        const len = Math.max(s.info?.length || 10, 1);
        state = { off: Math.min(Math.max(s.info?.diameter || len * 0.3, 0.15 * len), 0.6 * len), s: 0, followers: [], dir };
        if (!this.mounted.has(s.key)) {
          this.K(s.key, ts - 0.4, { o: 0, p: dir.clone().multiplyScalar(-state.off).toArray() });
          this.K(s.key, ts - 0.05, { o: 1, ease: 'linear' });
          this.mounted.add(s.key);
        }
      }
      const at = (d) => dir.clone().multiplyScalar(-d).toArray();
      const fk = state.followers.filter((f) => f.side === 'head').map((f) => f.key);
      for (const k of [s.key, ...fk]) {
        this.K(k, ts, { p: at(state.off) });
        this.K(k, ts + ds, { p: [0, 0, 0], ease: 'inOut' });
        this.flash(k, ts, ts + ds + 0.35, 1, 0.2);
      }
      for (const f of state.followers.filter((x) => x.side === 'tip')) {
        this.K(f.key, ts, { p: dir.clone().multiplyScalar(state.off).toArray() });
        this.K(f.key, ts + ds, { p: [0, 0, 0], ease: 'inOut' });
        this.flash(f.key, ts, ts + ds + 0.35, 1, 0.2);
      }
      this.K(s.key, ts, { s: state.s });
      this.K(s.key, ts + ds, { s: state.s + 2 * TURN, ease: 'inOut' });
      this.screw.set(s.key, { ...state, off: 0, s: state.s + 2 * TURN });
    });
    // altre chiavi elencate (non viti): solo evidenziate
    for (const p of ps) if (!screws.includes(p) && listed.has(p.key) && !screws.some((s) => (this.screw.get(s.key)?.followers || []).some((f) => f.key === p.key))) {
      this.appear(p.key, t0);
      this.flash(p.key, t0, t0 + ds + 0.4);
    }
    if (n >= 2) this.addTag(screws.map((s) => s.key), t0 + 0.2, t0 + ds + st * (n - 1) + 0.5, n, a);
    return ds + st * Math.max(0, n - 1) + 0.2;
  }

  highlight(a, t0) {
    const keys = a.keys.filter((k) => this.part(k));
    for (const k of keys) { this.appear(k, t0 - 0.2); this.flash(k, t0, t0 + TIMING.highlight, 1, 0.35); }
    return TIMING.highlight;
  }

  addTag(keys, t0, t1, n, a) {
    // testo: nome breve della ferramenta (dal riferimento del piano) + quantita'
    const refs = new Set(keys.map((k) => this.roleRef.get(k)).filter(Boolean));
    let name = '';
    if (refs.size === 1) {
      const ref = [...refs][0];
      const hw = (this.manual.hardware || []).find((h) => h.id === ref);
      if (hw) name = hw.name;
    }
    if (name.length > 24) name = name.slice(0, 23).trim() + '…';
    this.tags.push({ keys, t0, t1, text: (name ? name + ' ' : '') + '×' + n });
  }

  // ------------------------------------------------------------------------------- coreografia
  build() {
    const plan = this.plan;
    this.roleRef = new Map((plan.parts || []).map((r) => [r.key, r.ref]));
    const allKeys = this.parts.map((p) => p.key);
    const referenced = new Set();
    const steps = (plan.steps || []).slice();
    const step0 = steps.find((s) => s.number === 0) || null;
    const numbered = steps.filter((s) => s !== step0);
    for (const s of numbered) for (const a of s.actions || []) for (const k of a.keys || []) if (this.part(k)) referenced.add(k);
    for (const s of numbered) for (const a of s.actions || []) for (const k of a.keys || []) if (!this.part(k)) this.warnings.push(`Parte ${k} citata nel piano ma assente nel modello`);
    const present = allKeys.filter((k) => !referenced.has(k) || this.roles.get(k) === 'ignore');

    // ---- introduzione: prodotto finito
    for (const k of allKeys) this.K(k, 0, { p: [0, 0, 0], o: 1, s: 0, h: 0 });
    const tC0 = TIMING.intro;
    // ---- componenti: esploso proporzionale, minuteria nascosta
    const comps = this.parts.filter((p) => (this.roles.get(p.key) || 'component') === 'component' && !this.isSmall(p));
    const hidden = this.parts.filter((p) => !comps.includes(p));
    const tC1 = tC0 + TIMING.components;
    this.explode = new Map();
    for (const p of comps) {
      const d = p.center.clone().sub(this.center).multiplyScalar(0.8);
      if (p.center.y > this.center.y + 0.1 * this.size.y) d.y += 0.25 * this.size.y;
      if (d.length() < 0.04 * this.D) d.set(0, 0.3 * this.size.y, 0);
      d.y = Math.max(d.y, -p.box.min.y);       // mai sotto il pavimento
      this.explode.set(p.key, d);
    }
    for (const p of hidden) { this.K(p.key, tC0 + 0.1, { o: 1 }); this.K(p.key, tC0 + 0.6, { o: 0 }); }
    comps.forEach((p, i) => {
      const d = this.explode.get(p.key).toArray();
      this.K(p.key, tC0 + 0.3 + 0.05 * i, { p: [0, 0, 0] });
      this.K(p.key, tC0 + 2.3 + 0.05 * i, { p: d, ease: 'inOut' });
      // uscita: si allontanano svanendo
      const out = this.explode.get(p.key).clone().multiplyScalar(1.5).add(new THREE.Vector3(0, 0.05 * this.D, 0)).toArray();
      this.K(p.key, tC1 - 0.9, { p: d, o: 1 });
      this.K(p.key, tC1 - 0.15, { p: out, o: 0, ease: 'in' });
    });
    this.componentsWindow = { t0: tC0, t1: tC1, comps: comps.map((p) => p.key) };
    this.captions.push({ kind: 'box', t0: tC0 + 0.3, t1: tC1, title: (step0 && step0.caption_title) || 'Componenti e ferramenta', body: (step0 && step0.caption_body) || 'Verificare il contenuto della confezione' });
    this.windows.push({ t0: tC0, t1: tC1, kind: 'components' });

    // ---- passi
    let T = tC1;
    for (const k of present) { this.K(k, T - 0.01, { p: [0, 0, 0], o: 0, h: 0, s: 0 }); this.K(k, T + 0.6, { o: 1, ease: 'linear' }); this.mounted.add(k); }
    for (const k of referenced) if (!present.includes(k)) this.K(k, T - 0.01, { o: 0, p: [0, 0, 0], h: 0, s: 0 });
    this.stepWindows = [];
    for (const s of numbered) {
      const s0 = T;
      const closeKeys = new Set((s.closeup_keys || []).filter((k) => this.part(k)));
      let cur = s0 + (this.mounted.size ? TIMING.lead : 0.5);   // scena vuota: si parte subito
      let prevClose = false;
      const acts = [];
      for (const a of s.actions || []) {
        const involves = (a.keys || []).some((k) => closeKeys.has(k));
        const isClose = closeKeys.size > 0 && a.type !== 'flip' && involves;
        if (isClose !== prevClose) cur += TIMING.cut;
        const t0 = cur;
        let d = 0.6;
        if (a.type === 'insert') d = this.insert(a, t0);
        else if (a.type === 'fasten') d = this.fasten(a, t0);
        else if (a.type === 'tighten') d = this.tighten(a, t0);
        else if (a.type === 'flip') {
          for (const k of a.keys || []) if (this.part(k)) this.appear(k, t0 - 0.5);
          this.flip(t0, TIMING.flip, a.axis || 'x', a.angle_deg ?? 180);
          d = TIMING.flip;
        } else if (a.type === 'highlight') d = this.highlight(a, t0);
        acts.push({ t0, t1: t0 + d, type: a.type, keys: (a.keys || []).filter((k) => this.part(k)), close: isClose, closeKeys: [...closeKeys], flip: a.type === 'flip' });
        cur = t0 + d + TIMING.gap;
        prevClose = isClose;
      }
      if (prevClose) cur += TIMING.cut + TIMING.closeTail; else cur += TIMING.tail;
      if (!acts.length) cur = s0 + 3.2;
      const s1 = cur;
      this.captions.push({ kind: 'step', n: s.number, t0: s0, t1: s1, title: s.caption_title, body: s.caption_body });
      this.stepWindows.push({ t0: s0, t1: s1, acts, number: s.number });
      T = s1;
    }

    // ---- finale: eventuale raddrizzamento, giro attorno al prodotto
    const tF0 = T;
    for (const k of allKeys) if (!this.mounted.has(k)) this.appear(k, tF0, 0.6);
    let tTurn = tF0;
    const identity = this.F.q.angleTo(new THREE.Quaternion()) < 1e-3 && this.F.t.length() < 0.5;
    if (!identity) {
      this.restore(tF0 + 0.3, TIMING.restore);
      tTurn = tF0 + 0.3 + TIMING.restore + 0.2;
    }
    const tEnd = tTurn + TIMING.finale;
    this.finale = { t0: tF0, turn0: tTurn, t1: tEnd };
    this.captions.push({ kind: 'check', t0: tF0, t1: tEnd + TIMING.end, title: plan.final_caption_title || 'Montaggio completato', body: plan.final_caption_body || '' });
    this.endcard = { t0: tEnd, t1: tEnd + TIMING.end };
    this.duration = tEnd + TIMING.end;
    this.numberedCount = numbered.length;

    this.compiled = new Map();
    for (const [k, list] of this.keys) this.compiled.set(k, compileTrack(list));
    return this;
  }

  /** stato di una parte all'istante t */
  partState(key, t) {
    const ch = this.compiled.get(key);
    return {
      p: evalChannel(ch && ch.p, t, [0, 0, 0]),
      s: evalChannel(ch && ch.s, t, 0),
      o: evalChannel(ch && ch.o, t, 1),
      h: evalChannel(ch && ch.h, t, 0),
    };
  }

  /** la parte e' in arrivo (esclusa dall'inquadratura)? */
  entering(key, t) {
    const l = this.enter.get(key);
    return !!(l && l.some(([a, b]) => t >= a && t < b));
  }
}

// =====================================================================================
// Camera automatica
// =====================================================================================

/**
 * @param {Choreography} ch
 * @param {object} env  { W, H, poseAt(t), boxesAt(t, filter) -> Box3[], visibility(camPos, points, focusKeys) -> 0..1,
 *                        worldPointsOf(keys, t) -> Vector3[], hasHwCard, safe: { wide:{...}, intro:{...} } }
 * @returns {{ shots: object[] }}
 */
export function planCamera(ch, env) {
  const { size, D } = ch;
  const aspect = env.W / env.H;
  const az0 = size.z > size.x * 1.15 ? 55 : 35;
  const flat = size.y < 0.35 * Math.max(size.x, size.z);
  const el0 = flat ? 32 : 24;
  const SAFE = { hx: 0.88, yLo: -0.44, yHi: 0.78 };
  const shots = [];
  const newShot = (t0, dis) => { const s = { t0, dis, keys: [] }; shots.push(s); return s; };
  const key = (shot, t, f) => shot.keys.push({ t, target: f.target.toArray ? f.target.toArray() : f.target, dist: f.dist, az: f.az, el: f.el, fov: 30, sx: f.sx || 0, sy: f.sy || 0, ease: f.ease || 'inOut' });

  const fit = (points, az, el, area = SAFE) => {
    const r = frameCamera(points, { az, el, aspect, ...area });
    return { target: r.target, dist: r.dist, az, el, sx: r.sx, sy: r.sy };
  };
  const sampleBox = (t0, t1, step = 0.25) => {
    const box = new THREE.Box3();
    for (let t = t0; t <= t1 + 1e-6; t += step) for (const b of env.boxesAt(t)) box.union(b);
    return box;
  };
  const cornersOf = (box) => boxCorners(box);

  // ---- introduzione: prodotto finito, titolo in basso a sinistra
  {
    const s = newShot(0, 0);
    const pts = cornersOf(ch.model.box);
    const area = { xLo: -0.28, xHi: 0.92, yLo: -0.3, yHi: 0.86 };
    const a = fit(pts, az0 + 16, el0 - 3, area), b = fit(pts, az0 + 6, el0, area);
    const dist = Math.max(a.dist, b.dist);
    key(s, 0, { ...a, dist: dist * 1.04 });
    key(s, TIMING.intro, { ...b, dist, ease: 'linear' });
  }
  // ---- componenti: esploso (spazio a destra per la ferramenta)
  const cw = ch.componentsWindow;
  {
    const s = newShot(cw.t0 + 0.15, 0.6);
    const box = sampleBox(cw.t0 + 2.4, cw.t1 - 1.0, 0.5);
    if (box.isEmpty()) box.copy(ch.model.box);
    const area = env.hasHwCard ? { xLo: -0.9, xHi: 0.2, yLo: -0.4, yHi: 0.8 } : { hx: 0.86, yLo: -0.4, yHi: 0.8 };
    const a = fit(cornersOf(box), az0 - 2, el0 + 2, area);
    const b = fit(cornersOf(box), az0 - 8, el0 + 2, area);
    const dist = Math.max(a.dist, b.dist) * 1.03;
    key(s, cw.t0 + 0.15, { ...a, dist: dist * 1.08 });
    key(s, cw.t0 + 2.6, { ...a, dist });
    key(s, cw.t1, { ...b, dist: dist * 0.98, ease: 'linear' });
  }

  // ---- passi: segmenti larghi e primi piani
  // azimut delle inquadrature larghe: oscillazione lenta e limitata attorno alla vista di base
  const tS = ch.stepWindows.length ? ch.stepWindows[0].t0 : cw.t1;
  const wideAz = (t) => az0 - 2 + 14 * Math.sin(2 * Math.PI * (t - tS) / 46);
  let el = el0;
  let curShot = null;
  let lastWide = null;          // { off, el, dist }
  const wideFrame = (t0, t1, focusKeys, prevOff) => {
    const box = sampleBox(t0, t1);
    if (box.isEmpty()) box.copy(ch.model.box);
    const sz = box.getSize(new THREE.Vector3());
    const minS = 0.55 * D;
    if (sz.length() < minS) box.expandByScalar((minS - sz.length()) / 3);
    const pts = cornersOf(box);
    const cands = [[prevOff, el0]];
    if (prevOff !== 0) cands.push([0, el0]);
    if (focusKeys && focusKeys.length) cands.push([90, el0], [-90, el0], [180, el0], [0, el0 + 22], [180, el0 + 18]);
    let best = null;
    for (const [off, e] of cands) {
      const fa = fit(pts, wideAz(t0) + off, e), fb = fit(pts, wideAz(t1) + off, e);
      let score = 0;
      if (focusKeys && focusKeys.length && env.visibility) {
        const fp = env.worldPointsOf(focusKeys, t1);
        score = env.visibility(fb, fp, focusKeys, t1);
      }
      score -= (off === prevOff && e === el0) ? 0 : (off === 0 && e === el0 ? 0.15 : 0.3);
      if (!best || score > best.score) best = { fa, fb, off, e, score, dist: Math.max(fa.dist, fb.dist) };
    }
    best.fa.dist = best.dist; best.fb.dist = best.dist;
    return best;
  };

  const steps = ch.stepWindows;
  for (const sw of steps) {
    // segmenti: attacco largo, azioni (larghe/ravvicinate), coda
    const segs = [];
    let t = sw.t0;
    for (const a of sw.acts) {
      if (a.close) {
        const cutAt = a.t0 - TIMING.cut;
        if (cutAt > t + 0.05) {
          const prev = segs[segs.length - 1];
          if (prev && prev.kind === 'wide') prev.t1 = cutAt; else segs.push({ kind: 'wide', t0: t, t1: cutAt, keys: [] });
        }
        const prev = segs[segs.length - 1];
        if (prev && prev.kind === 'close' && prev.closeKeys.join() === a.closeKeys.join()) { prev.t1 = a.t1; prev.acts.push(a); }
        else segs.push({ kind: 'close', t0: Math.max(t, cutAt), t1: a.t1, closeKeys: a.closeKeys, acts: [a] });
        t = a.t1;
      } else {
        const prev = segs[segs.length - 1];
        if (prev && prev.kind === 'wide') { prev.t1 = a.t1 + TIMING.gap; prev.keys.push(...a.keys); prev.flip = prev.flip || a.flip; }
        else segs.push({ kind: 'wide', t0: t + (prev ? 0.15 : 0), t1: a.t1 + TIMING.gap, keys: a.keys.slice(), flip: a.flip });
        t = a.t1 + TIMING.gap;
      }
    }
    const lastSeg = segs[segs.length - 1];
    if (lastSeg && lastSeg.kind === 'wide') lastSeg.t1 = sw.t1;
    else segs.push({ kind: 'wide', t0: lastSeg ? lastSeg.t1 + 0.1 : t, t1: sw.t1, keys: [] });
    if (segs[0].t0 > sw.t0) segs[0].t0 = sw.t0;

    for (const sg of segs) {
      if (sg.kind === 'wide') {
        const prevOff = lastWide ? lastWide.off : 0;
        const big = sg.keys.filter((k) => !ch.isSmall(ch.part(k)));
        const w = wideFrame(sg.t0, sg.t1, big, prevOff);
        const ratio = lastWide ? w.dist / lastWide.dist : 1;
        const needCut = !curShot || curShot.kind !== 'wide' || w.off !== prevOff || w.e !== (lastWide ? lastWide.el : el0) || ratio > 1.9 || ratio < 0.5;
        if (needCut) {
          curShot = newShot(sg.t0, shots.length ? 0.45 : 0);
          curShot.kind = 'wide';
          key(curShot, sg.t0, w.fa);
        } else {
          // movimento lento verso il nuovo inquadramento (anticipato per i capovolgimenti)
          const prevK = curShot.keys[curShot.keys.length - 1];
          const ta = Math.max(prevK.t + 0.05, sg.t0 - (sg.flip ? 0.7 : 0.2));
          if (ta < sg.t1 - 0.3) {
            const u = (ta - prevK.t);
            key(curShot, ta, { target: prevK.target, dist: prevK.dist, az: wideAz(ta) + prevOff, el: prevK.el, sx: prevK.sx, sy: prevK.sy, ease: 'linear' });
            void u;
            const tb = Math.min(sg.t1 - 0.1, ta + 1.3);
            const fbm = fit(cornersOf(sampleBox(sg.t0, sg.t1)), wideAz(tb) + w.off, w.e);
            key(curShot, tb, { ...w.fb, target: fbm.target, sy: fbm.sy, sx: fbm.sx, az: wideAz(tb) + w.off });
          }
        }
        key(curShot, sg.t1, { ...w.fb, ease: 'linear' });
        lastWide = { off: w.off, el: w.e, dist: w.dist };
        el = w.e;
      } else {
        const azW = wideAz(sg.t0) + (lastWide ? lastWide.off : 0);
        const f = closeFrame(ch, env, sg, azW, aspect, SAFE);
        curShot = newShot(sg.t0, 0.42);
        curShot.kind = 'close';
        key(curShot, sg.t0, { ...f });
        key(curShot, sg.t1, { ...f, az: f.az + 1.1 * (sg.t1 - sg.t0), dist: f.dist * 0.95, ease: 'linear' });
      }
    }
  }

  // ---- finale: giro attorno al prodotto (eventuale raddrizzamento prima)
  {
    const fz = ch.finale;
    const pts = cornersOf(ch.model.box);
    if (fz.turn0 > fz.t0 + 0.1) {
      // raddrizzamento: inquadratura larga che contiene il movimento
      const box = sampleBox(fz.t0, fz.turn0, 0.2);
      const fa = fit(cornersOf(box), wideAz(fz.t0), el0), fb = fit(cornersOf(box), wideAz(fz.turn0), el0);
      const dist = Math.max(fa.dist, fb.dist);
      const s = newShot(fz.t0, 0.45);
      key(s, fz.t0, { ...fa, dist });
      key(s, fz.turn0, { ...fb, dist, ease: 'linear' });
    }
    const a0 = wideAz(fz.turn0) - 8;
    let dist = 0, f0 = null;
    for (let k = 0; k <= 6; k++) {
      const f = fit(pts, a0 + 110 * k / 6, el0, SAFE);
      if (f.dist > dist) dist = f.dist;
      if (k === 0) f0 = f;
    }
    const s = newShot(fz.turn0, fz.turn0 > fz.t0 + 0.1 ? 0.0 : 0.45);
    if (fz.turn0 > fz.t0 + 0.1) s.dis = 0.5;
    const target = ch.model.box.getCenter(new THREE.Vector3());
    target.copy(f0.target);
    key(s, fz.turn0, { target, dist: dist * 1.02, az: a0, el: el0, sy: f0.sy, sx: 0 });
    key(s, ch.duration, { target, dist: dist * 1.02, az: a0 + 110 * (ch.duration - fz.turn0) / (fz.t1 - fz.turn0), el: el0, sy: f0.sy, sx: 0, ease: 'linear' });
  }
  shots.sort((a, b) => a.t0 - b.t0);
  return { shots };
}

/** primo piano: cerca la direzione da cui le parti sono meglio visibili */
function closeFrame(ch, env, sg, azWide, aspect, SAFE) {
  const D = ch.D;
  const tEval = Math.min(sg.t1 - 0.05, Math.max(...sg.acts.map((a) => a.t1)) - 0.05);
  const focus = sg.closeKeys.slice(0, 6);
  const fb = new THREE.Box3();
  for (const b of env.boxesAt(tEval, focus)) fb.union(b);
  if (fb.isEmpty()) for (const k of focus) fb.union(ch.part(k).box);
  let fsz = fb.getSize(new THREE.Vector3());
  // parte grande: si inquadra il giunto (intersezione con le altre parti montate)
  if (fsz.length() > 0.35 * D) {
    const others = env.boxesAt(tEval, null, focus);
    let best = null;
    for (const o of others) {
      const ib = fb.clone().intersect(o.clone().expandByScalar(0.01 * D));
      if (ib.isEmpty()) continue;
      const v = ib.getSize(new THREE.Vector3());
      const score = v.x * v.y * v.z + 1;
      if (!best || score > best.score) best = { ib, score };
    }
    if (best) { fb.copy(best.ib); fsz = fb.getSize(new THREE.Vector3()); }
  }
  const c = fb.getCenter(new THREE.Vector3());
  const s = Math.max(fsz.length() * 1.7, 0.09 * D);
  const ctx = new THREE.Box3().setFromCenterAndSize(c, new THREE.Vector3(s, s * 0.8, s));
  ctx.union(fb);
  const pts = boxCorners(ctx);
  const focusPts = env.worldPointsOf(env.heavy ? focus.slice(0, 3) : focus, tEval);
  // direzione preferita: dal lato della testa delle viti
  let headDir = null;
  for (const k of focus) {
    const st = ch.screw.get(k);
    if (st && st.dir) { headDir = env.localToWorldDir(st.dir.clone().negate(), tEval); break; }
  }
  let best = null;
  // modelli pesanti: ricerca piu' rada (ogni raggio prova molti triangoli)
  const azSteps = env.heavy ? 6 : 12, els = env.heavy ? [22, 46] : [14, 30, 46, 62];
  for (let ia = 0; ia < azSteps; ia++) for (const e of els) {
    const a = azWide + ia * (360 / azSteps);
    const f = frameCamera(pts, { az: a, el: e, aspect, ...SAFE });
    const fr = { target: f.target, dist: f.dist, az: a, el: e, sx: f.sx, sy: f.sy };
    const camPos = env.cameraPosition(fr);
    if (camPos.y < 0.01 * D) continue;
    const vis = env.visibility(fr, focusPts, focus, tEval);
    let score = vis;
    if (headDir) {
      const w = camPos.clone().sub(f.target).normalize();
      const cos = w.dot(headDir);
      score += 0.35 * Math.min(1, Math.max(0, cos) / 0.7) - (cos > 0.97 ? 0.1 : 0);
    }
    score += 0.1 * (1 - Math.abs(e - 32) / 40);
    const dAz = ((a - azWide) % 360 + 540) % 360 - 180;
    score += 0.15 * (1 - Math.abs(dAz) / 180);
    if (!best || score > best.score) best = { fr, score, vis };
  }
  if (!best) {
    const f = frameCamera(pts, { az: azWide, el: 35, aspect, ...SAFE });
    return { target: f.target, dist: f.dist, az: azWide, el: 35, sx: f.sx, sy: f.sy };
  }
  if (best.vis < 0.3) ch.warnings.push(`Primo piano poco visibile (${focus.join(', ')}): visibilità ${Math.round(best.vis * 100)}%`);
  return best.fr;
}

export { boxCorners, lerp };
