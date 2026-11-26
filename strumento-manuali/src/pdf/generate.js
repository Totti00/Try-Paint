// generatePdf(jobDir, manual, { outPath, theme, videoUrl, onProgress, signal }) → outPath   (signal: AbortSignal facoltativo)
// videoUrl (facoltativo): link del video di montaggio → riquadro con il QR code in fondo alla pagina 2.
// ManualData → HTML (template.js) → impaginazione automatica in Chromium (paginate.browser.js) → PDF A4
// con i font Barlow incorporati. File di lavoro in <lavoro>/pdf-build/ (HTML, HTML impaginato, layout.json).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ManualData } from '../schema.js';
import { makeProgress, ensureDir, writeJson } from '../ingest/common.js';
import { normalizeTheme, themeCss } from './theme.js';
import { buildManualHtml } from './template.js';
import { resolveImageFile, analyzeImage, prepareBackLogo } from './assets.js';
import { normalizeVideoUrl, buildQrSvg, shortUrl } from './qr.js';
import { renameWithRetry, tmpName } from '../fsutil.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.resolve(HERE, '..', '..', 'assets', 'fonts');

const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const LATIN_EXT = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF';
const FACES = [
  ['Barlow', 'barlow', 400, 'normal', true], ['Barlow', 'barlow', 400, 'italic', false],
  ['Barlow', 'barlow', 500, 'normal', true], ['Barlow', 'barlow', 600, 'normal', true], ['Barlow', 'barlow', 700, 'normal', true],
  ['Barlow Semi Condensed', 'barlow-semi-condensed', 500, 'normal', true], ['Barlow Semi Condensed', 'barlow-semi-condensed', 600, 'normal', true],
  ['Barlow Semi Condensed', 'barlow-semi-condensed', 700, 'normal', true], ['Barlow Semi Condensed', 'barlow-semi-condensed', 800, 'normal', true],
  ['Barlow Condensed', 'barlow-condensed', 600, 'normal', false], ['Barlow Condensed', 'barlow-condensed', 700, 'normal', false],
  ['Barlow Condensed', 'barlow-condensed', 800, 'normal', false],
];

let fontCssCache = null;
/** @font-face con i woff2 incorporati come data: URL (nessun accesso a file:// dal CSS, funziona ovunque). */
async function buildFontCss() {
  if (fontCssCache) return fontCssCache;
  const parts = [];
  for (const [family, base, weight, style, ext] of FACES) {
    const subsets = [['latin', LATIN]];
    if (ext) subsets.push(['latin-ext', LATIN_EXT]);
    for (const [subset, range] of subsets) {
      const file = path.join(FONTS_DIR, `${base}-${subset}-${weight}-${style}.woff2`);
      let b64;
      try {
        b64 = (await fs.readFile(file)).toString('base64');
      } catch (err) {
        if (subset === 'latin') throw new Error(`Font mancante: ${path.relative(path.resolve(HERE, '..', '..'), file)}`, { cause: err });
        continue;
      }
      parts.push(`@font-face{font-family:"${family}";font-weight:${weight};font-style:${style};font-display:block;` +
        `src:url(data:font/woff2;base64,${b64}) format("woff2");unicode-range:${range};}`);
    }
  }
  fontCssCache = parts.join('\n');
  return fontCssCache;
}

async function launchChromium() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    throw new Error('Playwright non è installato: esegui "npm install" nella cartella del programma.', { cause: err });
  }
  try {
    return await chromium.launch();
  } catch (err) {
    const msg = String(err?.message || err);
    if (/Executable doesn't exist|playwright install|browserType\.launch/i.test(msg) && /exist|install/i.test(msg)) {
      throw new Error('Il browser Chromium usato per creare il PDF non è installato: esegui "npx playwright install chromium" (oppure "npm run setup") e riprova.', { cause: err });
    }
    throw new Error(`Impossibile avviare Chromium per creare il PDF: ${msg.split('\n')[0]}`, { cause: err });
  }
}

/** Tutti gli id immagine usati dal manuale. */
function usedImageIds(m) {
  const ids = new Set();
  const add = (id) => { if (id) ids.add(id); };
  add(m.cover_image_id);
  (m.hardware || []).forEach((h) => add(h.image_id));
  (m.components || []).forEach((c) => add(c.image_id));
  (m.steps || []).forEach((s) => (s.image_ids || []).forEach(add));
  (m.notes || []).forEach((n) => add(n.image_id));
  return [...ids];
}

function zodMessage(error) {
  return (error?.issues || []).slice(0, 4).map((i) => `${(i.path || []).join('.') || 'radice'}: ${i.message}`).join('; ');
}

export async function generatePdf(jobDir, manual, { outPath, theme, videoUrl = null, onProgress, signal } = {}) {
  const progress = makeProgress(onProgress);
  const aborted = () => { if (signal?.aborted) { const e = new Error('Creazione del PDF annullata.'); e.name = 'AbortError'; throw e; } };
  aborted();
  if (!jobDir) throw new Error('generatePdf: manca la cartella del lavoro.');
  const parsed = ManualData.safeParse(manual);
  if (!parsed.success) throw new Error(`La scheda del manuale non è valida (${zodMessage(parsed.error)}).`);
  const m = parsed.data;
  const t = normalizeTheme(theme);
  const out = path.resolve(outPath || path.join(jobDir, 'out', 'manuale.pdf'));
  const buildDir = await ensureDir(path.join(jobDir, 'pdf-build'));
  await ensureDir(path.dirname(out));
  const warnings = [];

  progress(3, 'Preparazione delle immagini per il PDF…');
  const images = new Map();
  for (const id of usedImageIds(m)) {
    const file = await resolveImageFile(jobDir, id);
    if (!file) { warnings.push(`Immagine ${id} non trovata: omessa dal PDF.`); continue; }
    try {
      const info = await analyzeImage(file);
      images.set(id, { ...info, src: pathToFileURL(file).href, file });
    } catch (err) {
      warnings.push(`Immagine ${id} non leggibile: omessa dal PDF (${err?.message || err}).`);
    }
  }
  let backLogo = null;
  try {
    backLogo = await prepareBackLogo(jobDir, m.brand_logo_image_id, t, buildDir);
    if (m.brand_logo_image_id && !backLogo) warnings.push(`Logo ${m.brand_logo_image_id} non trovato: retro senza logo.`);
  } catch (err) {
    warnings.push(`Logo non elaborato (${err?.message || err}): retro senza logo.`);
  }

  let qr = null;
  try {
    const url = normalizeVideoUrl(videoUrl);
    if (url) qr = { ...(await buildQrSvg(url)), url, text: shortUrl(url) };
  } catch (err) {
    warnings.push(`QR code del video non inserito: ${err?.message || err}`);
  }

  progress(12, 'Composizione delle pagine…');
  const [css, script, fontCss] = await Promise.all([
    fs.readFile(path.join(HERE, 'manuale.css'), 'utf8'),
    fs.readFile(path.join(HERE, 'paginate.browser.js'), 'utf8'),
    buildFontCss(),
  ]);
  const html = buildManualHtml(m, { images, css, script, fontCss, themeCss: themeCss(t), backLogo, qr });
  const htmlPath = path.join(buildDir, 'manuale.html');
  await fs.writeFile(htmlPath, html, 'utf8');

  progress(20, 'Avvio del motore di impaginazione…');
  aborted();
  const browser = await launchChromium();
  // annullando si chiude il browser: l'impaginazione o la stampa in corso si interrompono subito
  const onAbort = () => { browser.close().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const pageErrors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 1400 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e?.message || e)));
    await page.emulateMedia({ media: 'print' });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 180_000 });
    progress(35, 'Impaginazione automatica…');
    const report = await page.evaluate(() => window.__paginate());
    if (pageErrors.length) throw new Error(`Errore durante l’impaginazione: ${pageErrors[0]}`);
    const missing = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute('src')));
    if (missing.length) throw new Error(`Immagini non caricate nel PDF: ${missing.map((s) => decodeURIComponent(s.split('/').pop())).join(', ')}`);
    await fs.writeFile(path.join(buildDir, 'manuale.impaginato.html'), await page.content(), 'utf8');

    progress(70, 'Stampa del PDF…');
    const tmp = tmpName(out);
    try {
      await page.pdf({ path: tmp, preferCSSPageSize: true, printBackground: true, tagged: true, timeout: 180_000 });
      await renameWithRetry(tmp, out);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      if (err?.code === 'EBUSY' || err?.code === 'EPERM') {
        throw new Error(`Impossibile scrivere ${path.basename(out)}: il file è aperto in un altro programma? Chiudilo e riprova.`, { cause: err });
      }
      throw err;
    }
    if (report.overflow.length) warnings.push(`Impaginazione: ${report.overflow.length} elementi escono dall’area utile (vedi pdf-build/layout.json).`);
    if (report.forced.length) warnings.push(`Impaginazione: blocchi troppo grandi anche ridotti: ${report.forced.join(', ')}.`);
    if (qr && !report.qr) warnings.push('QR code del video non inserito: nessuna pagina interna in cui metterlo.');
    await writeJson(path.join(buildDir, 'layout.json'), {
      created_at: new Date().toISOString(), out, pages: report.pages.length, warnings,
      back_logo: backLogo ? { kind: backLogo.kind, bg: backLogo.bg } : null,
      video_url: qr ? qr.url : null,
      images: Object.fromEntries([...images].map(([id, v]) => [id, { width: v.width, height: v.height, bleed: v.bleed }])),
      ...report,
    });
    await context.close();
  } catch (err) {
    aborted();
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await browser.close().catch(() => {});
  }
  progress(100, 'PDF pronto.');
  return out;
}
