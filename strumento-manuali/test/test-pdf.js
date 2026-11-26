#!/usr/bin/env node
// Test di ingest (PDF/DOCX), preparazione immagini e generazione del PDF impaginato.
//
//   node test/test-pdf.js
//
// Richiede Chromium di Playwright (npx playwright install chromium). Se nel sistema ci sono gli strumenti
// poppler (pdfinfo, pdffonts, pdfimages, pdftoppm) vengono usati per controlli extra e per le anteprime PNG
// (cartella <tmp>/anteprime); altrimenti quei controlli vengono saltati.
// Cartella di lavoro: MANUALI_TEST_DIR oppure <tmp di sistema>/strumento-manuali-test/pdf.
// Uscita con codice 1 se un test fallisce.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { ingestDocument, prepareImages, IngestError } from '../src/ingest/index.js';
import { generatePdf } from '../src/pdf/generate.js';
import { normalizeVideoUrl, VideoUrlError } from '../src/pdf/qr.js';
import { decodeQrPng, renderPdfPage } from './qr-decode.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const WORK = path.resolve(process.env.MANUALI_TEST_DIR || path.join(os.tmpdir(), 'strumento-manuali-test', 'pdf'));
const PREVIEWS = path.join(WORK, 'anteprime');
const REF_EXTRACTED = path.resolve(ROOT, '..', 'manuale-tavolo-levante', 'assets', 'estratte'); // facoltativa

const hasTool = (t) => spawnSync(t, ['-v'], { stdio: 'ignore' }).error === undefined;
const POPPLER = hasTool('pdfinfo') && hasTool('pdffonts');
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

// ------------------------------------------------------------------ mini harness
const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL ${name}\n       ${String(err?.stack || err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}
const readJson = async (f) => JSON.parse(await fs.readFile(f, 'utf8'));
async function freshDir(d) { await fs.rm(d, { recursive: true, force: true }); await fs.mkdir(d, { recursive: true }); return d; }
async function rawPixels(file) {
  const { data, info } = await sharp(file).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  return { data, info };
}
async function meanAbsDiff(a, b) {
  const A = await rawPixels(a);
  const B = await sharp(b).removeAlpha().toColourspace('srgb').resize(A.info.width, A.info.height, { fit: 'fill' }).raw().toBuffer();
  let s = 0;
  for (let i = 0; i < A.data.length; i++) s += Math.abs(A.data[i] - B[i]);
  return s / A.data.length;
}

/** Controllo indipendente nel browser: ogni elemento visibile sta nella sua area utile, le immagini sono caricate. */
async function browserLayoutCheck(htmlFile) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
    await page.emulateMedia({ media: 'print' });
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'load' });
    return await page.evaluate(async () => {
      await document.fonts.ready;
      const out = { pages: 0, problems: [] };
      const pages = [...document.querySelectorAll('#book > .page')];
      out.pages = pages.length;
      pages.forEach((p, i) => {
        const pr = p.getBoundingClientRect();
        const c = p.querySelector('.content');
        const area = c ? c.getBoundingClientRect() : pr;
        for (const el of p.querySelectorAll(c ? '.content *' : '*')) {
          if (el.closest('svg') && el.tagName !== 'svg') continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          // le immagini "al vivo" possono essere ritagliate dalla loro cornice: conta la parte visibile
          const clip = el.tagName === 'IMG' ? el.closest('.card-img, .ov-img, .fig, .nb-img, .cover-hero') : null;
          const cr = clip ? clip.getBoundingClientRect() : r;
          const v = { l: Math.max(r.left, cr.left), r: Math.min(r.right, cr.right), t: Math.max(r.top, cr.top), b: Math.min(r.bottom, cr.bottom) };
          if (v.l < area.left - 1 || v.r > area.right + 1 || v.t < area.top - 1 || v.b > area.bottom + 1) {
            out.problems.push(`pagina ${i + 1}: <${el.tagName.toLowerCase()} class="${el.className?.baseVal ?? el.className}"> esce dall'area utile`);
          }
        }
        for (const im of p.querySelectorAll('img')) if (!im.naturalWidth) out.problems.push(`pagina ${i + 1}: immagine non caricata`);
      });
      out.verify = window.__verifyLayout ? window.__verifyLayout() : [];
      return out;
    });
  } finally {
    await browser.close();
  }
}

function checkFonts(pdf) {
  if (!POPPLER) return 'saltato (pdffonts non disponibile)';
  const rows = run('pdffonts', [pdf]).trim().split('\n').slice(2).filter(Boolean);
  assert.ok(rows.length > 0, 'nessun font nel PDF');
  for (const r of rows) {
    const [name] = r.split(/\s+/);
    assert.match(name, /Barlow/, `font non Barlow nel PDF: ${name}`);
    assert.match(r, /\byes\s+yes\s+yes\b/, `font non incorporato: ${r}`);
  }
  return rows.map((r) => r.split(/\s+/)[0].replace(/^[A-Z]{6}\+/, '')).join(', ');
}
function pdfPages(pdf) {
  if (!POPPLER) return null;
  return Number(/Pages:\s+(\d+)/.exec(run('pdfinfo', [pdf]))[1]);
}
function previews(pdf, name) {
  if (!hasTool('pdftoppm')) return;
  fss.mkdirSync(PREVIEWS, { recursive: true });
  run('pdftoppm', ['-r', '60', '-png', pdf, path.join(PREVIEWS, name)]);
}

// ------------------------------------------------------------------ PDF di prova costruiti a mano
/** PDF minimale con oggetti dati: [{ dict, stream? }] (oggetto 1 = catalogo). */
function buildPdf(objs) {
  const parts = [Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1')];
  let len = parts[0].length;
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(len);
    const chunk = o.stream
      ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< ${o.dict} /Length ${o.stream.length} >>\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')])
      : Buffer.from(`${i + 1} 0 obj\n${o.dict}\nendobj\n`, 'latin1');
    parts.push(chunk);
    len += chunk.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}` +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

function craftedPdf() {
  const rgb = Buffer.alloc(64 * 32 * 3);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) { const i = (y * 64 + x) * 3; rgb[i] = x * 4; rgb[i + 1] = y * 8; rgb[i + 2] = 128; }
  const bits = Buffer.alloc(5 * 40); // 40×40, 1 bit, scacchiera 8×8 (bit 0 = nero)
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if (((x >> 3) + (y >> 3)) & 1) bits[y * 5 + (x >> 3)] |= 0x80 >> (x & 7);
  const tiny = Buffer.alloc(10 * 10 * 3, 200);
  const mask = Buffer.alloc(4 * 32, 0x5a);
  const inl = Buffer.alloc(30 * 30 * 3);
  for (let i = 0; i < inl.length; i += 3) { inl[i] = 250; inl[i + 1] = 40; inl[i + 2] = 40; }
  const content = [
    'BT /F1 12 Tf 50 750 Td (Pagina di prova: immagini in linea, moduli e maschere) Tj ET',
    'q 200 0 0 100 50 600 cm /Im1 Do Q',
    'q /Fm1 Do Q',
    `q 50 0 0 50 400 600 cm BI /W 30 /H 30 /CS /RGB /BPC 8 /F /AHx ID ${inl.toString('hex')}> EI Q`,
    'q 10 0 0 10 20 20 cm /Im3 Do Q',
    'q 0 0 1 rg 80 0 0 80 300 400 cm /Im4 Do Q',
    'q 120 0 0 60 100 300 cm /Im1 Do Q',
  ].join('\n');
  return buildPdf([
    { dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { dict: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 10 0 R >> /XObject << /Im1 5 0 R /Fm1 6 0 R /Im3 8 0 R /Im4 9 0 R >> >> >>' },
    { dict: '', stream: Buffer.from(content, 'latin1') },
    { dict: '/Type /XObject /Subtype /Image /Width 64 /Height 32 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode', stream: zlib.deflateSync(rgb) },
    { dict: '/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Matrix [1 0 0 1 300 100] /Resources << /XObject << /Im2 7 0 R >> >>', stream: Buffer.from('q 100 0 0 100 0 0 cm /Im2 Do Q', 'latin1') },
    { dict: '/Type /XObject /Subtype /Image /Width 40 /Height 40 /ColorSpace /DeviceGray /BitsPerComponent 1', stream: bits },
    { dict: '/Type /XObject /Subtype /Image /Width 10 /Height 10 /ColorSpace /DeviceRGB /BitsPerComponent 8', stream: tiny },
    { dict: '/Type /XObject /Subtype /Image /Width 32 /Height 32 /ImageMask true /BitsPerComponent 1', stream: mask },
    { dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
  ]);
}

/** PDF stampato da Chromium con immagini JPEG (RGB, grigi, CMYK) e un PNG trasparente. */
async function chromiumPdf(htmlBody, out) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><style>@page{size:A4;margin:12mm}body{font:14px sans-serif;margin:0}img{display:block;margin:6mm 0}</style></head><body>${htmlBody}</body></html>`, { waitUntil: 'load' });
    await page.pdf({ path: out, preferCSSPageSize: true, printBackground: true });
  } finally {
    await browser.close();
  }
}

// ================================================================== TEST
const EXPECTED = [
  ['img_00', 1, 1000, 672, null], ['img_01', 3, 421, 467, null], ['img_02', 3, 417, 557, null], ['img_03', 3, 267, 197, null],
  ['img_04', 5, 517, 552, null], ['img_05', 5, 1257, 727, null], ['img_06', 5, 1032, 587, null], ['img_07', 5, 920, 546, null],
  ['img_08', 6, 517, 552, 'img_04'], ['img_09', 6, 1226, 732, null], ['img_10', 7, 1347, 747, null], ['img_11', 9, 817, 712, null],
  ['img_12', 10, 842, 712, null], ['img_13', 11, 992, 641, null], ['img_14', 12, 612, 482, null],
];

async function main() {
  await fs.mkdir(WORK, { recursive: true });
  console.log(`Cartella di lavoro: ${WORK}${POPPLER ? '' : ' (poppler non disponibile: controlli pdffonts/pdfinfo saltati)'}`);
  const jobLev = path.join(WORK, 'job-levante');
  const levanteManual = await readJson(path.join(FIX, 'tavolo-levante', 'manual.json'));
  let ingest;

  console.log('\n(a) Fixture "Tavolo Levante"');
  await test('ingest del PDF originale: 15 immagini, id, dimensioni e duplicati', async () => {
    await freshDir(jobLev);
    const steps = [];
    ingest = await ingestDocument(jobLev, path.join(FIX, 'tavolo-levante', 'TAVOLO_LEVANTE_originale.pdf'), (p, m) => steps.push([p, m]));
    assert.equal(ingest.kind, 'pdf');
    assert.equal(ingest.html, null);
    assert.equal(path.resolve(ingest.pdfPath), path.resolve(FIX, 'tavolo-levante', 'TAVOLO_LEVANTE_originale.pdf'));
    assert.equal(ingest.pages.length, 12);
    assert.match(ingest.pages[6].text, /SENZA SERRARLE/);
    assert.deepEqual(ingest.warnings, []);
    assert.equal(ingest.catalog.length, 15);
    ingest.catalog.forEach((c, i) => {
      const [id, page, w, h, dup] = EXPECTED[i];
      assert.deepEqual([c.id, c.page, c.width, c.height, c.duplicate_of], [id, page, w, h, dup], `voce ${i}`);
      assert.equal(c.file, `estratte/${id}.png`);
      assert.ok(Array.isArray(c.bbox) && c.bbox.length === 4 && c.bbox[2] > c.bbox[0] && c.bbox[3] > c.bbox[1], `bbox ${id}`);
      assert.ok(c.bbox.every((v) => v >= 0 && v <= 842), `bbox ${id} dentro la pagina`);
    });
    const disk = await readJson(path.join(jobLev, 'estratte', 'catalog.json'));
    assert.deepEqual(disk, ingest.catalog);
    const text = await readJson(path.join(jobLev, 'estratte', 'text.json'));
    assert.equal(text.pages.length, 12);
    assert.ok(steps.length > 3 && steps.at(-1)[0] === 100, 'avanzamento fino a 100');
  });

  await test('pixel identici a pdfimages (se la cartella di riferimento esiste)', async () => {
    if (!fss.existsSync(REF_EXTRACTED)) return;
    for (let i = 0; i < 15; i++) {
      const a = await rawPixels(path.join(jobLev, 'estratte', `img_${String(i).padStart(2, '0')}.png`));
      const b = await rawPixels(path.join(REF_EXTRACTED, `img-${String(i).padStart(3, '0')}.png`));
      assert.equal(a.data.length, b.data.length, `dimensione img_${i}`);
      assert.ok(a.data.equals(b.data), `pixel diversi in img_${i}`);
    }
  });

  await test('prepareImages: orig, final (bianco, ingrandite), thumb; il logo beige resta beige', async () => {
    const r = await prepareImages(jobLev, ingest.catalog);
    assert.deepEqual(r.warnings, []);
    for (const c of ingest.catalog) {
      for (const f of [`immagini/orig/${c.id}.png`, `immagini/final/${c.id}.png`, `immagini/thumb/${c.id}.jpg`]) {
        assert.ok(fss.existsSync(path.join(jobLev, f)), `manca ${f}`);
      }
      const th = await sharp(path.join(jobLev, 'immagini', 'thumb', `${c.id}.jpg`)).metadata();
      assert.ok(Math.max(th.width, th.height) <= 360, `miniatura ${c.id} troppo grande`);
      const fin = await sharp(path.join(jobLev, 'immagini', 'final', `${c.id}.png`)).metadata();
      const info = r.prepared[c.id];
      assert.deepEqual([fin.width, fin.height], info.final);
      const preLong = Math.max(...info.pre);
      const expLong = preLong < 1400 ? Math.min(2600, preLong * 2) : preLong;
      assert.ok(Math.abs(Math.max(fin.width, fin.height) - expLong) <= 1, `${c.id}: lato lungo ${Math.max(fin.width, fin.height)}, atteso ${expLong}`);
      const orig = await fs.readFile(path.join(jobLev, 'immagini', 'orig', `${c.id}.png`));
      assert.ok(orig.equals(await fs.readFile(path.join(jobLev, c.file))), `copia orig di ${c.id} modificata`);
    }
    // render CAD su #FAFBFB → bianco puro e rifilato
    const p04 = await rawPixels(path.join(jobLev, 'immagini', 'final', 'img_04.png'));
    assert.deepEqual([...p04.data.subarray(0, 3)], [255, 255, 255]);
    assert.ok(r.prepared.img_04.trimmed && r.prepared.img_04.nearWhite && !r.prepared.img_04.bleed);
    // primo piano che arriva ai bordi: non rifilato
    assert.ok(r.prepared.img_10.bleed && !r.prepared.img_10.trimmed);
    // logo su beige: non sbiancato
    const logo = await rawPixels(path.join(jobLev, 'immagini', 'final', 'img_14.png'));
    const [lr, lg, lb] = logo.data.subarray((10 * logo.info.width + 10) * 3);
    assert.ok(Math.abs(lr - 219) <= 4 && Math.abs(lg - 211) <= 4 && Math.abs(lb - 203) <= 4, `sfondo del logo alterato: ${lr},${lg},${lb}`);
    assert.equal(r.prepared.img_14.factor, 1);
  });

  let levPdf;
  await test('generatePdf (fixture): pagine, font Barlow, nessuna immagine mancante, nessuno sbordamento', async () => {
    levPdf = path.join(jobLev, 'out', 'manuale.pdf');
    const prog = [];
    const out = await generatePdf(jobLev, levanteManual, { outPath: levPdf, onProgress: (p) => prog.push(p) });
    assert.equal(out, levPdf);
    assert.ok(fss.statSync(levPdf).size > 100_000);
    assert.equal(prog.at(-1), 100);
    const lay = await readJson(path.join(jobLev, 'pdf-build', 'layout.json'));
    assert.deepEqual(lay.overflow, [], JSON.stringify(lay.overflow));
    assert.deepEqual(lay.forced, []);
    assert.deepEqual(lay.warnings, []);
    assert.deepEqual(Object.keys(lay.stepPages).map(Number), [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(lay.pages.length >= 6 && lay.pages.length <= 8, `pagine: ${lay.pages.length} (il manuale fatto a mano ne ha 8)`);
    assert.equal(lay.pages[0].kind, 'cover');
    assert.equal(lay.pages.at(-1).kind, 'back');
    assert.equal(lay.back_logo?.kind, 'beige');
    const pages = pdfPages(levPdf);
    if (pages !== null) assert.equal(pages, lay.pages.length);
    const fonts = checkFonts(levPdf);
    console.log(`       ${lay.pages.length} pagine; font: ${fonts}`);
    const chk = await browserLayoutCheck(path.join(jobLev, 'pdf-build', 'manuale.impaginato.html'));
    assert.equal(chk.pages, lay.pages.length);
    assert.deepEqual(chk.problems, []);
    assert.deepEqual(chk.verify, []);
    const html = await fs.readFile(path.join(jobLev, 'pdf-build', 'manuale.impaginato.html'), 'utf8');
    for (const id of ['img_00', 'img_01', 'img_02', 'img_03', 'img_04', 'img_05', 'img_06', 'img_07', 'img_08', 'img_09', 'img_10', 'img_11', 'img_12', 'img_13']) {
      assert.ok(html.includes(`/${id}.png`), `immagine ${id} assente dal PDF`);
    }
    assert.match(html, /logo-retro-img_14\.png/);
    assert.match(html, /<strong class="key">senza(&nbsp;|\s)serrarle<\/strong>/);
    previews(levPdf, 'levante');
  });

  console.log('\n(b) ManualData sintetico "stress"');
  const jobStress = path.join(WORK, 'job-stress');
  const stress = await readJson(path.join(FIX, 'stress', 'manual.json'));
  await test('stress: 12 passi, 9 componenti, 5 ferramenta, senza fasi/copertina/logo → nessuno sbordamento', async () => {
    await freshDir(jobStress);
    await fs.cp(path.join(jobLev, 'immagini'), path.join(jobStress, 'immagini'), { recursive: true });
    const pdf = await generatePdf(jobStress, stress, {});
    assert.equal(pdf, path.resolve(jobStress, 'out', 'manuale.pdf'));
    const lay = await readJson(path.join(jobStress, 'pdf-build', 'layout.json'));
    assert.deepEqual(lay.overflow, [], JSON.stringify(lay.overflow));
    assert.deepEqual(lay.forced, []);
    assert.deepEqual(Object.keys(lay.stepPages).map(Number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(lay.back_logo, null);
    const html = await fs.readFile(path.join(jobStress, 'pdf-build', 'manuale.impaginato.html'), 'utf8');
    assert.match(html, /class="page cover no-hero"/);
    assert.equal((html.match(/class="blk nb/g) || []).length, 2, 'due note');
    assert.equal((html.match(/class="card hw"/g) || []).length, 5);
    assert.equal((html.match(/class="card comp"/g) || []).length, 9);
    assert.equal((html.match(/class="ov"/g) || []).length, 12, 'panoramica con 12 passi');
    assert.match(html, /data-layout="grid"/);
    assert.match(html, /data-layout="row"/);
    assert.match(html, /data-layout="text"/);
    const chk = await browserLayoutCheck(path.join(jobStress, 'pdf-build', 'manuale.impaginato.html'));
    assert.deepEqual(chk.problems, []);
    assert.deepEqual(chk.verify, []);
    const pages = pdfPages(pdf);
    if (pages !== null) assert.equal(pages, lay.pages.length);
    checkFonts(pdf);
    console.log(`       ${lay.pages.length} pagine; figure ridotte: ${lay.scaled.map((s) => `${s.block} ${Math.round(s.scale * 100)}%`).join(', ') || 'nessuna'}`);
    previews(pdf, 'stress');
  });

  console.log('\n(c) QR code del video di montaggio (pagina 2)');
  const VIDEO_URL = 'https://www.youtube.com/watch?v=Levante-2026';
  await test('link del video: http/https, ≤ 500 caratteri, vuoto → null, errori in italiano', async () => {
    assert.equal(normalizeVideoUrl('  https://youtu.be/abc  '), 'https://youtu.be/abc');
    assert.equal(normalizeVideoUrl('http://esempio.it/v'), 'http://esempio.it/v');
    assert.equal(normalizeVideoUrl(''), null);
    assert.equal(normalizeVideoUrl('   '), null);
    assert.equal(normalizeVideoUrl(null), null);
    for (const bad of ['ftp://esempio.it/v', 'javascript:alert(1)', 'youtu.be/abc', 'https://esempio', 'https://a b.it', `https://esempio.it/${'x'.repeat(490)}`, 42, 'https://utente:pw@esempio.it/v']) {
      assert.throws(() => normalizeVideoUrl(bad), (e) => e instanceof VideoUrlError && /link del video/i.test(e.message), `accettato: ${String(bad).slice(0, 40)}`);
    }
  });

  await test('PDF con il QR del video: riquadro in fondo a pagina 2, QR vettoriale leggibile, nulla sborda', async () => {
    const job = await freshDir(path.join(WORK, 'job-qr'));
    await fs.cp(path.join(jobLev, 'immagini'), path.join(job, 'immagini'), { recursive: true });
    const pdf = await generatePdf(job, levanteManual, { videoUrl: VIDEO_URL });
    const lay = await readJson(path.join(job, 'pdf-build', 'layout.json'));
    assert.deepEqual(lay.overflow, [], JSON.stringify(lay.overflow));
    assert.deepEqual(lay.forced, []);
    assert.deepEqual(lay.warnings, []);
    assert.equal(lay.video_url, VIDEO_URL);
    assert.equal(lay.qr?.page, 2, `QR a pagina ${lay.qr?.page}`);
    assert.equal(lay.qr.url, VIDEO_URL);
    assert.ok(lay.qr.size_mm >= 25, `QR troppo piccolo: ${lay.qr.size_mm} mm`);
    assert.equal(lay.pages[1].chapter, 'contenuto');
    const plain = await readJson(path.join(jobLev, 'pdf-build', 'layout.json'));
    assert.equal(lay.pages.length, plain.pages.length, 'il QR non deve aggiungere pagine');
    const html = await fs.readFile(path.join(job, 'pdf-build', 'manuale.impaginato.html'), 'utf8');
    assert.equal((html.match(/class="qr-box"/g) || []).length, 1, 'un solo riquadro del QR');
    assert.equal((html.match(/<svg class="qr-svg"/g) || []).length, 1, 'QR come SVG (vettoriale)');
    assert.match(html, /Guarda il video di montaggio/);
    assert.match(html, /Inquadra il codice con la fotocamera del telefono/);
    assert.match(html, /<span class="qr-url">youtube\.com\/watch\?v=Levante-2026<\/span>/);
    // il riquadro sta nella seconda pagina del libro (dopo la copertina)
    const pagesHtml = html.split('<section class="page ').slice(1);
    assert.match(pagesHtml[1], /^inner has-qr"/);
    assert.ok(pagesHtml[1].includes('class="qr-box"') && !pagesHtml.slice(2).some((p) => p.includes('class="qr-box"')));
    const chk = await browserLayoutCheck(path.join(job, 'pdf-build', 'manuale.impaginato.html'));
    assert.deepEqual(chk.problems, []);
    assert.deepEqual(chk.verify, []);
    if (hasTool('pdfimages')) {
      const imgs = (f) => run('pdfimages', ['-list', '-f', '2', '-l', '2', f]).trim().split('\n').length - 2;
      assert.equal(imgs(pdf), imgs(levPdf), 'il QR non deve essere un’immagine raster');
    }
    const png = renderPdfPage(pdf, 2, path.join(job, 'pagina2'));
    if (!png) { console.log('       lettura del QR saltata (pdftoppm non disponibile)'); return; }
    const text = await decodeQrPng(png);
    if (text === undefined) { console.log('       lettura del QR saltata (nessun lettore: npm install per "jsqr")'); return; }
    assert.equal(text, VIDEO_URL, 'il QR stampato non porta al link');
    console.log(`       QR letto dalla pagina 2 a 150 dpi: ${text}`);
    previews(pdf, 'qr');
  });

  await test('QR con la fixture "stress" e con un link lunghissimo: sempre a pagina 2, nessuno sbordamento', async () => {
    const job = await freshDir(path.join(WORK, 'job-qr-stress'));
    await fs.cp(path.join(jobLev, 'immagini'), path.join(job, 'immagini'), { recursive: true });
    const long = `https://www.esempio.it/assistenza/video/${'montaggio-del-set-da-giardino-grecale-'.repeat(11)}fine?lingua=it&origine=manuale`;
    assert.ok(long.length > 450 && long.length <= 500, String(long.length));
    const pdf = await generatePdf(job, stress, { videoUrl: long });
    const lay = await readJson(path.join(job, 'pdf-build', 'layout.json'));
    assert.deepEqual(lay.overflow, [], JSON.stringify(lay.overflow));
    assert.deepEqual(lay.forced, []);
    assert.equal(lay.qr?.page, 2);
    assert.ok(lay.qr.size_mm > 32, `link lungo: QR più grande (${lay.qr.size_mm} mm)`);
    const chk = await browserLayoutCheck(path.join(job, 'pdf-build', 'manuale.impaginato.html'));
    assert.deepEqual(chk.problems, []);
    assert.deepEqual(chk.verify, []);
    const png = renderPdfPage(pdf, 2, path.join(job, 'pagina2'));
    const text = png ? await decodeQrPng(png) : undefined;
    if (text !== undefined) assert.equal(text, long);
    previews(pdf, 'qr-stress');
  });

  await test('link non valido o assente: nessun QR (con avviso se non valido)', async () => {
    const job = await freshDir(path.join(WORK, 'job-qr-no'));
    await fs.cp(path.join(jobLev, 'immagini'), path.join(job, 'immagini'), { recursive: true });
    await generatePdf(job, levanteManual, { videoUrl: 'ftp://esempio.it/video' });
    let lay = await readJson(path.join(job, 'pdf-build', 'layout.json'));
    assert.ok(lay.warnings.some((w) => /QR code del video non inserito: .*https:\/\//.test(w)), JSON.stringify(lay.warnings));
    assert.equal(lay.qr, undefined);
    let html = await fs.readFile(path.join(job, 'pdf-build', 'manuale.impaginato.html'), 'utf8');
    assert.ok(!html.includes('class="qr-box"') && !html.includes('id="tpl-qr"'));
    await generatePdf(job, levanteManual, { videoUrl: '' });
    lay = await readJson(path.join(job, 'pdf-build', 'layout.json'));
    assert.deepEqual(lay.warnings, []);
    assert.equal(lay.video_url, null);
    html = await fs.readFile(path.join(job, 'pdf-build', 'manuale.impaginato.html'), 'utf8');
    assert.ok(!html.includes('class="qr-box"'));
  });

  await test('passo con testo lunghissimo: prosegue nella pagina dopo ("segue"), mai sbordamenti', async () => {
    const job = await freshDir(path.join(WORK, 'job-lungo'));
    await fs.cp(path.join(jobLev, 'immagini'), path.join(job, 'immagini'), { recursive: true });
    const long = Array.from({ length: 9 }, (_, i) => `Paragrafo ${i + 1}. ` + 'Controllare con attenzione ogni giunzione, verificare che le viti siano allineate ai fori e procedere lentamente senza forzare i componenti. '.repeat(5));
    const m = { ...stress, steps: [stress.steps[1], { ...stress.steps[8], number: 3, paragraphs: long, warning: 'Avvertenza finale del passo lungo.' }, { ...stress.steps[9], number: 4 }], notes: [] };
    await generatePdf(job, m, {});
    const lay = await readJson(path.join(job, 'pdf-build', 'layout.json'));
    assert.deepEqual(lay.overflow, [], JSON.stringify(lay.overflow));
    assert.deepEqual(lay.forced, []);
    assert.ok(lay.splits.length >= 1, 'il passo lungo doveva proseguire');
    const html = await fs.readFile(path.join(job, 'pdf-build', 'manuale.impaginato.html'), 'utf8');
    assert.match(html, /\(segue\)/);
    assert.match(html, /Avvertenza finale del passo lungo/);
    for (let i = 1; i <= 9; i++) assert.ok(html.includes(`Paragrafo ${i}.`), `paragrafo ${i} perso`);
    const chk = await browserLayoutCheck(path.join(job, 'pdf-build', 'manuale.impaginato.html'));
    assert.deepEqual(chk.problems, []);
    previews(path.join(job, 'out', 'manuale.pdf'), 'lungo');
  });

  await test('tema personalizzato e logo su fondo bianco (diventa trasparente sul retro)', async () => {
    const job = await freshDir(path.join(WORK, 'job-tema'));
    await fs.cp(path.join(jobLev, 'immagini'), path.join(job, 'immagini'), { recursive: true });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="220"><rect width="600" height="220" fill="#fff"/>
      <rect x="40" y="60" width="90" height="90" rx="12" fill="#1565C0"/><rect x="160" y="80" width="380" height="22" fill="#222"/><rect x="160" y="120" width="260" height="14" fill="#1565C0"/></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path.join(job, 'immagini', 'orig', 'img_90.png'));
    const theme = { accent: '#1E88E5', accentInk: '#0D47A1', beige: '#E3E8EE', beigeSoft: '#F3F5F8', ink: '#102027', text: '#263238', muted: '#607D8B', line: '#DDE3EA' };
    const m = { ...levanteManual, brand_logo_image_id: 'img_90', short_name: 'Tavolo Levante Blu' };
    await generatePdf(job, m, { theme });
    const lay = await readJson(path.join(job, 'pdf-build', 'layout.json'));
    assert.equal(lay.back_logo.kind, 'alfa');
    assert.deepEqual(lay.overflow, []);
    const html = await fs.readFile(path.join(job, 'pdf-build', 'manuale.impaginato.html'), 'utf8');
    assert.match(html, /--accent:#1E88E5/);
    const logo = await sharp(path.join(job, 'pdf-build', 'logo-retro-img_90.png')).raw().toBuffer({ resolveWithObject: true });
    assert.equal(logo.info.channels, 4);
    assert.equal(logo.data[3], 0, 'angolo del logo non trasparente');
    previews(path.join(job, 'out', 'manuale.pdf'), 'tema');
  });

  console.log('\n(c) Documento Word');
  await test('DOCX: HTML con segnaposto in ordine, titoli, tabella, elenchi, grassetto/sottolineato, immagini', async () => {
    const job = await freshDir(path.join(WORK, 'job-docx'));
    const r = await ingestDocument(job, path.join(FIX, 'docx-esempio', 'esempio.docx'));
    assert.equal(r.kind, 'docx');
    assert.deepEqual(r.pages, []);
    assert.equal(r.pdfPath, null);
    assert.equal(r.catalog.length, 6);
    assert.deepEqual(r.catalog.map((c) => c.duplicate_of), [null, null, null, null, null, 'img_03']);
    assert.ok(r.catalog.every((c) => c.page === null && c.bbox === null && fss.existsSync(path.join(job, c.file))));
    const order = [...r.html.matchAll(/\[\[(img_\d+)\]\]/g)].map((m) => m[1]);
    assert.deepEqual(order, ['img_00', 'img_01', 'img_02', 'img_03', 'img_04', 'img_05']);
    for (const re of [/<h1>Istruzioni di montaggio – Panca Volpina<\/h1>/, /<table>/, /<td><p>\[\[img_00\]\]<\/p>/, /<ul>/, /<ol start="2">/,
      /<strong><u>SENZA SERRARLE<\/u><\/strong>/, /<u>due persone<\/u>/, /<strong>ATTENZIONE: non serrare/, /<h2>Manutenzione<\/h2>/]) {
      assert.match(r.html, re);
    }
    assert.doesNotMatch(r.html, /<img|<a |src=|data:/);
    assert.ok(r.warnings.some((w) => /EMF/.test(w)), 'avviso EMF mancante');
    assert.match(r.html, /\[immagine EMF non supportata\]/);
    const text = await readJson(path.join(job, 'estratte', 'text.json'));
    assert.equal(text.html, r.html);
    const p = await prepareImages(job, r.catalog);
    assert.deepEqual(p.warnings, []);
    assert.ok(fss.existsSync(path.join(job, 'immagini', 'final', 'img_04.png')));
    // l'immagine JPEG del passo 2 è stata decodificata correttamente
    const d = await meanAbsDiff(path.join(job, 'estratte', 'img_04.png'), path.join(ROOT, '..', 'manuale-tavolo-levante', 'assets', 'estratte', 'img-010.png')).catch(() => 0);
    assert.ok(d < 6, `JPEG del DOCX decodificato male (diff ${d.toFixed(2)})`);
  });

  console.log('\n(d) Robustezza dell\'ingest');
  await test('PDF con immagini JPEG (DCT), grigi, CMYK e PNG trasparente stampato da Chromium', async () => {
    const dir = await freshDir(path.join(WORK, 'pdf-jpeg'));
    const src = path.join(jobLev, 'estratte');
    const jpgRgb = await sharp(path.join(src, 'img_10.png')).jpeg({ quality: 90 }).toBuffer();
    const jpgGray = await sharp(path.join(src, 'img_05.png')).grayscale().jpeg({ quality: 90 }).toBuffer();
    const jpgCmyk = await sharp(path.join(src, 'img_07.png')).toColourspace('cmyk').jpeg({ quality: 92 }).toBuffer();
    const pngAlpha = await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 255, g: 126, b: 0, alpha: 0.5 } } }).png().toBuffer();
    await fs.writeFile(path.join(dir, 'rgb.jpg'), jpgRgb);
    await fs.writeFile(path.join(dir, 'gray.jpg'), jpgGray);
    await fs.writeFile(path.join(dir, 'cmyk.jpg'), jpgCmyk);
    const b64 = (b, t) => `data:${t};base64,${b.toString('base64')}`;
    const pdf = path.join(dir, 'jpeg.pdf');
    await chromiumPdf(`<p>Pagina di prova con immagini JPEG per verificare la decodifica DCT nel lettore PDF.</p>
      <img src="${b64(jpgRgb, 'image/jpeg')}" style="width:160mm"><img src="${b64(jpgGray, 'image/jpeg')}" style="width:120mm">
      <img src="${b64(jpgCmyk, 'image/jpeg')}" style="width:80mm"><img src="${b64(pngAlpha, 'image/png')}" style="width:40mm">`, pdf);
    if (hasTool('pdfimages')) {
      const list = run('pdfimages', ['-list', pdf]);
      assert.match(list, /\bjpeg\b/, 'Chromium non ha incorporato JPEG: il test non verificherebbe la DCT');
    }
    const job = await freshDir(path.join(WORK, 'job-jpeg'));
    const r = await ingestDocument(job, pdf);
    assert.equal(r.kind, 'pdf');
    assert.deepEqual(r.warnings, []);
    assert.equal(r.catalog.length, 4, JSON.stringify(r.catalog.map((c) => [c.width, c.height])));
    assert.deepEqual(r.catalog.map((c) => [c.width, c.height]), [[1347, 747], [1257, 727], [920, 546], [300, 200]]);
    const dRgb = await meanAbsDiff(path.join(job, 'estratte', 'img_00.png'), path.join(dir, 'rgb.jpg'));
    const dGray = await meanAbsDiff(path.join(job, 'estratte', 'img_01.png'), path.join(dir, 'gray.jpg'));
    const dCmyk = await meanAbsDiff(path.join(job, 'estratte', 'img_02.png'), path.join(dir, 'cmyk.jpg'));
    assert.ok(dRgb < 3, `JPEG RGB decodificato male (diff ${dRgb.toFixed(2)})`);
    assert.ok(dGray < 3, `JPEG in grigi decodificato male (diff ${dGray.toFixed(2)})`);
    assert.ok(dCmyk < 20, `JPEG CMYK decodificato male (diff ${dCmyk.toFixed(2)})`);
    const alpha = await sharp(path.join(job, 'estratte', 'img_03.png')).metadata();
    assert.equal(alpha.channels, 4, 'la trasparenza del PNG è andata persa');
    console.log(`       differenze medie: RGB ${dRgb.toFixed(2)}, grigi ${dGray.toFixed(2)}, CMYK ${dCmyk.toFixed(2)}`);
  });

  await test('PDF costruito a mano: immagine in linea, Form XObject con matrice, 1 bit, maschera e minuscola ignorate', async () => {
    const dir = await freshDir(path.join(WORK, 'pdf-amano'));
    const pdf = path.join(dir, 'amano.pdf');
    await fs.writeFile(pdf, craftedPdf());
    const job = await freshDir(path.join(WORK, 'job-amano'));
    const r = await ingestDocument(job, pdf);
    assert.deepEqual(r.warnings, []);
    assert.match(r.pages[0].text, /Pagina di prova/);
    const got = r.catalog.map((c) => [c.id, c.width, c.height, c.bbox, c.duplicate_of, c.index]);
    assert.deepEqual(got, [
      ['img_00', 64, 32, [50, 92, 250, 192], null, 0],
      ['img_01', 40, 40, [300, 592, 400, 692], null, 1],
      ['img_02', 30, 30, [400, 142, 450, 192], null, 2],
      ['img_03', 64, 32, [100, 432, 220, 492], 'img_00', 3],
    ]);
    const bw = await sharp(path.join(job, 'estratte', 'img_01.png')).raw().toBuffer({ resolveWithObject: true });
    const px = (x, y) => bw.data[(y * 40 + x) * bw.info.channels];
    assert.deepEqual([px(0, 0), px(8, 0), px(0, 8), px(9, 9), px(39, 39)], [0, 255, 255, 0, 0]);
    const inl = await sharp(path.join(job, 'estratte', 'img_02.png')).raw().toBuffer();
    assert.deepEqual([...inl.subarray(0, 3)], [250, 40, 40]);
  });

  await test('errori chiari: PDF protetto, PDF danneggiato, formati non supportati, file vuoto', async () => {
    const dir = await freshDir(path.join(WORK, 'errori'));
    const job = path.join(dir, 'job');
    const expectErr = async (file, code, re) => {
      await assert.rejects(ingestDocument(job, file), (err) => {
        assert.ok(err instanceof IngestError, `atteso IngestError, ricevuto ${err?.name}: ${err?.message}`);
        assert.equal(err.code, code, err.message);
        assert.match(err.message, re);
        return true;
      });
    };
    await expectErr(path.join(FIX, 'pdf-errori', 'protetto.pdf'), 'pdf_password', /protetto da password/);
    const corrupt = path.join(dir, 'rotto.pdf');
    await fs.writeFile(corrupt, '%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\nxref garbage\n%%EOF');
    await assert.rejects(ingestDocument(job, corrupt), (err) => err instanceof IngestError && /PDF/.test(err.message) && ['pdf_corrupt', 'pdf_error', 'pdf_empty'].includes(err.code));
    const txt = path.join(dir, 'note.txt');
    await fs.writeFile(txt, 'solo testo');
    await expectErr(txt, 'unsupported', /non supportato.*PDF.*\.docx/);
    const doc = path.join(dir, 'vecchio.doc');
    await fs.writeFile(doc, Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(600)]));
    await expectErr(doc, 'unsupported_doc', /97-2003/);
    const fakeDocx = path.join(dir, 'finto.docx');
    await fs.writeFile(fakeDocx, 'non sono un docx');
    await expectErr(fakeDocx, 'docx_invalid', /non è un documento Word valido/);
    const empty = path.join(dir, 'vuoto.pdf');
    await fs.writeFile(empty, '');
    await expectErr(empty, 'empty_file', /vuoto/);
    await expectErr(path.join(dir, 'inesistente.pdf'), 'not_found', /non trovato/);
  });

  await test('PDF scansionato (solo immagini, niente testo): avviso', async () => {
    const dir = await freshDir(path.join(WORK, 'pdf-scansione'));
    const pdf = path.join(dir, 'scansione.pdf');
    const scan = await sharp(path.join(jobLev, 'estratte', 'img_12.png')).jpeg({ quality: 80 }).toBuffer();
    await chromiumPdf(`<img src="data:image/jpeg;base64,${scan.toString('base64')}" style="width:186mm;height:270mm;margin:0">`, pdf);
    const job = await freshDir(path.join(WORK, 'job-scansione'));
    const r = await ingestDocument(job, pdf);
    assert.equal(r.scanned, true);
    assert.match(r.warnings[0], /sembra una scansione: Claude leggerà le pagine come immagini/);
    assert.equal(r.catalog.length, 1);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} test superati.${fss.existsSync(PREVIEWS) ? ` Anteprime: ${PREVIEWS}` : ''}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
