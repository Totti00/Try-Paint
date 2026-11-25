// Ingest di un PDF con pdf.js (build "legacy" per Node): testo per pagina e immagini raster incorporate,
// in ordine di disegno, con la loro posizione sulla pagina (si segue la CTM tra save/restore/transform).
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  IngestError, makeProgress, imageId, ensureDir, writeJson, relPath, throwIfAborted,
  canonicalPixels, pixelHash, writeRawPng,
} from './common.js';

const require = createRequire(import.meta.url);
const MIN_SIDE = 24; // immagini più piccole (punti elenco, filetti) non interessano
const OBJ_TIMEOUT_MS = 60_000;

let pdfjsPromise = null;
async function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    const dir = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const lib = await import(pathToFileURL(path.join(dir, 'legacy', 'build', 'pdf.mjs')).href);
    return { lib, dir };
  })().catch((err) => {
    pdfjsPromise = null;
    throw new IngestError('Impossibile caricare la libreria pdf.js (pdfjs-dist): reinstalla le dipendenze con "npm install".', { code: 'pdfjs_missing', cause: err });
  });
  return pdfjsPromise;
}

// Prodotto di matrici affini [a b c d e f] come in pdf.js (Util.transform): m1 · m2.
function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}
const IDENTITY = [1, 0, 0, 1, 0, 0];
const isMatrix = (m) => ((Array.isArray(m) || ArrayBuffer.isView(m)) ? m.length === 6 : false);

/** bbox [x0,y0,x1,y1] in punti, origine in alto a sinistra, dell'unità immagine trasformata da ctm. */
function placementBox(ctm, viewport) {
  const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => {
    const ux = ctm[0] * x + ctm[2] * y + ctm[4];
    const uy = ctm[1] * x + ctm[3] * y + ctm[5];
    return viewport.convertToViewportPoint(ux, uy);
  });
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const r = (v) => Math.round(v * 100) / 100;
  return [r(Math.min(...xs)), r(Math.min(...ys)), r(Math.max(...xs)), r(Math.max(...ys))];
}

function getObject(page, objId) {
  const store = objId.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout immagine ${objId}`)), OBJ_TIMEOUT_MS);
    try {
      store.get(objId, (data) => { clearTimeout(t); resolve(data); }, (err) => { clearTimeout(t); reject(err); });
    } catch (err) {
      clearTimeout(t);
      reject(err);
    }
  });
}

/** Dati immagine pdf.js → pixel grezzi { data, channels }. kind: 1 = bianco/nero 1 bit, 2 = RGB, 3 = RGBA. */
function imageToRaw(img, ImageKind) {
  const { width, height, kind, data } = img;
  if (!data || !width || !height) return null;
  if (kind === ImageKind.RGB_24BPP) return { data, channels: 3 };
  if (kind === ImageKind.RGBA_32BPP) return { data, channels: 4 };
  if (kind === ImageKind.GRAYSCALE_1BPP) {
    const rowBytes = (width + 7) >> 3;
    const out = Buffer.allocUnsafe(width * height);
    for (let y = 0; y < height; y++) {
      const row = y * rowBytes;
      for (let x = 0; x < width; x++) out[y * width + x] = (data[row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
    }
    return { data: out, channels: 1 };
  }
  return null;
}

/** Testo della pagina con a capo ricostruiti. */
function pageText(tc) {
  let text = '';
  let lastY = null;
  for (const it of tc.items) {
    if (typeof it.str !== 'string') continue;
    const y = it.transform ? it.transform[5] : null;
    if (lastY !== null && y !== null && text && !text.endsWith('\n') && Math.abs(y - lastY) > Math.max(2, (it.height || 6) * 0.7)) text += '\n';
    text += it.str;
    if (it.hasEOL) text += '\n';
    if (y !== null) lastY = y;
  }
  return text.replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @returns {Promise<{kind:'pdf', catalog:Array, pages:Array<{page:number,text:string}>, html:null, pdfPath:string, warnings:string[], scanned:boolean}>}
 */
export async function ingestPdf(jobDir, inputPath, onProgress, { signal } = {}) {
  const progress = makeProgress(onProgress);
  const { lib, dir } = await loadPdfjs();
  const { OPS, ImageKind, AnnotationMode } = lib;
  const outDir = await ensureDir(path.join(jobDir, 'estratte'));
  const warnings = [];

  progress(1, 'Apertura del PDF…');
  let bytes;
  try {
    bytes = new Uint8Array(await fs.readFile(inputPath));
  } catch (err) {
    throw new IngestError(`Impossibile leggere il file caricato (${path.basename(inputPath)}).`, { code: 'read_error', cause: err });
  }
  const slash = (p) => p.split(path.sep).join('/') + '/';
  const loadingTask = lib.getDocument({
    data: bytes,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: lib.VerbosityLevel?.ERRORS ?? 0,
    cMapUrl: slash(path.join(dir, 'cmaps')),
    cMapPacked: true,
    standardFontDataUrl: slash(path.join(dir, 'standard_fonts')),
    wasmUrl: slash(path.join(dir, 'wasm')),
  });
  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    await loadingTask.destroy().catch(() => {});
    if (err?.name === 'PasswordException') {
      throw new IngestError('Il PDF è protetto da password: rimuovi la protezione (per esempio aprendolo e stampandolo in un nuovo PDF) e caricalo di nuovo.', { code: 'pdf_password', cause: err });
    }
    if (err?.name === 'InvalidPDFException') {
      throw new IngestError('Il file non è un PDF valido oppure è danneggiato: prova a esportarlo di nuovo in PDF.', { code: 'pdf_corrupt', cause: err });
    }
    throw new IngestError(`Impossibile aprire il PDF: ${err?.message || err}`, { code: 'pdf_error', cause: err });
  }

  const catalog = [];
  const pages = [];
  const seen = new Map(); // hash -> id
  let textChars = 0;
  let bigImagePages = 0;
  try {
    const numPages = doc.numPages;
    if (!numPages) throw new IngestError('Il PDF non contiene pagine.', { code: 'pdf_empty' });
    for (let p = 1; p <= numPages; p++) {
      throwIfAborted(signal);
      progress(2 + (p - 1) / numPages * 95, `Lettura della pagina ${p} di ${numPages}…`);
      let page;
      try {
        page = await doc.getPage(p);
      } catch (err) {
        warnings.push(`Pagina ${p}: impossibile leggerla (${err?.message || err}).`);
        pages.push({ page: p, text: '' });
        continue;
      }
      const viewport = page.getViewport({ scale: 1 });
      const pageArea = viewport.width * viewport.height;

      // --- testo
      try {
        const tc = await page.getTextContent();
        const text = pageText(tc);
        textChars += text.replace(/\s+/g, '').length;
        pages.push({ page: p, text });
      } catch (err) {
        warnings.push(`Pagina ${p}: testo non leggibile (${err?.message || err}).`);
        pages.push({ page: p, text: '' });
      }

      // --- immagini, in ordine di disegno
      let ol;
      try {
        ol = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
      } catch (err) {
        warnings.push(`Pagina ${p}: impossibile analizzare il contenuto grafico (${err?.message || err}).`);
        page.cleanup();
        continue;
      }
      const placements = [];
      let ctm = IDENTITY;
      const stack = [];
      const { fnArray, argsArray } = ol;
      for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i];
        const args = argsArray[i];
        switch (fn) {
          case OPS.save: stack.push(ctm); break;
          case OPS.restore: ctm = stack.length ? stack.pop() : IDENTITY; break;
          case OPS.transform: if (args && args.length === 6) ctm = mul(ctm, args); break;
          case OPS.paintFormXObjectBegin:
            stack.push(ctm);
            if (args && isMatrix(args[0])) ctm = mul(ctm, Array.from(args[0]));
            break;
          case OPS.paintFormXObjectEnd: ctm = stack.length ? stack.pop() : IDENTITY; break;
          case OPS.beginGroup:
            stack.push(ctm);
            if (args && args[0] && isMatrix(args[0].matrix)) ctm = mul(ctm, Array.from(args[0].matrix));
            break;
          case OPS.endGroup: ctm = stack.length ? stack.pop() : IDENTITY; break;
          case OPS.paintImageXObject:
            placements.push({ objId: args[0], ctm });
            break;
          case OPS.paintInlineImageXObject:
            placements.push({ inline: args[0], ctm });
            break;
          case OPS.paintImageXObjectRepeat: {
            // [objId, scaleX, scaleY, positions]: stessa immagine ripetuta; si registra la prima posizione
            const [objId, sx, sy, pos] = args;
            const m = pos && pos.length >= 2 ? [sx, 0, 0, sy, pos[0], pos[1]] : [sx, 0, 0, sy, 0, 0];
            placements.push({ objId, ctm: mul(ctm, m) });
            break;
          }
          // paintImageMaskXObject*, paintSolidColorImageMask: maschere (non sono figure) → ignorate.
          // paintInlineImageXObjectGroup: atlante di tante piccole immagini in linea → ignorato.
          default: break;
        }
      }

      let indexOnPage = 0;
      let pageHasBig = false;
      for (const pl of placements) {
        throwIfAborted(signal);
        let img;
        try {
          img = pl.inline ?? await getObject(page, pl.objId);
        } catch (err) {
          warnings.push(`Pagina ${p}: un’immagine non è stata decodificata (${err?.message || err}).`);
          continue;
        }
        if (!img) continue;
        if (img.bitmap && !img.data) {
          warnings.push(`Pagina ${p}: formato immagine non leggibile in Node, saltata.`);
          continue;
        }
        const { width, height } = img;
        if (!width || !height || width < MIN_SIDE || height < MIN_SIDE) continue;
        const bbox = placementBox(pl.ctm, viewport);
        // immagine fuori dalla pagina: invisibile
        if (bbox[2] <= 0 || bbox[3] <= 0 || bbox[0] >= viewport.width || bbox[1] >= viewport.height) continue;
        const raw = imageToRaw(img, ImageKind);
        if (!raw) {
          warnings.push(`Pagina ${p}: tipo di immagine non gestito (kind ${img.kind}), saltata.`);
          continue;
        }
        const canon = canonicalPixels(raw.data, width, height, raw.channels);
        const hash = pixelHash(canon.buf, width, height, canon.channels);
        const id = imageId(catalog.length);
        const file = path.join(outDir, `${id}.png`);
        // il PNG resta in scala di grigi se lo era (file più piccolo)
        if (raw.channels === 1) await writeRawPng(file, Buffer.from(raw.data), width, height, 1);
        else await writeRawPng(file, canon.buf, width, height, canon.channels);
        const dup = seen.get(hash) ?? null;
        if (!dup) seen.set(hash, id);
        const area = Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
        if (area > pageArea * 0.6) pageHasBig = true;
        catalog.push({
          id, page: p, index: indexOnPage++, width, height,
          file: relPath(jobDir, file), bbox, duplicate_of: dup,
        });
      }
      if (pageHasBig) bigImagePages++;
      page.cleanup();
    }

    const scanned = textChars < 25 * numPages;
    if (scanned) {
      warnings.unshift(catalog.length
        ? 'Il PDF sembra una scansione: Claude leggerà le pagine come immagini.'
        : 'Il PDF non contiene testo selezionabile né immagini riconoscibili: Claude leggerà le pagine come immagini.');
    }
    throwIfAborted(signal);
    progress(98, `Trovate ${catalog.filter((c) => !c.duplicate_of).length} immagini su ${numPages} pagine.`);
    await writeJson(path.join(outDir, 'catalog.json'), catalog);
    await writeJson(path.join(outDir, 'text.json'), { kind: 'pdf', pages, warnings, scanned, big_image_pages: bigImagePages });
    progress(100, 'Lettura del PDF completata.');
    return { kind: 'pdf', catalog, pages, html: null, pdfPath: path.resolve(inputPath), warnings, scanned };
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}
