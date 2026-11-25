// Estrazione della scheda ManualData con Claude.
//
//   extractManual(jobDir, ingestResult, onProgress, { signal, model, baseURL }?) → ManualData (riparata)
//     Scrive manual.ai.json (risposta di Claude validata, non modificata) e manual.json (dopo la riparazione dei
//     riferimenti). Un manual.json già presente viene prima copiato in manual.precedente.json.
//   buildExtractContent(jobDir, ingestResult) → { content, stats }   (blocchi del messaggio, utile per i test)
//
// Modalità test: MANUALI_AI_FIXTURE=/percorso/manual.json → nessuna chiamata a Claude, si usa quel file.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ManualData } from '../schema.js';
import { callStructuredDetailed, AiError } from './client.js';
import { repairManual } from './repair.js';
import { appendJobLog } from './log.js';
import { writeJsonAtomic } from '../fsutil.js';

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
const MAX_IMAGE_BLOCKS = 90;        // l'API accetta fino a 100 immagini per richiesta: margine di sicurezza
const MAX_PDF_PAGES = 600;
const promptCache = new Map();

/** Prompt di sistema da src/ai/prompts/<name>.md (letto una volta). */
export async function loadPrompt(name) {
  if (!promptCache.has(name)) {
    const file = path.join(PROMPTS_DIR, `${name}.md`);
    try {
      promptCache.set(name, (await fs.readFile(file, 'utf8')).replace(/^﻿/, '').trim());
    } catch (err) {
      throw new AiError(`Manca il file del prompt ${path.basename(file)} (src/ai/prompts): reinstalla lo strumento.`, { code: 'prompt_missing', cause: err });
    }
  }
  return promptCache.get(name);
}

function makeProgress(onProgress) {
  let last = 0;
  return (pct, message) => {
    if (typeof onProgress !== 'function') return;
    if (typeof pct === 'number' && Number.isFinite(pct)) last = Math.max(last, Math.min(100, Math.round(pct)));
    try {
      const r = onProgress(last, message);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* il callback non deve fermare il lavoro */ }
  };
}

const exists = (f) => fs.access(f).then(() => true, () => false);

async function writeJson(file, data) {
  await writeJsonAtomic(file, data);
}

// ------------------------------------------------------------------------------------- ingest da disco

/**
 * Se il chiamante non ha più il risultato dell'ingest (es. "rianalizza"), lo ricostruisce da estratte/ e input/.
 */
export async function loadIngestFromDisk(jobDir) {
  const readJson = async (f) => JSON.parse(await fs.readFile(f, 'utf8'));
  let catalog = [];
  let text = {};
  try { catalog = await readJson(path.join(jobDir, 'estratte', 'catalog.json')); } catch { catalog = []; }
  try { text = await readJson(path.join(jobDir, 'estratte', 'text.json')); } catch { text = {}; }
  let files = [];
  try { files = await fs.readdir(path.join(jobDir, 'input')); } catch { files = []; }
  const pdf = files.find((f) => f.toLowerCase().endsWith('.pdf'));
  const docx = files.find((f) => /\.(docx|docm|dotx)$/i.test(f));
  const kind = text.kind || (pdf ? 'pdf' : docx ? 'docx' : null);
  if (!kind) throw new AiError('Non trovo il documento estratto di questo lavoro: ricaricalo.', { code: 'ingest_missing' });
  return {
    kind,
    catalog: Array.isArray(catalog) ? catalog : [],
    pages: Array.isArray(text.pages) ? text.pages : [],
    html: typeof text.html === 'string' ? text.html : null,
    pdfPath: kind === 'pdf' && pdf ? path.join(jobDir, 'input', pdf) : null,
    warnings: Array.isArray(text.warnings) ? text.warnings : [],
    scanned: !!text.scanned,
    inputName: pdf || docx || null,
  };
}

// ------------------------------------------------------------------------------------- contenuto

async function imageBlock(jobDir, entry) {
  const thumb = path.join(jobDir, 'immagini', 'thumb', `${entry.id}.jpg`);
  let buf = null;
  try { buf = await fs.readFile(thumb); } catch { buf = null; }
  if (!buf || !buf.length) {
    if (!entry.file) throw new Error('file mancante nel catalogo');
    const src = path.join(jobDir, ...String(entry.file).split('/'));
    buf = await sharp(src, { failOn: 'none' })
      .rotate()
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82 })
      .toBuffer();
  }
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } };
}

function imageLabel(entry, kind) {
  const parts = [entry.id];
  if (kind === 'pdf' && entry.page) parts.push(`pagina ${entry.page}`);
  if (entry.width && entry.height) parts.push(`${entry.width}×${entry.height} px`);
  if (Array.isArray(entry.bbox) && entry.bbox.length === 4 && entry.bbox.every(Number.isFinite)) {
    const [x0, y0, x1, y1] = entry.bbox.map((v) => Math.round(v));
    parts.push(`riquadro sulla pagina x ${x0}–${x1}, y ${y0}–${y1} pt (origine in alto a sinistra)`);
  }
  if (kind === 'docx') parts.push(`segnaposto [[${entry.id}]] nel testo`);
  return parts.join(' — ');
}

/**
 * Blocchi del messaggio per Claude: documento (PDF) o HTML (DOCX), catalogo immagini etichettato, istruzione finale.
 * @returns {{ content: object[], stats: { kind, images, attached, duplicates, skipped, pdfBytes, htmlChars } }}
 */
export async function buildExtractContent(jobDir, ingest, onProgress) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  const kind = ingest?.kind;
  if (kind !== 'pdf' && kind !== 'docx') throw new AiError('Tipo di documento sconosciuto: ricarica il file (PDF o Word .docx).', { code: 'ingest_invalid' });
  const catalog = Array.isArray(ingest.catalog) ? ingest.catalog.filter((c) => c && typeof c.id === 'string') : [];
  const content = [];
  const stats = { kind, images: catalog.length, attached: 0, duplicates: 0, skipped: [], pdfBytes: 0, htmlChars: 0 };
  const name = ingest.inputName || (ingest.pdfPath ? path.basename(ingest.pdfPath) : null);
  const notes = [];
  if (ingest.scanned) notes.push('Il PDF sembra una scansione (quasi senza testo selezionabile): leggi il testo dalle immagini delle pagine.');
  for (const w of (ingest.warnings || []).slice(0, 10)) notes.push(`Avviso della lettura del file: ${w}`);

  if (kind === 'pdf') {
    if (!ingest.pdfPath) throw new AiError('Manca il file PDF originale di questo lavoro: ricaricalo.', { code: 'ingest_invalid' });
    let pdf;
    try { pdf = await fs.readFile(ingest.pdfPath); } catch (err) {
      throw new AiError(`Non riesco a leggere il PDF originale (${path.basename(ingest.pdfPath)}): ricaricalo.`, { code: 'ingest_invalid', cause: err });
    }
    const nPages = Array.isArray(ingest.pages) ? ingest.pages.length : 0;
    if (nPages > MAX_PDF_PAGES) {
      throw new AiError(`Il PDF ha ${nPages} pagine: Claude ne legge al massimo ${MAX_PDF_PAGES} per volta. Dividilo in parti più piccole.`, { code: 'too_large' });
    }
    stats.pdfBytes = pdf.length;
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
      ...(name ? { title: name } : {}),
    });
    const desc = [name ? `«${name}»` : null, nPages ? `${nPages} pagine` : null].filter(Boolean).join(', ');
    content.push({
      type: 'text',
      text: `Qui sopra c’è il manuale originale in PDF${desc ? ` (${desc})` : ''}.` + (notes.length ? '\n' + notes.join('\n') : ''),
    });
  } else {
    let html = typeof ingest.html === 'string' ? ingest.html : '';
    if (!html.trim() && Array.isArray(ingest.pages)) html = ingest.pages.map((p) => p.text || '').join('\n\n');
    if (!html.trim()) throw new AiError('Il documento Word non contiene testo leggibile.', { code: 'ingest_empty' });
    stats.htmlChars = html.length;
    content.push({
      type: 'text',
      text: `Manuale originale: documento Word${name ? ` «${name}»` : ''} convertito in HTML semplice. ` +
        'I segnaposto [[img_XX]] indicano il punto esatto in cui compare ogni immagine; <strong>/<b> = grassetto, <u> = sottolineato.' +
        (notes.length ? '\n' + notes.join('\n') : '') +
        `\n\n<documento>\n${html}\n</documento>`,
    });
  }

  // --- catalogo immagini
  const originals = catalog.filter((c) => !c.duplicate_of);
  if (catalog.length) {
    content.push({
      type: 'text',
      text: `Catalogo delle immagini estratte dal documento (${catalog.length}, in ordine di apparizione). ` +
        'Ogni etichetta è seguita dall’immagine in piccolo; le immagini identiche a una precedente non sono allegate di nuovo.',
    });
    let i = 0;
    for (const entry of catalog) {
      i++;
      if (entry.duplicate_of) {
        stats.duplicates++;
        content.push({ type: 'text', text: `${imageLabel(entry, kind)} — identica a ${entry.duplicate_of} (non allegata di nuovo)` });
        continue;
      }
      if (stats.attached >= MAX_IMAGE_BLOCKS) {
        stats.skipped.push(entry.id);
        content.push({ type: 'text', text: `${imageLabel(entry, kind)} — (non allegata: troppe immagini; guardala nelle pagine del documento)` });
        continue;
      }
      try {
        const block = await imageBlock(jobDir, entry);
        content.push({ type: 'text', text: imageLabel(entry, kind) });
        content.push(block);
        stats.attached++;
      } catch (err) {
        stats.skipped.push(entry.id);
        content.push({ type: 'text', text: `${imageLabel(entry, kind)} — (immagine non leggibile: guardala nelle pagine del documento)` });
        await appendJobLog(jobDir, `immagine ${entry.id} non allegata a Claude: ${err?.message || err}`);
      }
      progress(Math.round((i / catalog.length) * 100));
    }
  }

  const ids = catalog.map((c) => c.id);
  content.push({
    type: 'text',
    text: 'Compila ora la scheda ManualData di questo manuale seguendo tutte le regole.\n' +
      (ids.length
        ? `Id immagine validi (${ids.length}): ${ids.join(', ')}. Non usare altri id.` +
          (originals.length !== ids.length ? ' Le immagini identiche hanno id diversi: puoi usare l’uno o l’altro.' : '')
        : 'Il documento non contiene immagini: usa null per tutti gli image_id e [] per image_ids e unused_image_ids.'),
  });
  return { content, stats };
}

// ------------------------------------------------------------------------------------- estrazione

async function saveResults(jobDir, raw, catalog, log) {
  const { manual, repairs } = repairManual(raw, catalog);
  for (const r of repairs) await log(`riparazione: ${r}`);
  if (!repairs.length) await log('nessuna riparazione necessaria');
  await writeJson(path.join(jobDir, 'manual.ai.json'), raw);
  const cur = path.join(jobDir, 'manual.json');
  if (await exists(cur)) await fs.copyFile(cur, path.join(jobDir, 'manual.precedente.json')).catch(() => {});
  await writeJson(cur, manual);
  return { manual, repairs };
}

/**
 * @param {string} jobDir
 * @param {object|null} ingestResult  risultato di ingestDocument (se null si ricostruisce da disco)
 * @param {(pct:number, message:string)=>void} [onProgress]
 * @param {{ signal?: AbortSignal, model?: string, baseURL?: string, apiKey?: string }} [options]
 */
export async function extractManual(jobDir, ingestResult, onProgress, options = {}) {
  if (!jobDir) throw new TypeError('extractManual: cartella del lavoro obbligatoria.');
  const progress = makeProgress(onProgress);
  const log = (m) => appendJobLog(jobDir, m);
  const ingest = ingestResult || (await loadIngestFromDisk(jobDir));
  const catalog = Array.isArray(ingest.catalog) ? ingest.catalog : null;

  // --- modalità test
  const fixture = process.env.MANUALI_AI_FIXTURE;
  if (fixture) {
    progress(10, 'MODALITÀ TEST: lettura della scheda di prova (nessuna chiamata a Claude)…');
    await log(`MODALITÀ TEST: scheda letta da ${fixture} — nessuna chiamata a Claude (MANUALI_AI_FIXTURE)`);
    let json;
    try {
      json = JSON.parse(await fs.readFile(fixture, 'utf8'));
    } catch (err) {
      throw new AiError(`MODALITÀ TEST: non riesco a leggere la scheda di prova ${fixture}: ${err?.message || err}`, { code: 'fixture_invalid', cause: err });
    }
    const r = ManualData.safeParse(json);
    if (!r.success) {
      const why = r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(radice)'}: ${i.message}`).join('; ');
      throw new AiError(`MODALITÀ TEST: la scheda di prova ${path.basename(fixture)} non è valida (${why}).`, { code: 'fixture_invalid' });
    }
    progress(80, 'MODALITÀ TEST: controllo dei riferimenti…');
    const { manual } = await saveResults(jobDir, r.data, catalog, log);
    progress(100, `MODALITÀ TEST: scheda pronta (${manual.steps.length} passi).`);
    return manual;
  }

  // --- chiamata a Claude
  progress(2, 'Preparazione del documento per Claude…');
  const system = await loadPrompt('extract');
  const { content, stats } = await buildExtractContent(jobDir, ingest, (p) => progress(2 + p * 0.08, 'Preparazione delle immagini per Claude…'));
  await log(`estrazione: ${stats.kind}, ${stats.images} immagini nel catalogo (${stats.attached} allegate, ${stats.duplicates} duplicate` +
    `${stats.skipped.length ? ', non allegate: ' + stats.skipped.join(' ') : ''})`);

  // Avanzamento durante la chiamata: 12 → 40 % mentre Claude ragiona, 40 → 92 % mentre scrive.
  const onCall = (_pct, message, info) => {
    let pct = null;
    if (info?.phase === 'writing') pct = 40 + 52 * (1 - Math.exp(-(info.outputTokens || 0) / 6000));
    else if (info?.phase === 'thinking' || info?.phase === 'reading') pct = 12 + 28 * (1 - Math.exp(-(info.elapsedMs || 0) / 120000));
    else if (info) pct = 12;
    progress(pct, message);
  };
  progress(12, 'Invio del documento a Claude…');
  const res = await callStructuredDetailed({
    system,
    content,
    schema: ManualData,
    maxTokens: 64000,
    effort: 'high',
    onProgress: onCall,
    jobDir,
    label: 'estrazione scheda',
    signal: options.signal,
    model: options.model,
    baseURL: options.baseURL,
    apiKey: options.apiKey,
  });

  progress(94, 'Controllo della scheda…');
  const { manual, repairs } = await saveResults(jobDir, res.data, catalog, log);
  const toCheck = manual.changes.filter((c) => c.needs_confirmation).length;
  await log(`scheda pronta: ${manual.steps.length} passi, ${manual.components.length} componenti, ${manual.hardware.length} tipi di ferramenta, ` +
    `${manual.changes.length} modifiche (${toCheck} da confermare), ${repairs.length} riparazioni — costo ${res.costText}`);
  progress(100, `Scheda pronta: ${manual.steps.length} passi${toCheck ? `, ${toCheck} punti da verificare` : ''} (costo stimato ${res.costText}).`);
  return manual;
}
