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
  { id: 's1', n: 1, dur: 5.5, title: 'Posizionare i due fianchi (F1) in maniera speculare', body: 'Con le asole dei montanti rivolte verso l’interno' },
  { id: 's2', n: 2, dur: 11, title: 'Inserire i traversi superiori (T1) nelle asole dei fianchi', body: 'Angolari di fissaggio rivolti verso l’interno' },
  { id: 's3', n: 3, dur: 10, title: 'Avvitare le viti M8 con rondella in nylon', body: 'Senza serrarle — 4 viti per traverso' },
  { id: 's4', n: 4, dur: 12.5, title: 'Inserire il traverso inferiore (T2)', body: 'Spingerlo fino in fondo e usare il foro più interno' },
  { id: 's5', n: 5, dur: 7.5, title: 'Serrare tutte le 10 viti', body: 'La struttura in alluminio è completa' },
  { id: 's6', n: 6, dur: 10, title: 'Posizionare la struttura capovolta sul piano a doghe (P1)', body: 'Allineare al meglio piano e struttura' },
  { id: 's7', n: 7, dur: 10, title: 'Fissare il piano con le 6 viti da legno', body: 'Nelle asole degli angolari dei traversi T1' },
  { id: 's8', n: 8, dur: 4, title: 'Capovolgere il tavolo', body: 'Girarlo e appoggiarlo a terra' },
  // senza numero: badge con la spunta, barra di avanzamento piena
  { id: 'done', icon: 'check', dur: 8, title: 'Montaggio completato', body: 'Stesso procedimento per Panca Gradisca e Panca Volpina' },
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
 * @param {object} model  { axes: {name: [x,y,z]}, joints }
 *   axes   — assi di avvitamento della minuteria (userData.axis)
 *   joints — punti notevoli in coordinate di montaggio (JOINTS di parts.js): target delle
 *            inquadrature ravvicinate e delle etichette
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
  // prima si allontanano i fianchi, poi (quando le estremita' sono uscite dalle asole) i traversi
  for (const [n, p] of Object.entries(EX)) {
    const [a, b] = n.startsWith('F1') ? [0.2, 2.0] : [0.9, 2.6];
    K(n, k0 + a, { p: [0, 0, 0] }); K(n, k0 + b, { p });
  }
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
  flash('F1_L', s1 + 0.1, s1 + 3.3);
  flash('F1_R', s1 + 0.4, s1 + 3.5);
  K('MIRROR', 0, { o: 0 });
  K('MIRROR', s1 + 2.6, { o: 0 }); K('MIRROR', s1 + 3.1, { o: 1 });
  K('MIRROR', s1 + 4.9, { o: 1 }); K('MIRROR', s1 + 5.4, { o: 0 });

  // ------------------------------------------------------------------ PASSO 2
  const s2 = at('s2');
  // i T1 arrivano in campo largo, poi la camera va in primo piano sull'asola
  for (const [n, sz, d] of [['T1_A', 1, 0], ['T1_B', -1, 0.25]]) {
    K(n, s2 + d - 0.01, { p: [100, 700, sz * 500], ease: 'step' });
    K(n, s2 + d, { o: 0 }); K(n, s2 + d + 0.45, { o: 1, ease: 'linear' });
    K(n, s2 + d + 2.1, { p: [100, 0, 0], ease: 'outQuint' });   // pre-inserimento davanti alle asole di F1_L
    K(n, s2 + 3.6, { p: [100, 0, 0] });
    K(n, s2 + 6.0, { p: [0, 0, 0], ease: 'inOut' });            // dentro le asole
    K(n, s2 + d, { h: 0 }); K(n, s2 + d + 0.3, { h: 0.85 });
    K(n, s2 + 3.4, { h: 0.85 }); K(n, s2 + 3.8, { h: 0.2 });
    K(n, s2 + 6.0, { h: 0.2 }); K(n, s2 + 6.5, { h: 0 });
    flash(n, s2 + 3.4, s2 + 6.6, 1, 'hb', 0.4);                  // angolari verso l'interno
  }
  K('F1_R', s2 + 7.4, { p: [RGAP, 0, 0] });
  K('F1_R', s2 + 9.6, { p: [0, 0, 0], ease: 'inOut' });          // il secondo fianco si accosta
  flash('F1_R', s2 + 7.1, s2 + 10.1);

  // ------------------------------------------------------------------ viti M8
  // "senza serrarle": la vite resta fuori di LOOSE mm (rondella staccata, gambo visibile)
  const LOOSE = 11;
  const screwIn = (id, t0, dur, loose = LOOSE) => {
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
      K(n, t0, { p: off(sn, LOOSE) });
      K(n, t0 + dur, { p: [0, 0, 0], ease: 'inOut' });
      flash(n, t0, t0 + dur + 0.35, 1, 'h', 0.2);
    }
    K(sn, t0, { s: spinAcc[sn] });
    spinAcc[sn] += 2.5 * TURN;
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
  screwIn('01', s3 + 1.2, 1.8);      // primo piano: giunto F1_L / T1_A
  screwIn('02', s3 + 1.7, 1.8);
  screwIn('03', s3 + 5.8, 1.4);      // campo largo: F1_L / T1_B
  screwIn('04', s3 + 6.2, 1.4);
  screwIn('07', s3 + 6.8, 1.4);      // F1_R / T1_B
  screwIn('08', s3 + 7.2, 1.4);
  screwIn('05', s3 + 7.9, 1.4);      // F1_R / T1_A
  screwIn('06', s3 + 8.3, 1.4);

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
  K('T2', s4 + 0.69, { p: [pre.p[0], pre.p[1] + 1100, 0], r: pre.r, ease: 'step' });
  K('T2', s4 + 0.7, { o: 0 }); K('T2', s4 + 1.1, { o: 1, ease: 'linear' });
  K('T2', s4 + 2.7, { p: pre.p, ease: 'outQuint' });
  K('T2', s4 + 2.9, { p: pre.p, r: pre.r });
  // inserimento: A entra a fondo in F1_R mentre l'estremita' B si abbassa davanti a F1_L
  const tA = s4 + 2.9, tB = s4 + 5.4, NS = 24;
  for (let i = 1; i <= NS; i++) {
    const u = i / NS, e = EASE.inOut(u);
    const ps = t2pose(th0 * (1 - e), -790 - 7 * e);
    K('T2', tA + (tB - tA) * u, { p: ps.p, r: ps.r, ease: 'linear' });
  }
  // spinto fino in fondo in F1_L, a camera ferma sul primo piano (stacco a s4+5.7)
  K('T2', s4 + 6.3, { p: t2pose(0, -797).p, r: [0, 0, 0] });
  K('T2', s4 + 7.5, { p: [0, 0, 0], ease: 'inOut' });
  K('T2', s4 + 0.7, { h: 0 }); K('T2', s4 + 1.0, { h: 1 });
  K('T2', s4 + 7.6, { h: 1 }); K('T2', s4 + 8.1, { h: 0 });
  K('HOLEMARK', 0, { o: 0 });
  K('HOLEMARK', s4 + 7.5, { o: 0 }); K('HOLEMARK', s4 + 7.9, { o: 1 });
  K('HOLEMARK', s4 + 8.9, { o: 1 }); K('HOLEMARK', s4 + 9.3, { o: 0 });
  screwIn('09', s4 + 8.3, 1.8);      // primo piano: 1 vite nel foro piu' interno
  screwIn('10', s4 + 10.9, 1.3);     // lato F1_R, in campo largo dopo lo stacco

  // ------------------------------------------------------------------ PASSO 5
  const s5 = at('s5');
  tighten('01', s5 + 0.6, 1.1);      // primo piano sul giunto del passo 3: la rondella va in battuta
  tighten('02', s5 + 1.0, 1.1);
  ['03', '04', '07', '08', '05', '06', '09', '10'].forEach((id, i) => tighten(id, s5 + 2.9 + i * 0.45, 0.9));

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
  // { t, target:[x,y,z] (mm), dist (mm), az (gradi, 0 = fronte +Z, 90 = lato +X), el (gradi), fov,
  //   sx/sy = decentramento ottico in frazioni del fotogramma (sy>0 alza il soggetto),
  //   cut  = questo keyframe apre una nuova inquadratura (stacco) con dissolvenza incrociata
  //          di 0.4 s (true) o della durata indicata in secondi (0 = stacco netto) }
  // Regola: tra campo largo e primo piano SEMPRE uno stacco; i movimenti continui restano
  // lenti (pochi gradi al secondo) cosi' non ci sono "frustate" della camera.
  const J = model.joints;
  const flipped = (p) => [p[0], 750 - p[1], -p[2]];   // capovolgimento attorno all'asse X (perno y = 375)
  const SLOT = J.slotT1_L_front, SCREWS = J.holesT1_L_front, HOLE = J.holeT2_L_inner;
  const BRACKET = flipped(J.bracket_L_back);
  const WIDE = { sy: 0.125 };
  // primo piano delle viti M8 01-02 (passi 3 e 5): camera bassa dall'interno del tavolo,
  // altrimenti il traverso alto del fianco nasconde le viti
  const SCREW_CU = { target: [SCREWS[0] + 25, SCREWS[1] - 6, SCREWS[2]], el: 8, sy: 0.1 };
  const HOLE_CU = { target: [HOLE[0] + 20, HOLE[1], HOLE[2] + 30], el: 42, sy: 0.1 };
  const camera = [
    { t: 0, target: [0, 330, 0], dist: 4300, az: 54, el: 19 },
    { t: at('intro', 4.5), target: [0, 330, 0], dist: 4500, az: 40, el: 21 },
    // esploso: soggetto spostato a sinistra (sx) per lasciare spazio al riquadro ferramenta
    { t: at('kit', 2.6), target: [0, 470, 60], dist: 7800, az: 33, el: 22, sx: 0.12, sy: 0.05 },
    { t: at('kit', 8.0), target: [0, 470, 60], dist: 7800, az: 28, el: 22, sx: 0.12, sy: 0.05 },
    { t: at('s1', 1.4), target: [150, 330, 0], dist: 4500, az: 32, el: 23, ...WIDE },
    { t: at('s1', 5.5), target: [150, 340, 0], dist: 4600, az: 35, el: 24, ...WIDE },
    // passo 2: i T1 arrivano in campo largo ...
    { t: at('s2', 2.9), target: [130, 370, 0], dist: 4700, az: 38, el: 25, ...WIDE },
    // ... stacco sul primo piano dell'asola (vista dall'interno, come img-009) ...
    { t: at('s2', 3.0), cut: true, target: [SLOT[0] + 20, SLOT[1] - 20, SLOT[2] - 10], dist: 640, az: 124, el: 22, sy: 0.1 },
    { t: at('s2', 6.7), target: [SLOT[0] + 20, SLOT[1] - 20, SLOT[2] - 10], dist: 610, az: 129, el: 22, sy: 0.1 },
    // ... stacco sul campo largo: il secondo fianco si accosta
    { t: at('s2', 6.8), cut: true, target: [160, 360, 0], dist: 4700, az: 33, el: 26, ...WIDE },
    { t: at('s2', 11), target: [100, 360, 0], dist: 4650, az: 38, el: 26, ...WIDE },
    // passo 3: primo piano viti sulla faccia interna del montante, poi campo largo
    { t: at('s3', 0), cut: true, ...SCREW_CU, dist: 640, az: 137 },
    { t: at('s3', 4.9), ...SCREW_CU, dist: 615, az: 141 },
    { t: at('s3', 5.0), cut: true, target: [60, 370, 0], dist: 4600, az: 64, el: 28, ...WIDE, sy: 0.105 },
    { t: at('s3', 10), target: [120, 350, 0], dist: 4500, az: 47, el: 26, ...WIDE, sy: 0.105 },
    // passo 4: campo largo che prosegue lento; asola di F1_R ben in vista
    { t: at('s4', 2.4), target: [300, 330, 0], dist: 4250, az: 38, el: 24, ...WIDE, sy: 0.1 },
    { t: at('s4', 5.6), target: [300, 330, 0], dist: 4150, az: 35, el: 24, ...WIDE, sy: 0.1 },
    // stacco sul foro: dall'alto i due fori (20 mm) si separano e si vede T2 entrare a fondo
    { t: at('s4', 5.7), cut: true, ...HOLE_CU, dist: 600, az: 40 },
    { t: at('s4', 10.3), ...HOLE_CU, dist: 570, az: 45 },
    { t: at('s4', 10.4), cut: true, target: [0, 330, 0], dist: 4500, az: 40, el: 27, ...WIDE },
    { t: at('s4', 12.5), target: [0, 330, 0], dist: 4500, az: 43, el: 27, ...WIDE },
    // passo 5: primo piano sul giunto del passo 3 (si vede la vite andare in battuta), poi campo largo
    { t: at('s5', 0), cut: true, ...SCREW_CU, dist: 640, az: 137 },
    { t: at('s5', 2.3), ...SCREW_CU, dist: 625, az: 139 },
    { t: at('s5', 2.4), cut: true, target: [0, 330, 0], dist: 4500, az: 40, el: 27, ...WIDE },
    { t: at('s5', 7.5), target: [0, 330, 0], dist: 4500, az: 47, el: 27, ...WIDE },
    // passo 6
    { t: at('s6', 1.8), target: [0, 980, 0], dist: 6700, az: 34, el: 16, ...WIDE },
    { t: at('s6', 5.0), target: [0, 900, 0], dist: 6600, az: 30, el: 18, ...WIDE },
    { t: at('s6', 8.2), target: [0, 170, 0], dist: 5300, az: 40, el: 32, sy: 0.075 },
    { t: at('s6', 10), target: [0, 170, 0], dist: 5300, az: 44, el: 32, sy: 0.075 },
    // passo 7: primo piano angolare + vite da legno (img-013), poi campo largo
    { t: at('s7', 0), cut: true, target: BRACKET, dist: 580, az: 140, el: 42, sy: 0.1 },
    { t: at('s7', 4.5), target: BRACKET, dist: 560, az: 146, el: 42, sy: 0.1 },
    { t: at('s7', 4.6), cut: true, target: [0, 360, 0], dist: 4700, az: 30, el: 44, ...WIDE },
    { t: at('s7', 10), target: [0, 360, 0], dist: 4700, az: 37, el: 44, ...WIDE },
    // passo 8: ribaltamento e giro finale
    { t: at('s8', 1.6), target: [0, 700, 0], dist: 5500, az: 30, el: 18, ...WIDE },
    { t: at('s8', 4.2), target: [0, 330, 0], dist: 4700, az: 25, el: 22, sy: 0.14 },
    { t: at('done', 8), target: [0, 330, 0], dist: 4700, az: 125, el: 22, sy: 0.14 },
    { t: DURATION, target: [0, 330, 0], dist: 4700, az: 140, el: 22, sy: 0.14 },
  ].map((k) => ({ fov: 30, sx: 0, sy: 0.085, ...k }));

  // ------------------------------------------------------------------ OVERLAY
  const labels = [
    { code: 'P1', name: 'Piano a doghe', qty: '×1', part: 'P1', point: [-800, 750, -400], dx: -60, dy: -30 },
    { code: 'T1', name: 'Traversi superiori', qty: '×2', part: 'T1_A', point: [-560, J.slotT1_L_front[1] - 8, 374], dx: -90, dy: 60 },
    { code: 'F1', name: 'Fianchi', qty: '×2', part: 'F1_R', point: [900, 420, 400], dx: 80, dy: 30 },
    { code: 'T2', name: 'Traverso inferiore', qty: '×1', part: 'T2', point: [560, 35, 20], dx: 80, dy: 50 },
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
    { text: 'M8 ×2', part: 'F1_L', point: [SCREWS[0], SCREWS[1] + 32, SCREWS[2]], dx: 40, dy: -70, t0: at('s3', 2.0), t1: at('s3', 4.8) },
    // T2: UNA vite per lato (10 viti in tutto)
    { text: 'M8 ×1 per lato', part: 'F1_L', point: [HOLE[0], HOLE[1] + 6, HOLE[2]], dx: 70, dy: -110, t0: at('s4', 8.6), t1: at('s4', 10.3) },
    { text: '×10', part: 'T2', point: [0, 35, 0], dx: 0, dy: -60, t0: at('s5', 2.7), t1: at('s5', 7.2), center: true },
    { text: '4×20 ×6', part: 'T1_B', point: [J.bracket_L_back[0], J.bracket_L_back[1] + 2, J.bracket_L_back[2]], dx: 110, dy: -130, t0: at('s7', 2.4), t1: at('s7', 4.5) },
  ];

  return {
    fps: FPS, duration: DURATION, steps: STEPS, tracks, groups, camera,
    overlay: {
      intro: { t0: 0, t1: at('intro', 4.2) },
      labels, hardware, tags,
      endcard: { t0: at('end'), t1: DURATION + 1 },
      captionsFrom: at('kit', 0.3),
      brandFrom: at('s1', 0),
      captionsTo: at('end', 0.2),
    },
  };
}
