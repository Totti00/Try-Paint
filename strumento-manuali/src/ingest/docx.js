// Ingest di un documento Word (.docx) con mammoth: HTML semplice con segnaposto [[img_XX]] nell'ordine
// del documento + immagini convertite in PNG con sharp.
import fs from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import {
  IngestError, makeProgress, imageId, ensureDir, writeJson, relPath,
  decodeToCanonical, pixelHash, writeRawPng,
  throwIfAborted,
} from './common.js';

const MIN_SIDE = 24;
const VECTOR_UNSUPPORTED = /^image\/(x-)?(emf|wmf|x-emf|x-wmf)$/i;
const TOKEN = (n) => `__MANUALI_IMG_${n}__`;

const STYLE_MAP = [
  'u => u',
  'strike => s',
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Titolo'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  "p[style-name='Sottotitolo'] => h2:fresh",
  "p[style-name='Titolo 1'] => h1:fresh",
  "p[style-name='Titolo 2'] => h2:fresh",
  "p[style-name='Titolo 3'] => h3:fresh",
  "p[style-name='Titolo 4'] => h4:fresh",
];

/** Ripulisce l'HTML di mammoth: niente link/attributi (il testo va a Claude e all'interfaccia). */
function sanitizeHtml(html) {
  return html
    .replace(/<a\b[^>]*>/gi, '')
    .replace(/<\/a>/gi, '')
    .replace(/<(\/?)(h[1-6]|p|ul|ol|li|table|thead|tbody|tr|td|th|strong|em|u|s|sup|sub|br)\b([^>]*)>/gi, (m, slash, tag, attrs) => {
      const t = tag.toLowerCase();
      if (slash) return `</${t}>`;
      let keep = '';
      if (t === 'td' || t === 'th') {
        const cs = /colspan="(\d+)"/i.exec(attrs);
        const rs = /rowspan="(\d+)"/i.exec(attrs);
        if (cs) keep += ` colspan="${cs[1]}"`;
        if (rs) keep += ` rowspan="${rs[1]}"`;
      }
      return t === 'br' ? '<br>' : `<${t}${keep}>`;
    })
    // qualunque altro tag sconosciuto viene tolto (resta il testo)
    .replace(/<(?!\/?(h[1-6]|p|ul|ol|li|table|thead|tbody|tr|td|th|strong|em|u|s|sup|sub|br)\b)[^>]+>/gi, '')
    .replace(/<p>\s*<\/p>/g, '');
}

/** Per leggibilità (Claude): un blocco per riga. */
function prettyHtml(html) {
  return html
    .replace(/(<\/(p|h[1-6]|li|tr|table|ul|ol)>)/g, '$1\n')
    .replace(/(<(table|ul|ol|tr)\b[^>]*>)/g, '$1\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Trova la fine (indice dopo </ol>) dell'elenco che inizia in `start` e conta i suoi <li> di primo livello. */
function scanList(html, start) {
  const re = /<(\/?)(ol|ul|li)\b[^>]*>/g;
  re.lastIndex = start;
  let depth = 0;
  let items = 0;
  let m;
  while ((m = re.exec(html))) {
    const closing = m[1] === '/';
    if (m[2] === 'li') { if (!closing && depth === 1) items++; continue; }
    depth += closing ? -1 : 1;
    if (depth === 0) return { end: re.lastIndex, items };
  }
  return { end: html.length, items };
}

/**
 * Word interrompe gli elenchi numerati con i paragrafi delle figure: mammoth produce tanti <ol> che
 * ripartono da 1. Se due <ol> sono separati solo da immagini, il secondo prosegue la numerazione (start="N").
 */
function continueNumbering(html) {
  const onlyImages = /^(?:\s*<p>(?:\s*(?:\[\[img_\d+\]\]|\[immagine[^\]]*\]))+\s*<\/p>)*\s*$/;
  let out = '';
  let pos = 0;
  let prev = null; // { end, next } dell'elenco precedente
  const re = /<ol>/g;
  let m;
  while ((m = re.exec(html))) {
    const start = m.index;
    const { end, items } = scanList(html, start);
    let first = 1;
    if (prev && onlyImages.test(html.slice(prev.end, start))) first = prev.next;
    out += html.slice(pos, start) + (first > 1 ? `<ol start="${first}">` : '<ol>');
    pos = start + m[0].length;
    prev = { end, next: first + items };
    re.lastIndex = end;
    out += html.slice(pos, end);
    pos = end;
  }
  return out + html.slice(pos);
}

/**
 * @returns {Promise<{kind:'docx', catalog:Array, pages:[], html:string, pdfPath:null, warnings:string[]}>}
 */
export async function ingestDocx(jobDir, inputPath, onProgress, { signal } = {}) {
  const progress = makeProgress(onProgress);
  const outDir = await ensureDir(path.join(jobDir, 'estratte'));
  const warnings = [];
  progress(2, 'Apertura del documento Word…');

  let buffer;
  try {
    buffer = await fs.readFile(inputPath);
  } catch (err) {
    throw new IngestError(`Impossibile leggere il file caricato (${path.basename(inputPath)}).`, { code: 'read_error', cause: err });
  }

  // Le immagini vengono annotate con un segnaposto univoco: gli id definitivi si assegnano dopo,
  // nell'ordine in cui compaiono nell'HTML (= ordine del documento), anche se mammoth le legge in parallelo.
  const pending = [];
  const convertImage = mammoth.images.imgElement((image) => {
    const n = pending.length;
    pending.push({ contentType: image.contentType || '', read: () => image.readAsBuffer() });
    return { src: TOKEN(n) };
  });

  let result;
  try {
    result = await mammoth.convertToHtml({ buffer }, { styleMap: STYLE_MAP, convertImage, ignoreEmptyParagraphs: true });
  } catch (err) {
    const msg = String(err?.message || err);
    if (/central directory|zip|end of data|corrupt/i.test(msg)) {
      throw new IngestError('Il documento Word è danneggiato o non è un vero file .docx: aprilo in Word e salvalo di nuovo come .docx.', { code: 'docx_corrupt', cause: err });
    }
    if (/main document part|word\/document\.xml/i.test(msg)) {
      throw new IngestError('Il file non sembra un documento Word (.docx): manca il contenuto principale.', { code: 'docx_invalid', cause: err });
    }
    throw new IngestError(`Impossibile leggere il documento Word: ${msg}`, { code: 'docx_error', cause: err });
  }
  for (const m of result.messages || []) {
    if (m.type === 'error') warnings.push(`Word: ${m.message}`);
  }
  throwIfAborted(signal);
  progress(40, 'Testo letto, conversione delle immagini…');

  let html = result.value || '';
  const order = [];
  html.replace(/<img\b[^>]*?src="__MANUALI_IMG_(\d+)__"[^>]*>/g, (m, n) => { order.push(Number(n)); return m; });

  const catalog = [];
  const seen = new Map();
  const replacement = new Map(); // n -> testo che sostituisce il tag
  for (let k = 0; k < order.length; k++) {
    const n = order[k];
    throwIfAborted(signal);
    if (replacement.has(n)) continue;
    const item = pending[n];
    progress(40 + (k / Math.max(1, order.length)) * 55, `Immagine ${k + 1} di ${order.length}…`);
    const type = (item?.contentType || '').toLowerCase();
    if (VECTOR_UNSUPPORTED.test(type) || /emf|wmf/.test(type)) {
      const fmt = /emf/.test(type) ? 'EMF' : 'WMF';
      warnings.push(`Un’immagine in formato ${fmt} (grafica vettoriale di Office) non è supportata ed è stata saltata: se serve, salvala come PNG o JPG nel documento.`);
      replacement.set(n, `[immagine ${fmt} non supportata]`);
      continue;
    }
    let canon;
    try {
      const buf = await item.read();
      canon = await decodeToCanonical(buf);
    } catch (err) {
      warnings.push(`Un’immagine (${type || 'tipo sconosciuto'}) non è leggibile ed è stata saltata.`);
      replacement.set(n, '[immagine non leggibile]');
      continue;
    }
    if (canon.width < MIN_SIDE || canon.height < MIN_SIDE) {
      replacement.set(n, '');
      continue;
    }
    const id = imageId(catalog.length);
    const file = path.join(outDir, `${id}.png`);
    await writeRawPng(file, canon.buf, canon.width, canon.height, canon.channels);
    const hash = pixelHash(canon.buf, canon.width, canon.height, canon.channels);
    const dup = seen.get(hash) ?? null;
    if (!dup) seen.set(hash, id);
    catalog.push({
      id, page: null, index: catalog.length, width: canon.width, height: canon.height,
      file: relPath(jobDir, file), bbox: null, duplicate_of: dup,
    });
    replacement.set(n, `[[${id}]]`);
  }
  html = html.replace(/<img\b[^>]*?src="__MANUALI_IMG_(\d+)__"[^>]*>/g, (m, n) => replacement.get(Number(n)) ?? '');
  html = prettyHtml(continueNumbering(sanitizeHtml(html.replace(/<img\b[^>]*>/g, ''))));

  const textLen = html.replace(/<[^>]+>/g, '').replace(/\[\[img_\d+\]\]/g, '').replace(/\s+/g, '').length;
  if (textLen < 30) warnings.push('Il documento Word contiene pochissimo testo: controlla che le istruzioni non siano dentro immagini.');

  await writeJson(path.join(outDir, 'catalog.json'), catalog);
  await writeJson(path.join(outDir, 'text.json'), { kind: 'docx', html, warnings });
  progress(100, `Documento letto: ${catalog.filter((c) => !c.duplicate_of).length} immagini.`);
  return { kind: 'docx', catalog, pages: [], html, pdfPath: null, warnings };
}
