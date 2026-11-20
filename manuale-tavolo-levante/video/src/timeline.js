// =============================================================================
//  timeline.js — UNICA TABELLA DEI TEMPI dell'animazione
// -----------------------------------------------------------------------------
//  STEP_TABLE  : sequenza dei capitoli con durata e didascalie (italiano).
//                Gli istanti di inizio/fine sono calcolati sommando le durate:
//                allungare/accorciare un passo sposta automaticamente i successivi.
//  Dentro buildTimeline() ogni evento e' espresso come  at('s3', 1.2)  =
//  "1.2 s dopo l'inizio del passo 3", quindi resta agganciato al suo passo.
//
//  Le tracce agiscono SOLO sui nomi delle parti (F1_L, T1_A, M8_01, …) e su
//  spostamenti relativi alla posizione di montaggio: valgono anche per il
//  modello CAD reale.
// =============================================================================

import { EASE } from './anim.js';

export const FPS = 30;

export const STEP_TABLE = [
  { id: 'intro', dur: 4.5 },
  { id: 'kit', dur: 8.5, title: 'Componenti e ferramenta', body: 'Verificare il contenuto della confezione' },
  { id: 's1', n: 1, dur: 5.5, title: 'Posizionare i due fianchi (F1) in maniera speculare', body: 'Con le asole dei montanti rivolte una verso l’altra' },
  { id: 's2', n: 2, dur: 11, title: 'Inserire i traversi superiori (T1) nelle asole dei fianchi', body: 'Angolari di fissaggio rivolti verso l’interno' },
  { id: 's3', n: 3, dur: 10, title: 'Avvitare le viti M8 con rondella in nylon', body: 'Senza serrarle — 4 viti per traverso' },
  { id: 's4', n: 4, dur: 11.5, title: 'Inserire il traverso inferiore (T2)', body: 'Spingerlo fino in fondo e usare il foro più interno' },
  { id: 's5', n: 5, dur: 6, title: 'Serrare tutte le 10 viti', body: 'La struttura in alluminio è completa' },
  { id: 's6', n: 6, dur: 10, title: 'Posizionare la struttura capovolta sul piano a doghe (P1)', body: 'Allineare al meglio piano e struttura' },
  { id: 's7', n: 7, dur: 10, title: 'Fissare il piano con le 6 viti da legno', body: 'Nelle asole degli angolari dei traversi T1' },
  { id: 's8', n: 8, dur: 12, title: 'Montaggio completato', body: 'Stesso procedimento per Panca Gradisca e Panca Volpina' },
  { id: 'end', dur: 5 },
];

// tempi assoluti
let acc = 0;
export const STEPS = STEP_TABLE.map((s) => {
  const o = { ...s, t0: acc, t1: acc + s.dur };
  acc += s.dur;
  return o;
});
export const DURATION = acc;
const byId = Object.fromEntries(STEPS.map((s) => [s.id, s]));
export const at = (id, dt = 0) => byId[id].t0 + dt;

const PI = Math.PI;
const TURN = PI * 2;

/**
 * @param {object} model  { axes: {name: [x,y,z]}, dims }  — assi di avvitamento della minuteria
 */
export function buildTimeline(model) {
  const tracks = {};
  const groups = { STRUCT: [], TOP: [], ASSEMBLY: [] };
  const K = (name, t, k) => (tracks[name] ||= []).push({ t, ...k });
  const G = (name, t, k) => groups[name].push({ t, ...k });
  const spinAcc = {};
  const axis = (n) => model.axes[n];
  const off = (n, d) => axis(n).map((a) => -a * d);

  const PARTS = ['F1_L', 'F1_R', 'T1_A', 'T1_B', 'T2', 'P1'];
  const M8 = Array.from({ length: 10 }, (_, i) => String(i + 1).padStart(2, '0'));
  const WS = Array.from({ length: 6 }, (_, i) => 'WS_' + (i + 1));
  const ALL_SCREWS = [...M8.flatMap((id) => ['M8_' + id, 'W_' + id]), ...WS];

  /** evidenziazione arancio a finestra */
  const flash = (name, t0, t1, k = 1, ch = 'h', ramp = 0.3) => {
    K(name, t0, { [ch]: 0 });
    K(name, t0 + ramp, { [ch]: k });
    K(name, t1 - ramp, { [ch]: k });
    K(name, t1, { [ch]: 0 });
  };

  // ------------------------------------------------------------------ INTRO
  // t = 0: tavolo finito (tutte le parti in posizione di montaggio)
  for (const n of [...PARTS, ...ALL_SCREWS]) K(n, 0, { p: [0, 0, 0], r: [0, 0, 0], o: 1, s: 0, h: 0, hb: 0 });
  for (const g of Object.keys(groups)) G(g, 0, { p: [0, 0, 0], r: [0, 0, 0] });

  // -------------------------------------------------------------- KIT (esploso)
  const k0 = at('kit');
  const EX = { F1_L: [-560, 0, 0], F1_R: [560, 0, 0], T1_A: [0, 140, 360], T1_B: [0, 140, -360], T2: [0, 0, 600] };
  for (const n of ALL_SCREWS) { K(n, k0, { o: 1 }); K(n, k0 + 0.5, { o: 0 }); }
  for (const [n, p] of Object.entries(EX)) { K(n, k0 + 0.2, { p: [0, 0, 0] }); K(n, k0 + 2.4, { p }); }
  G('TOP', k0 + 0.2, { p: [0, 0, 0] });
  G('TOP', k0 + 2.4, { p: [0, 560, 0] });
  // uscita: tutto svanisce allontanandosi leggermente
  const kx = at('kit', 7.6), kx1 = at('kit', 8.4);
  for (const [n, p] of Object.entries(EX)) {
    const dir = n === 'T2' ? [0, 0, 500] : n.startsWith('T1') ? [0, 250, Math.sign(p[2]) * 500] : [Math.sign(p[0]) * 700, 0, 0];
    K(n, kx, { p, o: 1 });
    K(n, kx1, { p: p.map((v, i) => v + dir[i]), o: 0, ease: 'in' });
  }
  K('P1', kx, { o: 1 }); K('P1', kx1, { o: 0, ease: 'in' });
  G('TOP', kx, { p: [0, 560, 0] });
  G('TOP', kx1, { p: [0, 1300, 0], ease: 'in' });

  // ------------------------------------------------------------------ PASSO 1
  // F1_R viene posato 240 mm piu' esterno: serve spazio per infilare i T1 (passo 2)
  const s1 = at('s1');
  const RGAP = 240;
  K('F1_L', s1 - 0.01, { p: [-1500, 0, 0], ease: 'step' });
  K('F1_L', s1, { o: 0 }); K('F1_L', s1 + 0.5, { o: 1, ease: 'linear' });
  K('F1_L', s1 + 2.6, { p: [0, 0, 0], ease: 'outQuint' });
  K('F1_R', s1 + 0.29, { p: [1500 + RGAP, 0, 0], ease: 'step' });
  K('F1_R', s1 + 0.3, { o: 0 }); K('F1_R', s1 + 0.8, { o: 1, ease: 'linear' });
  K('F1_R', s1 + 2.9, { p: [RGAP, 0, 0], ease: 'outQuint' });
  flash('F1_L', s1 + 0.1, s1 + 5.2);
  flash('F1_R', s1 + 0.4, s1 + 5.2);
  K('MIRROR', 0, { o: 0 });
  K('MIRROR', s1 + 2.6, { o: 0 }); K('MIRROR', s1 + 3.1, { o: 1 });
  K('MIRROR', s1 + 4.9, { o: 1 }); K('MIRROR', s1 + 5.4, { o: 0 });

  // ------------------------------------------------------------------ PASSO 2
  const s2 = at('s2');
  for (const [n, sz, d] of [['T1_A', 1, 0], ['T1_B', -1, 0.25]]) {
    K(n, s2 + d - 0.01, { p: [100, 650, sz * 800], ease: 'step' });
    K(n, s2 + d, { o: 0 }); K(n, s2 + d + 0.45, { o: 1, ease: 'linear' });
    K(n, s2 + d + 2.1, { p: [100, 0, 0], ease: 'outQuint' });   // pre-inserimento davanti alle asole di F1_L
    K(n, s2 + 2.6, { p: [100, 0, 0] });
    K(n, s2 + 5.1, { p: [0, 0, 0], ease: 'inOut' });            // dentro le asole
    K(n, s2 + d, { h: 0 }); K(n, s2 + d + 0.3, { h: 0.85 });
    K(n, s2 + 2.6, { h: 0.85 }); K(n, s2 + 3.0, { h: 0.2 });
    K(n, s2 + 5.2, { h: 0.2 }); K(n, s2 + 5.7, { h: 0 });
    flash(n, s2 + 2.6, s2 + 5.7, 1, 'hb', 0.4);                  // angolari verso l'interno
  }
  K('F1_R', s2 + 6.0, { p: [RGAP, 0, 0] });
  K('F1_R', s2 + 8.2, { p: [0, 0, 0], ease: 'inOut' });          // il secondo fianco si accosta
  flash('F1_R', s2 + 5.8, s2 + 8.8);

  // ------------------------------------------------------------------ viti M8
  const screwIn = (id, t0, dur, loose = 4) => {
    const sn = 'M8_' + id, wn = 'W_' + id;
    for (const n of [sn, wn]) {
      K(n, t0 - 0.01, { p: off(sn, 150), ease: 'step' });
      K(n, t0, { o: 0 }); K(n, t0 + 0.25, { o: 1, ease: 'linear' });
      K(n, t0 + dur * 0.45, { p: off(sn, 30), ease: 'out' });
      K(n, t0 + dur, { p: off(sn, loose), ease: 'inOut' });
      flash(n, t0, t0 + dur + 0.6, 1);
    }
    spinAcc[sn] = 0;
    K(sn, t0, { s: 0 });
    K(sn, t0 + dur, { s: 3 * TURN, ease: 'inOut' });
    spinAcc[sn] = 3 * TURN;
  };
  const tighten = (id, t0, dur) => {
    const sn = 'M8_' + id, wn = 'W_' + id;
    for (const n of [sn, wn]) {
      K(n, t0, { p: off(sn, 4) });
      K(n, t0 + dur, { p: [0, 0, 0], ease: 'inOut' });
      flash(n, t0, t0 + dur + 0.35, 1, 'h', 0.2);
    }
    K(sn, t0, { s: spinAcc[sn] });
    spinAcc[sn] += 1.5 * TURN;
    K(sn, t0 + dur, { s: spinAcc[sn], ease: 'inOut' });
  };
  const woodScrew = (n, t0, dur) => {
    K(n, t0 - 0.01, { p: off(n, 140), ease: 'step' });
    K(n, t0, { o: 0 }); K(n, t0 + 0.25, { o: 1, ease: 'linear' });
    K(n, t0 + dur * 0.4, { p: off(n, 24), ease: 'out' });
    K(n, t0 + dur, { p: [0, 0, 0], ease: 'inOut' });
    K(n, t0, { s: 0 }); K(n, t0 + dur, { s: 4 * TURN, ease: 'inOut' });
    flash(n, t0, t0 + dur + 0.6, 1);
  };

  // ------------------------------------------------------------------ PASSO 3
  const s3 = at('s3');
  screwIn('01', s3 + 1.8, 1.8);      // primo piano: giunto F1_L / T1_A
  screwIn('02', s3 + 2.3, 1.8);
  screwIn('03', s3 + 5.9, 1.4);      // F1_L / T1_B
  screwIn('04', s3 + 6.3, 1.4);
  screwIn('07', s3 + 6.9, 1.4);      // F1_R / T1_B
  screwIn('08', s3 + 7.3, 1.4);
  screwIn('05', s3 + 8.0, 1.4);      // F1_R / T1_A
  screwIn('06', s3 + 8.4, 1.4);

  // ------------------------------------------------------------------ PASSO 4
  const s4 = at('s4');
  const L2 = 1694, HALF = L2 / 2, Y2 = 25;
  const th0 = Math.acos((785 + 790) / L2);              // ~21.6°: estremita' A davanti all'asola di F1_R
  const t2pose = (th, bx) => {
    const ax = bx + L2 * Math.cos(th);                  // estremita' A (lato F1_R)
    const cx = ax - HALF * Math.cos(th), cy = Y2 + HALF * Math.sin(th);
    return { p: [cx, cy - Y2, 0], r: [0, 0, -th] };
  };
  const pre = t2pose(th0, -790);
  K('T2', s4 + 0.09, { p: [pre.p[0], pre.p[1] + 1100, 0], r: pre.r, ease: 'step' });
  K('T2', s4 + 0.1, { o: 0 }); K('T2', s4 + 0.5, { o: 1, ease: 'linear' });
  K('T2', s4 + 2.1, { p: pre.p, ease: 'outQuint' });
  K('T2', s4 + 2.4, { p: pre.p, r: pre.r });
  // inserimento: A entra a fondo in F1_R mentre l'estremita' B si abbassa davanti a F1_L
  const tA = s4 + 2.4, tB = s4 + 5.1, NS = 24;
  for (let i = 1; i <= NS; i++) {
    const u = i / NS, e = EASE.inOut(u);
    const ps = t2pose(th0 * (1 - e), -790 - 7 * e);
    K('T2', tA + (tB - tA) * u, { p: ps.p, r: ps.r, ease: 'linear' });
  }
  K('T2', s4 + 5.4, { p: t2pose(0, -797).p, r: [0, 0, 0] });
  K('T2', s4 + 6.8, { p: [0, 0, 0], ease: 'inOut' });           // spinto fino in fondo in F1_L
  K('T2', s4 + 0.1, { h: 0 }); K('T2', s4 + 0.4, { h: 1 });
  K('T2', s4 + 6.9, { h: 1 }); K('T2', s4 + 7.4, { h: 0 });
  K('HOLEMARK', 0, { o: 0 });
  K('HOLEMARK', s4 + 5.6, { o: 0 }); K('HOLEMARK', s4 + 6.0, { o: 1 });
  K('HOLEMARK', s4 + 7.2, { o: 1 }); K('HOLEMARK', s4 + 7.6, { o: 0 });
  screwIn('09', s4 + 7.0, 1.8);
  screwIn('10', s4 + 7.2, 1.8);

  // ------------------------------------------------------------------ PASSO 5
  const s5 = at('s5');
  ['01', '02', '03', '04', '07', '08', '05', '06', '09', '10'].forEach((id, i) => tighten(id, s5 + 0.6 + i * 0.42, 0.9));

  // ------------------------------------------------------------------ PASSO 6
  const s6 = at('s6');
  const FLIP = [PI, 0, 0];
  G('STRUCT', s6 + 0.3, { p: [0, 0, 0] });
  G('STRUCT', s6 + 2.8, { p: [0, 1050, 0] });
  G('STRUCT', s6 + 0.9, { r: [0, 0, 0] });
  G('STRUCT', s6 + 3.4, { r: FLIP });
  // il piano arriva capovolto (a faccia in giu') da dietro
  G('TOP', s6 + 2.39, { p: [0, 160, -1900], r: FLIP, ease: 'step' });
  K('P1', s6 + 2.4, { o: 0 }); K('P1', s6 + 2.9, { o: 1, ease: 'linear' });
  G('TOP', s6 + 4.8, { p: [0, 0, 0], ease: 'outQuint' });
  flash('P1', s6 + 2.4, s6 + 5.6);
  G('STRUCT', s6 + 5.0, { p: [0, 1050, 0] });
  G('STRUCT', s6 + 7.8, { p: [0, 0, 0], ease: 'inOut' });

  // ------------------------------------------------------------------ PASSO 7
  const s7 = at('s7');
  woodScrew('WS_1', s7 + 1.8, 2.0);  // primo piano
  ['WS_2', 'WS_3', 'WS_4', 'WS_5', 'WS_6'].forEach((n, i) => woodScrew(n, s7 + 5.6 + i * 0.55, 1.3));

  // ------------------------------------------------------------------ PASSO 8
  const s8 = at('s8');
  G('ASSEMBLY', s8 + 0.2, { p: [0, 0, 0] });
  G('ASSEMBLY', s8 + 1.6, { p: [0, 520, 0] });
  G('ASSEMBLY', s8 + 0.7, { r: [0, 0, 0] });
  G('ASSEMBLY', s8 + 3.2, { r: FLIP });
  G('ASSEMBLY', s8 + 2.4, { p: [0, 520, 0] });
  G('ASSEMBLY', s8 + 3.9, { p: [0, 0, 0], ease: 'inOut' });

  // ------------------------------------------------------------------ CAMERA
  // { t, target:[x,y,z] (mm), dist (mm), az (gradi, 0 = fronte +Z, 90 = lato +X), el (gradi), fov }
  const camera = [
    { t: 0, target: [0, 330, 0], dist: 4300, az: 54, el: 19, fov: 30 },
    { t: at('intro', 4.5), target: [0, 330, 0], dist: 4500, az: 40, el: 21, fov: 30 },
    { t: at('kit', 2.6), target: [0, 470, 60], dist: 6900, az: 33, el: 22, fov: 30 },
    { t: at('kit', 8.0), target: [0, 470, 60], dist: 6900, az: 27, el: 22, fov: 30 },
    { t: at('s1', 1.4), target: [120, 330, 0], dist: 4700, az: 32, el: 23, fov: 30 },
    { t: at('s1', 5.5), target: [120, 330, 0], dist: 4600, az: 36, el: 23, fov: 30 },
    // passo 2: primo piano dell'asola del montante (vista dall'interno, come nel manuale)
    { t: at('s2', 2.5), target: [-760, 640, 340], dist: 1200, az: 124, el: 22, fov: 30 },
    { t: at('s2', 5.4), target: [-770, 642, 340], dist: 1120, az: 130, el: 22, fov: 30 },
    { t: at('s2', 7.2), target: [100, 360, 0], dist: 4300, az: 30, el: 26, fov: 30 },
    { t: at('s2', 11), target: [0, 360, 0], dist: 4200, az: 36, el: 26, fov: 30 },
    // passo 3: primo piano viti sulla faccia interna del montante
    { t: at('s3', 1.9), target: [-848, 655, 350], dist: 640, az: 150, el: 14, fov: 30 },
    { t: at('s3', 5.0), target: [-848, 655, 350], dist: 610, az: 154, el: 14, fov: 30 },
    { t: at('s3', 6.4), target: [0, 400, 0], dist: 3700, az: 45, el: 30, fov: 30 },
    { t: at('s3', 9.9), target: [0, 400, 0], dist: 3700, az: 118, el: 30, fov: 30 },
    // passo 4
    { t: at('s4', 1.9), target: [0, 300, 0], dist: 3400, az: 20, el: 16, fov: 30 },
    { t: at('s4', 4.6), target: [0, 300, 0], dist: 3300, az: 14, el: 16, fov: 30 },
    { t: at('s4', 6.2), target: [-815, 45, 0], dist: 780, az: 55, el: 30, fov: 30 },
    { t: at('s4', 9.4), target: [-815, 45, 0], dist: 760, az: 60, el: 30, fov: 30 },
    { t: at('s4', 11.5), target: [0, 330, 0], dist: 4000, az: 35, el: 26, fov: 30 },
    // passo 5
    { t: at('s5', 6), target: [0, 330, 0], dist: 3900, az: 45, el: 26, fov: 30 },
    // passo 6
    { t: at('s6', 1.8), target: [0, 820, 0], dist: 6300, az: 32, el: 18, fov: 30 },
    { t: at('s6', 5.0), target: [0, 720, 0], dist: 6100, az: 28, el: 20, fov: 30 },
    { t: at('s6', 8.2), target: [0, 250, 0], dist: 4300, az: 40, el: 36, fov: 30 },
    { t: at('s6', 10), target: [0, 250, 0], dist: 4200, az: 44, el: 36, fov: 30 },
    // passo 7: primo piano angolare + vite da legno
    { t: at('s7', 1.7), target: [-755, 60, 330], dist: 580, az: 140, el: 42, fov: 30 },
    { t: at('s7', 4.4), target: [-755, 60, 330], dist: 560, az: 146, el: 42, fov: 30 },
    { t: at('s7', 6.0), target: [0, 150, 0], dist: 3700, az: 30, el: 52, fov: 30 },
    { t: at('s7', 10), target: [0, 150, 0], dist: 3700, az: 38, el: 52, fov: 30 },
    // passo 8: ribaltamento e giro finale
    { t: at('s8', 1.6), target: [0, 650, 0], dist: 5700, az: 30, el: 18, fov: 30 },
    { t: at('s8', 4.2), target: [0, 330, 0], dist: 4400, az: 25, el: 22, fov: 30 },
    { t: at('s8', 12), target: [0, 330, 0], dist: 4400, az: 125, el: 22, fov: 30 },
    { t: DURATION, target: [0, 330, 0], dist: 4400, az: 140, el: 22, fov: 30 },
  ];

  // ------------------------------------------------------------------ OVERLAY
  const labels = [
    { code: 'F1', name: 'Fianchi', qty: '×2', part: 'F1_R', point: [850, 750, 400], dx: 70, dy: -70 },
    { code: 'T1', name: 'Traversi superiori', qty: '×2', part: 'T1_A', point: [-450, 698, 374], dx: -90, dy: -95 },
    { code: 'T2', name: 'Traverso inferiore', qty: '×1', part: 'T2', point: [350, 35, 20], dx: 60, dy: 70 },
    { code: 'P1', name: 'Piano a doghe', qty: '×1', part: 'P1', point: [-600, 750, -400], dx: -80, dy: -80 },
  ].map((l, i) => ({ ...l, t0: at('kit', 2.5 + i * 0.25), t1: at('kit', 7.7) }));

  const hardware = {
    t0: at('kit', 2.4), t1: at('kit', 8.1),
    rows: [
      { img: 'img-001.png', name: 'Vite inox M8×20 con flangia', qty: '×10' },
      { img: 'img-003.png', name: 'Rondella in nylon 17×2×8,1', qty: '×10' },
      { img: 'img-002.png', name: 'Vite da legno inox 4×20', qty: '×6' },
    ],
  };

  const tags = [
    { text: 'M8 ×2', part: 'F1_L', point: [-848, 690, 350], dx: 40, dy: -70, t0: at('s3', 2.6), t1: at('s3', 5.2) },
    { text: 'M8 ×2', part: 'F1_L', point: [-835, 56, 0], dx: 50, dy: -80, t0: at('s4', 7.6), t1: at('s4', 9.8) },
    { text: '×10', part: 'T2', point: [0, 35, 0], dx: 0, dy: -60, t0: at('s5', 0.6), t1: at('s5', 5.6), center: true },
    { text: '4×20 ×6', part: 'T1_B', point: [-755, 700, -330], dx: 50, dy: -80, t0: at('s7', 2.4), t1: at('s7', 4.8) },
  ];

  return {
    fps: FPS, duration: DURATION, steps: STEPS, tracks, groups, camera,
    overlay: {
      intro: { t0: 0, t1: at('intro', 4.2) },
      labels, hardware, tags,
      endcard: { t0: at('end'), t1: DURATION + 1 },
      captionsFrom: at('kit', 0.3),
      captionsTo: at('end', 0.2),
    },
  };
}
