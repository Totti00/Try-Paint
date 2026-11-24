// test/test-video.js — prove del modulo video (import 3D, viste delle parti, video con immagini, video 3D).
// Uso:  node test/test-video.js            (tutte le prove, ~3-4 min su 4 CPU senza GPU)
//       node test/test-video.js immagini 3d step    (solo alcune)
// Variabili: VIDEO_TEST_DIR = cartella di lavoro (predefinita: <tmp>/strumento-manuali/test-video)
//            REBUILD_FIXTURES=1 rigenera test/fixtures/tavolo-levante/tavolo-parametrico.glb dal
//            modello parametrico di ../manuale-tavolo-levante/video/src/parts.js
// Esce con codice 1 se una verifica fallisce. Stampa i percorsi dei provini (contact sheet) da guardare.

import { promises as fsp, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ManualData, AnimationPlan } from '../src/schema.js';
import { importModel, renderPartViews } from '../src/video/model3d.js';
import { renderVideo, renderStills } from '../src/video/render.js';
import { startServer, standardMounts } from '../src/video/server.js';
import { launchBrowser, openPage, probeVideo, runFfmpeg } from '../src/video/browser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIX = path.join(HERE, 'fixtures');
const REF = path.resolve(ROOT, '..', 'manuale-tavolo-levante');
const OUT = path.resolve(process.env.VIDEO_TEST_DIR || path.join(os.tmpdir(), 'strumento-manuali', 'test-video'));
const only = process.argv.slice(2);
const want = (name) => !only.length || only.includes(name);

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  ok   ' + msg);
  else { failures++; console.log('  FAIL ' + msg); }
};
const section = (s) => console.log('\n== ' + s);
const quietLog = (s) => { if (!/willReadFrequently|GLTFExporter: Use MeshStandardMaterial|normalized normal attribute/.test(s)) console.log('    ' + s); };
const progressPrinter = (label) => {
  let last = 0;
  return (pct, msg) => { if (Date.now() - last > 4000 || pct >= 100) { last = Date.now(); console.log(`    [${label}] ${pct}% ${msg || ''}`); } };
};

/** fotogrammi ai tempi indicati + provino a griglia (ffmpeg-static) */
async function contactSheet(video, times, outPng, cols = 4) {
  const dir = outPng.replace(/\.png$/, '') + '_frames';
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < times.length; i++) {
    const f = path.join(dir, `k_${String(i).padStart(3, '0')}.png`);
    const r = await runFfmpeg(['-v', 'error', '-y', '-ss', times[i].toFixed(2), '-i', video, '-frames:v', '1', '-vf', 'scale=480:-2', f]);
    if (r.code === 0 && existsSync(f)) files.push(f);
  }
  const rows = Math.ceil(files.length / cols);
  const r = await runFfmpeg(['-v', 'error', '-y', '-framerate', '1', '-i', path.join(dir, 'k_%03d.png'),
    '-vf', `tile=${cols}x${rows}:padding=4:margin=4:color=0x22201E`, '-frames:v', '1', outPng]);
  return { sheet: r.code === 0 ? outPng : null, frames: files };
}

/** deviazione standard media di un'immagine (0 = tinta unita) */
async function imageStdev(file) {
  const st = await sharp(file).stats();
  return st.channels.slice(0, 3).reduce((n, c) => n + c.stdev, 0) / 3;
}

const IMAGE_MAP = {
  img_00: 'copertina_tavolo_panche', img_01: 'ferr_vite_m8', img_02: 'ferr_vite_legno', img_03: 'ferr_rondella',
  img_04: 'comp_F1_fianchi', img_05: 'comp_T1_traversi_sup', img_06: 'comp_T2_traverso_inf', img_07: 'comp_P1_piano',
  img_08: 'comp_F1_fianchi', img_09: 'passo2_inserimento_T1', img_10: 'passo3_viti_T1', img_11: 'passo5_struttura',
  img_12: 'passo6_struttura_su_piano', img_13: 'passo7_viti_legno', img_14: 'logo_ramberti_group',
};

async function prepareImagesJob(dir) {
  const src = path.join(REF, 'assets', 'final');
  if (!existsSync(src)) return false;
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(path.join(dir, 'immagini', 'final'), { recursive: true });
  for (const [id, name] of Object.entries(IMAGE_MAP)) await fsp.copyFile(path.join(src, name + '.png'), path.join(dir, 'immagini', 'final', id + '.png'));
  return true;
}

// ------------------------------------------------------------------------------------------ (a)
async function testImmagini() {
  section('(a) Video con immagini (anteprima) — Tavolo Levante');
  const job = path.join(OUT, 'job-immagini');
  if (!(await prepareImagesJob(job))) { console.log('  SKIP immagini di riferimento non trovate in ' + path.join(REF, 'assets', 'final')); return; }
  const manual = JSON.parse(readFileSync(path.join(FIX, 'tavolo-levante', 'manual.json'), 'utf8'));
  ok(ManualData.safeParse(manual).success, 'manual.json valido (ManualData)');
  await fsp.writeFile(path.join(job, 'manual.json'), JSON.stringify(manual, null, 2));
  const t0 = Date.now();
  const r = await renderVideo(job, { mode: 'immagini', manual, quality: 'anteprima', onProgress: progressPrinter('immagini'), log: quietLog });
  console.log(`    reso in ${((Date.now() - t0) / 1000).toFixed(0)} s con ${r.workers} pagine`);
  ok(existsSync(r.videoPath) && r.videoPath === path.join(job, 'out', 'video.mp4'), 'out/video.mp4 scritto');
  ok(existsSync(r.posterPath), 'out/poster.jpg scritto');
  const info = await probeVideo(r.videoPath);
  console.log(`    ffmpeg: ${info.codec} ${info.width}x${info.height} ${info.fps} fps, ${info.duration.toFixed(2)} s (atteso ${r.duration.toFixed(2)} s)`);
  ok(info.codec === 'h264' && info.width === 960 && info.height === 540 && Math.round(info.fps) === 15, 'H.264 960×540 a 15 fps');
  ok(Math.abs(info.duration - r.duration) < 0.25, 'durata del file coerente con la timeline');
  ok(r.duration > 45 && r.duration < 120, `durata ragionevole per 7 passi (${r.duration.toFixed(1)} s)`);
  const steps = r.chapters.filter((c) => c.kind === 'step');
  ok(steps.length === manual.steps.length, `un capitolo per passo (${steps.length})`);
  ok(steps.every((c) => c.t1 - c.t0 >= 4 && c.t1 - c.t0 <= 9.01), 'ogni passo dura 4–9 s');
  const times = [1.5, 3.5, ...r.chapters.slice(1).map((c) => Math.min(r.duration - 0.1, c.t0 + (c.t1 - c.t0) * 0.6))];
  const { sheet, frames } = await contactSheet(r.videoPath, times, path.join(OUT, 'provino-immagini.png'), 4);
  const sd = await Promise.all(frames.map(imageStdev));
  ok(sd.every((v) => v > 6), 'nessun fotogramma vuoto (tinta unita)');
  console.log('    PROVINO: ' + sheet);
}

async function testImmaginiStress() {
  section('(a2) Video con immagini — manuale "stress" (passi senza immagini, 3–4 immagini, testi lunghi, niente copertina/logo)');
  const file = path.join(FIX, 'stress', 'manual.json');
  if (!existsSync(file)) { console.log('  SKIP fixture stress assente'); return; }
  const job = path.join(OUT, 'job-immagini-stress');
  if (!(await prepareImagesJob(job))) { console.log('  SKIP immagini di riferimento non trovate'); return; }
  const manual = JSON.parse(readFileSync(file, 'utf8'));
  const r = await renderVideo(job, { mode: 'immagini', manual, quality: 'anteprima', onProgress: progressPrinter('stress'), log: quietLog });
  const info = await probeVideo(r.videoPath);
  ok(Math.abs(info.duration - r.duration) < 0.25, `video stress reso (${info.duration.toFixed(1)} s)`);
  const times = r.chapters.map((c) => Math.min(r.duration - 0.1, c.t0 + (c.t1 - c.t0) * 0.55));
  const { sheet } = await contactSheet(r.videoPath, times, path.join(OUT, 'provino-immagini-stress.png'), 5);
  console.log('    PROVINO: ' + sheet);
}

// ------------------------------------------------------------------------------------------ (b)
async function exportParametricGlb(dest) {
  const src = path.join(REF, 'video', 'src');
  if (!existsSync(path.join(src, 'parts.js'))) throw new Error('modello parametrico non trovato: ' + src);
  const server = await startServer({
    mounts: [...standardMounts(), { prefix: '/ref/', dir: src }],
    upload: { dir: path.dirname(dest), allow: (n) => n === path.basename(dest) },
  });
  const browser = await launchBrowser();
  try {
    const { page } = await openPage(browser, server.base + '/engine/import.html', { log: quietLog });
    await page.addScriptTag({ type: 'module', content: `
      import * as THREE from 'three';
      import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
      import { buildParametricModel } from '/ref/parts.js';
      window.__exp = (async () => {
        const { parts } = buildParametricModel(THREE);
        const root = new THREE.Group(); root.name = 'TavoloLevante';
        for (const o of Object.values(parts)) root.add(o);       // nodi con nome: F1_L, F1_R, T1_A, ..., WS_6
        const glb = await new GLTFExporter().parseAsync(root, { binary: true });
        const r = await fetch('/__upload/${path.basename(dest)}', { method: 'PUT', body: new Blob([glb]) });
        return { status: r.status, names: Object.keys(parts) };
      })();` });
    await page.waitForFunction(() => window.__exp, null, { timeout: 60000 });
    return await page.evaluate(() => window.__exp);
  } finally {
    await browser.close();
    await server.close();
  }
}

const EXPECTED_KEYS = {
  F1_L: 'p01', F1_R: 'p02', T1_A: 'p03', T1_B: 'p04', T2: 'p05', P1: 'p06', M8_01: 'p07', W_01: 'p08', M8_02: 'p09', W_02: 'p10',
  M8_09: 'p23', W_09: 'p24', M8_10: 'p25', W_10: 'p26', WS_1: 'p27', WS_6: 'p32',
};

async function test3d() {
  section('(b) Modello parametrico -> GLB -> importModel -> video 3D (anteprima)');
  const glbFix = path.join(FIX, 'tavolo-levante', 'tavolo-parametrico.glb');
  if (!existsSync(glbFix) || process.env.REBUILD_FIXTURES) {
    const r = await exportParametricGlb(glbFix);
    ok(r.status === 200 && r.names.length === 32, `GLB esportato dal modello parametrico (${r.names.length} nodi)`);
  } else console.log('  (uso la fixture esistente; REBUILD_FIXTURES=1 per rigenerarla)');
  ok(existsSync(glbFix), 'fixture tavolo-parametrico.glb presente');

  const job = path.join(OUT, 'job-3d');
  await fsp.rm(job, { recursive: true, force: true });
  await fsp.mkdir(path.join(job, 'modello'), { recursive: true });
  const model = path.join(job, 'modello', 'tavolo-parametrico.glb');
  await fsp.copyFile(glbFix, model);
  const t0 = Date.now();
  const imp = await importModel(job, model, progressPrinter('import'), { log: quietLog });
  console.log(`    import in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${imp.meta.part_count} parti, ${imp.meta.group_count} gruppi, asse ${imp.meta.up_axis_in_source} (${imp.meta.up_axis_reason})`);
  ok(imp.parts.length === 32, '32 parti (un nodo per parte)');
  const byName = Object.fromEntries(imp.parts.map((p) => [p.name, p]));
  ok(Object.entries(EXPECTED_KEYS).every(([n, k]) => byName[n] && byName[n].key === k), 'chiavi stabili (F1_L=p01 … WS_6=p32) come nel piano di prova');
  ok(byName.M8_01.similar_group === byName.M8_10.similar_group && imp.parts.filter((p) => p.similar_group === byName.M8_01.similar_group).length === 10, '10 viti M8 nello stesso gruppo');
  ok(imp.parts.filter((p) => p.similar_group === byName.WS_1.similar_group).length === 6, '6 viti da legno nello stesso gruppo');
  ok(imp.meta.up_axis_in_source === 'y', 'GLB: Y in alto');
  const tot = imp.meta.size_mm;
  ok(Math.abs(tot[0] - 1800) < 2 && Math.abs(tot[1] - 750) < 2 && Math.abs(tot[2] - 800) < 2, `dimensioni in mm conservate (${tot.join(' × ')})`);
  ok(imp.parts.every((p) => p.bbox_min[1] >= -0.1) && Math.min(...imp.parts.map((p) => p.bbox_min[1])) < 0.1, 'modello appoggiato a y = 0');
  const pj = JSON.parse(readFileSync(path.join(job, 'parts.json'), 'utf8'));
  ok(Array.isArray(pj) && pj[0].key && pj[0].bbox_min && pj[0].size && pj[0].center && typeof pj[0].triangles === 'number' && pj[0].similar_group, 'parts.json = PartsSummary (array)');

  const views = await renderPartViews(job, imp.parts, { max: 24 });
  ok(views.length === 8 && views.every((v) => existsSync(v.path)), `viste delle parti: ${views.length} (insieme + 7 gruppi)`);
  console.log('    VISTE: ' + views.map((v) => v.label).join(' | '));
  await sheetOfImages(views.map((v) => v.path), path.join(OUT, 'viste-tavolo.png'), 3);
  console.log('    PROVINO VISTE: ' + path.join(OUT, 'viste-tavolo.png'));

  const plan = JSON.parse(readFileSync(path.join(FIX, 'tavolo-levante', 'plan.json'), 'utf8'));
  ok(AnimationPlan.safeParse(plan).success, 'plan.json valido (AnimationPlan)');
  ok(plan.steps.length === 7, 'il piano rispecchia i 7 passi del manuale');
  const manual = JSON.parse(readFileSync(path.join(FIX, 'tavolo-levante', 'manual.json'), 'utf8'));
  // immagini per il riquadro ferramenta e il logo finale
  await prepareImagesJob(path.join(OUT, 'tmp-img')).then(async (done) => {
    if (done) await fsp.cp(path.join(OUT, 'tmp-img', 'immagini'), path.join(job, 'immagini'), { recursive: true });
  });
  const t1 = Date.now();
  const r = await renderVideo(job, { mode: '3d', manual, plan, quality: 'anteprima', onProgress: progressPrinter('3d'), log: quietLog });
  console.log(`    reso in ${((Date.now() - t1) / 1000).toFixed(0)} s con ${r.workers} pagine (${(1000 * r.renderSeconds / r.frames).toFixed(0)} ms/fotogramma)`);
  const info = await probeVideo(r.videoPath);
  console.log(`    ffmpeg: ${info.codec} ${info.width}x${info.height} ${info.fps} fps, ${info.duration.toFixed(2)} s`);
  ok(Math.abs(info.duration - r.duration) < 0.25 && info.width === 960, 'video 3D scritto, durata coerente');
  ok(r.warnings.length === 0, 'nessun avviso dal piano' + (r.warnings.length ? ': ' + r.warnings.join('; ') : ''));
  const ch = r.chapters;
  ok(ch.filter((c) => c.kind === 'step').length === 7, '7 passi nella timeline');
  const times = [1.5, 7.5];
  for (const c of ch.filter((x) => x.kind === 'step')) for (const u of [0.3, 0.75]) times.push(c.t0 + (c.t1 - c.t0) * u);
  const fin = ch.find((c) => c.kind === 'check');
  times.push(fin.t0 + 1.5, r.duration - 6, r.duration - 1);
  const { sheet, frames } = await contactSheet(r.videoPath, times, path.join(OUT, 'provino-3d.png'), 4);
  const sd = await Promise.all(frames.map(imageStdev));
  ok(sd.every((v) => v > 6), 'nessun fotogramma vuoto');
  console.log('    PROVINO: ' + sheet);
}

async function sheetOfImages(files, out, cols) {
  const metas = await Promise.all(files.map((f) => sharp(f).metadata()));
  const w = metas[0].width, h = metas[0].height, rows = Math.ceil(files.length / cols);
  await sharp({ create: { width: cols * w, height: rows * h, channels: 3, background: '#22201E' } })
    .composite(files.map((f, i) => ({ input: f, left: (i % cols) * w, top: Math.floor(i / cols) * h })))
    .png().toFile(out);
}

// ------------------------------------------------------------------------------------------ (c)
async function testStep() {
  section('(c) STEP reale (CAX-IF as1-oc-214: assieme con piastra, staffe, bulloni, dadi, asta) -> importModel + viste');
  let step = path.join(FIX, 'step', 'as1-oc-214.stp');
  if (!existsSync(step)) step = path.join(ROOT, 'node_modules', 'occt-import-js', 'test', 'testfiles', 'cax-if', 'as1-oc-214.stp');
  ok(existsSync(step), 'file STEP di prova presente');
  const job = path.join(OUT, 'job-step');
  await fsp.rm(job, { recursive: true, force: true });
  await fsp.mkdir(path.join(job, 'modello'), { recursive: true });
  const model = path.join(job, 'modello', path.basename(step));
  await fsp.copyFile(step, model);
  const t0 = Date.now();
  const imp = await importModel(job, model, progressPrinter('step'), { log: quietLog });
  console.log(`    import in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${imp.parts.length} parti, ${imp.meta.group_count} gruppi, ${imp.meta.size_text}`);
  console.log(`    asse verticale: ${imp.meta.up_axis_in_source} — ${imp.meta.up_axis_reason}`);
  ok(imp.parts.length === 18, '18 parti (una per solido)');
  const groups = {};
  for (const p of imp.parts) (groups[p.similar_group] ||= []).push(p.name);
  const sizes = Object.values(groups).map((g) => `${g[0]}×${g.length}`).sort();
  console.log('    gruppi: ' + sizes.join(', '));
  ok(Object.values(groups).some((g) => g[0] === 'nut' && g.length === 8) && Object.values(groups).some((g) => g[0] === 'bolt' && g.length === 6), 'dadi (8) e bulloni (6) riconosciuti come parti uguali');
  ok(imp.meta.up_axis_in_source === 'z', 'STEP con Z in alto riconosciuto (piastra a terra)');
  const plate = imp.parts.find((p) => p.name === 'plate');
  ok(plate && Math.abs(plate.size[1] - 20) < 0.5 && plate.bbox_min[1] < 5, `piastra orizzontale, spessore 20 mm lungo Y (sotto sporgono solo le teste dei bulloni: y min ${plate && plate.bbox_min[1]})`);
  ok(Math.min(...imp.parts.map((p) => p.bbox_min[1])) > -0.1 && Math.min(...imp.parts.map((p) => p.bbox_min[1])) < 0.1, 'assieme appoggiato a y = 0');
  ok(existsSync(path.join(job, 'model.glb')) && existsSync(path.join(job, 'model.meta.json')), 'model.glb e model.meta.json scritti');
  const views = await renderPartViews(job, null, { max: 24 });
  ok(views.length === 6 && views.every((v) => existsSync(v.path)), `viste: ${views.map((v) => v.label).join(' | ')}`);
  const sd = await Promise.all(views.map((v) => imageStdev(v.path)));
  ok(sd.every((v) => v > 5), 'viste non vuote');
  await sheetOfImages(views.map((v) => v.path), path.join(OUT, 'viste-step.png'), 3);
  console.log('    PROVINO VISTE: ' + path.join(OUT, 'viste-step.png'));

  // (c2) lo stesso motore 3D su un modello diverso (100 volte piu' piccolo del tavolo): fotogrammi chiave
  const manual = JSON.parse(readFileSync(path.join(FIX, 'step', 'as1-manual.json'), 'utf8'));
  const plan = JSON.parse(readFileSync(path.join(FIX, 'step', 'as1-plan.json'), 'utf8'));
  ok(AnimationPlan.safeParse(plan).success, 'as1-plan.json valido (AnimationPlan)');
  const opts = { mode: '3d', manual, plan, quality: 'anteprima', log: quietLog };
  const probe = await renderStills(job, opts, [0], path.join(job, 'stills-probe'));
  const times = [1.5, 7.5];
  for (const c of probe.chapters.filter((x) => x.kind === 'step')) for (const u of [0.35, 0.8]) times.push(c.t0 + (c.t1 - c.t0) * u);
  times.push(probe.duration - 6, probe.duration - 1);
  const st = await renderStills(job, opts, times, path.join(job, 'stills'));
  ok(st.warnings.length === 0, 'piano STEP senza avvisi' + (st.warnings.length ? ': ' + st.warnings.join('; ') : ''));
  const sd2 = await Promise.all(st.files.map(imageStdev));
  ok(sd2.every((v) => v > 6), `fotogrammi 3D del modello STEP non vuoti (${st.files.length})`);
  await sheetOfImages(st.files, path.join(OUT, 'provino-3d-step.png'), 4);
  console.log('    PROVINO: ' + path.join(OUT, 'provino-3d-step.png'));
}

// ------------------------------------------------------------------------------------------ errori
async function testErrors() {
  section('Errori con messaggi in italiano');
  const job = path.join(OUT, 'job-errori');
  await fsp.mkdir(job, { recursive: true });
  const bad = path.join(job, 'modello.fbx');
  await fsp.writeFile(bad, 'x');
  await importModel(job, bad).then(() => ok(false, 'formato non supportato rifiutato'), (e) => ok(/non supportato/.test(e.message), 'formato non supportato: «' + e.message + '»'));
  const corrupt = path.join(job, 'rotto.stp');
  await fsp.writeFile(corrupt, 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n');
  await importModel(job, corrupt).then(() => ok(false, 'STEP senza geometria rifiutato'), (e) => ok(/CAD|STEP|superfici|solidi/i.test(e.message), 'STEP vuoto: «' + e.message + '»'));
  const manual = JSON.parse(readFileSync(path.join(FIX, 'tavolo-levante', 'manual.json'), 'utf8'));
  await renderVideo(job, { mode: 'immagini', manual, quality: '4k' }).then(() => ok(false, 'qualità non valida rifiutata'), (e) => ok(/Qualità non valida/.test(e.message), 'qualità non valida: «' + e.message + '»'));
  await renderVideo(job, { mode: '3d', manual, plan: null }).then(() => ok(false, 'video 3D senza piano rifiutato'), (e) => ok(/piano/.test(e.message), '3D senza piano: «' + e.message + '»'));
}

// ------------------------------------------------------------------------------------------
const started = Date.now();
await fsp.mkdir(OUT, { recursive: true });
console.log('Cartella di lavoro: ' + OUT);
try {
  if (want('errori')) await testErrors();
  if (want('step')) await testStep();
  if (want('immagini')) await testImmagini();
  if (want('stress')) await testImmaginiStress();
  if (want('3d')) await test3d();
} catch (e) {
  failures++;
  console.log('  FAIL eccezione: ' + (e && e.stack || e));
}
console.log(`\n${failures ? 'FALLITO: ' + failures + ' verifiche' : 'Tutto ok'} — ${((Date.now() - started) / 1000).toFixed(0)} s`);
process.exit(failures ? 1 : 0);
