#!/usr/bin/env node
// Strumento manuali — server locale: interfaccia web, API HTTP e coda dei lavori.
//
//   node server.js        (oppure npm start, oppure gli script avvia-*)
//
// Variabili d'ambiente:
//   PORT (predefinita 3210)   HOST (predefinito 127.0.0.1: raggiungibile solo da questo computer)
//   MANUALI_ALLOWED_HOSTS     nomi/indirizzi in più accettati nell'intestazione Host (es. "192.168.1.20,pc-ufficio.local"),
//                             per l'uso da altri computer o in Docker; sempre accettati: localhost, 127.0.0.1, [::1]
//   NO_BROWSER=1              non aprire il browser all'avvio
//   MANUALI_JOBS_DIR          cartella dei lavori (predefinita ./lavori)
//   MANUALI_CONFIG_DIR        cartella delle impostazioni (predefinita ./config)
//   MANUALI_AI_FIXTURE / MANUALI_PLAN_FIXTURE   modalità test senza Claude (vedi ARCHITETTURA.md)
//
// Le operazioni pesanti (analisi, PDF, video, lettura del modello 3D) passano da UNA coda sequenziale:
// una alla volta, nell'ordine di arrivo (le azioni chieste dall'utente passano davanti alla lettura del
// modello 3D fatta in sottofondo). Avanzamento → job.json + Server-Sent Events.

import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { ManualData, AnimationPlan } from './src/schema.js';
import {
  jobsRoot, jobDir, jobPath, isValidJobId, createJob, listJobs, getJob, updateJob, deleteJob, appendLog,
  markInterrupted, sweepOrphans, flushAll, events, emptyModel3d, safeFileName, displayName, prettyName, JobError,
} from './src/jobs.js';
import { writeJsonAtomic as writeJsonFile } from './src/fsutil.js';
import { getSettings, saveSettings, SettingsError, DEFAULT_MODEL, DEFAULT_THEME } from './src/settings.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const FONTS_DIR = path.join(ROOT, 'assets', 'fonts');
const PKG = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));

const PORT = /^\d{1,5}$/.test(String(process.env.PORT ?? '').trim()) ? Number(process.env.PORT) : 3210;
const HOST = process.env.HOST || '127.0.0.1';
const LOCK_FILE = () => path.join(jobsRoot(), '.server.lock');
const NO_BROWSER = /^(1|true|si|sì|yes)$/i.test(process.env.NO_BROWSER || '');

export const DOC_EXTS = ['pdf', 'docx'];
export const MODEL_EXTS = ['step', 'stp', 'iges', 'igs', 'glb', 'gltf', 'obj', 'stl'];
const MB = 1024 * 1024;
const DOC_MAX = 100 * MB;
const MODEL_MAX = 300 * MB;
const OUT_FILES = {
  'manuale.pdf': { rel: ['out', 'manuale.pdf'], type: 'application/pdf', name: (s) => `Istruzioni_Montaggio_${s}.pdf` },
  'video.mp4': { rel: ['out', 'video.mp4'], type: 'video/mp4', name: (s) => `Montaggio_${s}.mp4` },
  'poster.jpg': { rel: ['out', 'poster.jpg'], type: 'image/jpeg', name: (s) => `Montaggio_${s}_copertina.jpg` },
};
const IMG_ID_RE = /^img_\d{1,4}$/;
const VIEW_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,80}\.png$/;

// ============================================================================================ utilità

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

/** Errore pensato per l'utente (nessun dettaglio tecnico da aggiungere). */
class UserError extends Error {
  constructor(message, code = 'user') { super(message); this.code = code; }
}

class CancelledError extends Error {
  constructor() { super('Operazione annullata.'); this.name = 'CancelledError'; this.code = 'cancelled'; }
}

const nowIso = () => new Date().toISOString();
const exists = (p) => fs.access(p).then(() => true, () => false);

async function readJson(file, fallback = null) {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, data) {
  try {
    await writeJsonFile(file, data); // temporaneo con nome unico + rename con nuovi tentativi (Windows)
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES') {
      throw new HttpError(409, 'Il file della scheda è bloccato da un altro programma: chiudilo e riprova a salvare.');
    }
    throw err;
  }
}

/**
 * Accessi a manual.json di un lavoro in fila: il salvataggio dalla revisione (scrittura + manual_saved_at) e la
 * lettura della scheda da parte del PDF/video (scheda + manual_saved_at) non si mescolano mai.
 */
const manualChains = new Map();
function withManualLock(id, fn) {
  const prev = manualChains.get(id) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  manualChains.set(id, tail);
  tail.then(() => { if (manualChains.get(id) === tail) manualChains.delete(id); });
  return run;
}

/** "Tavolo Levante" → "Tavolo_Levante" (sicuro come nome di file su Windows, macOS e Linux). */
export function fileSafeName(s) {
  const out = String(s ?? '').normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[\s_]+/g, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 80);
  return out || 'Manuale';
}

const fmtUsd = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtUsd3 = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const usdText = (v) => `${v > 0 && v < 0.1 ? fmtUsd3.format(v) : fmtUsd.format(v)} $`;

/** Costo stimato delle chiamate a Claude di questo lavoro (dal registro ai-usage.json scritto da src/ai). */
async function readCost(dir) {
  const list = await readJson(path.join(dir, 'ai-usage.json'), null);
  if (!Array.isArray(list) || !list.length) return null;
  let usd = 0;
  let approx = false;
  const byLabel = new Map();
  for (const r of list) {
    const v = Number(r?.cost_usd) || 0;
    usd += v;
    if (r?.approx) approx = true;
    const label = String(r?.label || 'richiesta');
    byLabel.set(label, (byLabel.get(label) || 0) + v);
  }
  return {
    usd: Math.round(usd * 10000) / 10000,
    text: usdText(usd),
    calls: list.length,
    approx,
    items: [...byLabel].map(([label, v]) => ({ label, usd: Math.round(v * 10000) / 10000, text: usdText(v) })),
  };
}

function isTestModeAi() { return !!process.env.MANUALI_AI_FIXTURE; }
function isTestModePlan() { return !!process.env.MANUALI_PLAN_FIXTURE; }

// -------------------------------------------------------------------------------------- validazione scheda

const FIELD_LABELS = {
  version: 'Versione', language: 'Lingua', document_title: 'Titolo del documento', short_name: 'Nome breve',
  products: 'Prodotti', footer_text: 'Testo a piè di pagina', cover_image_id: 'Immagine di copertina',
  brand_logo_image_id: 'Logo', hardware: 'Ferramenta', components: 'Componenti', phases: 'Fasi', steps: 'Passi',
  notes: 'Note', unused_image_ids: 'Immagini non usate', changes: 'Modifiche fatte dall’AI',
  category: 'Categoria', names: 'Nomi', id: 'Sigla', name: 'Nome', spec: 'Specifica', qty: 'Quantità',
  image_id: 'Immagine', code: 'Sigla', ref: 'Pezzo', number: 'Numero', title: 'Titolo', paragraphs: 'Testo',
  image_ids: 'Immagini', uses: 'Pezzi usati', warning: 'Avvertenza', step_numbers: 'Passi della fase',
  label: 'Etichetta', text: 'Testo', kind: 'Tipo', description: 'Descrizione', needs_confirmation: 'Da confermare',
};
const ITEM_LABELS = {
  products: 'Gruppo di prodotti', hardware: 'Ferramenta', components: 'Componente', phases: 'Fase', steps: 'Passo',
  notes: 'Nota', changes: 'Modifica', paragraphs: 'Paragrafo', uses: 'Pezzo', image_ids: 'Immagine', names: 'Nome',
  step_numbers: 'Passo', unused_image_ids: 'Immagine',
};

function pathLabel(p) {
  const parts = [];
  for (let i = 0; i < p.length; i++) {
    const seg = p[i];
    if (typeof seg === 'number') {
      const parent = p[i - 1];
      const item = ITEM_LABELS[parent] || 'Elemento';
      if (parts.length && FIELD_LABELS[parent] && parts[parts.length - 1] === FIELD_LABELS[parent]) parts.pop();
      parts.push(`${item} ${seg + 1}`);
    } else {
      parts.push(FIELD_LABELS[seg] || seg);
    }
  }
  return parts.join(' › ') || 'Scheda';
}

function valueAt(obj, p) {
  let v = obj;
  for (const k of p) { if (v == null) return undefined; v = v[k]; }
  return v;
}

const EXPECTED = {
  string: 'deve essere un testo', number: 'deve essere un numero', int: 'deve essere un numero intero (senza virgola)',
  array: 'deve essere un elenco', boolean: 'deve essere sì o no', object: 'contiene dati non validi', null: 'deve essere vuoto',
};

/** Problemi di zod → elenco [{ path:'steps.1.title', label:'Passo 2 › Titolo', message:'…' }] in italiano. */
export function zodIssuesItalian(issues, input) {
  return (issues || []).slice(0, 50).map((i) => {
    const p = (i.path || []).map((s) => (typeof s === 'symbol' ? String(s.description) : s));
    const got = valueAt(input, p);
    let message;
    if (i.code === 'invalid_type') {
      if (got === undefined) message = 'manca';
      else if (i.expected === 'int' && typeof got === 'number') message = EXPECTED.int;
      else message = EXPECTED[i.expected] || 'ha un formato non valido';
    } else if (i.code === 'invalid_value') {
      const vals = Array.isArray(i.values) ? i.values.map((v) => `«${v}»`).join(', ') : '';
      message = vals ? `valore non ammesso (valori possibili: ${vals})` : 'valore non ammesso';
    } else if (i.code === 'unrecognized_keys') {
      message = 'contiene campi sconosciuti';
    } else {
      message = 'valore non valido';
    }
    return { path: p.join('.'), label: pathLabel(p), message };
  });
}

/** Controlli di buon senso (avvisi, non errori). */
function manualWarnings(m, catalog) {
  const out = [];
  const ids = new Set((catalog || []).map((c) => c.id));
  const checkImg = (id, where) => { if (id && catalog && !ids.has(id)) out.push(`${where}: l’immagine ${id} non esiste nel documento.`); };
  checkImg(m.cover_image_id, 'Copertina');
  checkImg(m.brand_logo_image_id, 'Logo');
  const refs = new Set([...m.components.map((c) => c.code), ...m.hardware.map((h) => h.id)]);
  const seen = new Map();
  m.steps.forEach((s, i) => {
    const where = `Passo ${s.number}`;
    if (seen.has(s.number)) out.push(`Due passi hanno lo stesso numero (${s.number}).`);
    seen.set(s.number, i);
    if (!s.title.trim()) out.push(`${where}: manca il titolo.`);
    if (!s.paragraphs.some((p) => p.trim())) out.push(`${where}: manca il testo.`);
    for (const u of s.uses) if (u.ref && !refs.has(u.ref)) out.push(`${where}: «${u.ref}» non è né un componente né una ferramenta dell’elenco.`);
    s.image_ids.forEach((id) => checkImg(id, where));
  });
  m.hardware.forEach((h) => checkImg(h.image_id, `Ferramenta ${h.id || h.name}`));
  m.components.forEach((c) => checkImg(c.image_id, `Componente ${c.code || c.name}`));
  m.notes.forEach((n) => checkImg(n.image_id, `Nota «${n.title || n.label}»`));
  const nums = new Set(m.steps.map((s) => s.number));
  m.phases.forEach((ph) => {
    const missing = ph.step_numbers.filter((n) => !nums.has(n));
    if (missing.length) out.push(`Fase «${ph.title}»: i passi ${missing.join(', ')} non esistono.`);
  });
  if (!m.short_name.trim()) out.push('Manca il nome breve (serve per i nomi dei file).');
  return [...new Set(out)].slice(0, 40);
}

function pickThumb(m) {
  return m.cover_image_id || m.steps.find((s) => s.image_ids.length)?.image_ids[0] || m.components.find((c) => c.image_id)?.image_id || null;
}

async function readManual(dir) {
  const raw = await readJson(path.join(dir, 'manual.json'), null);
  if (!raw) throw new UserError('La scheda del manuale non c’è ancora: completa prima l’analisi.', 'manual_missing');
  const r = ManualData.safeParse(raw);
  if (!r.success) {
    const first = zodIssuesItalian(r.error.issues, raw)[0];
    throw new UserError(`La scheda del manuale non è valida (${first ? `${first.label}: ${first.message}` : 'formato errato'}): correggila nella revisione.`, 'manual_invalid');
  }
  return r.data;
}

/** Scheda + data dell'ultimo salvataggio, lette insieme (mai a metà di un salvataggio dalla revisione). */
function readManualSnapshot(jobId) {
  return withManualLock(jobId, async () => {
    const manual = await readManual(jobDir(jobId));
    const job = await getJob(jobId);
    return { manual, savedAt: job?.manual_saved_at || null };
  });
}

async function removeJobDir(id) {
  await fs.rm(jobDir(id), { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch((err) => {
    console.error(`[lavori] impossibile togliere la cartella di ${id}: ${err?.message || err}`);
  });
}

/**
 * Etichette delle viste delle parti con le sigle del manuale («F1 · Fianco ×2»), quando il piano dell'animazione
 * dice a quale componente o ferramenta corrisponde ogni parte del modello 3D. Senza piano restano i nomi del CAD.
 */
function labelViews(views, plan, manual) {
  const refOf = new Map((plan?.parts || []).filter((p) => p.role !== 'ignore' && p.ref).map((p) => [p.key, p.ref]));
  const nameOf = new Map([...manual.components.map((c) => [c.code, c.name]), ...manual.hardware.map((h) => [h.id, h.name])]);
  return (views || []).map((v) => {
    if (v.key === 'overview') return { ...v, ref_label: null };
    // lavori letti prima che si salvassero le chiavi: la vista porta il nome della prima parte del gruppo
    const keys = Array.isArray(v.keys) && v.keys.length ? v.keys : [v.key];
    const refs = [...new Set(keys.map((k) => refOf.get(k)).filter(Boolean))];
    if (!refs.length) return { ...v, ref_label: null };
    const count = keys.length > 1 ? keys.length : Number(/×\s*(\d+)/.exec(v.label || '')?.[1]) || 1;
    const n = count > 1 ? ` ×${count}` : '';
    const label = refs.length === 1
      ? `${refs[0]}${nameOf.get(refs[0]) ? ` · ${nameOf.get(refs[0])}` : ''}${n}`
      : `${refs.slice(0, 3).join(', ')}${refs.length > 3 ? '…' : ''}${n}`;
    return { ...v, ref_label: label };
  });
}

function planSignature(m, importedAt) {
  const data = {
    s: m.steps.map((s) => [s.number, s.title, s.uses]),
    c: m.components.map((c) => [c.code, c.name, c.qty]),
    h: m.hardware.map((h) => [h.id, h.name, h.qty]),
    t: m.short_name,
    i: importedAt || null,
  };
  return crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}

function modelReady(job, dir) {
  const m = job.model3d;
  return !!(job.model_file && m && m.status === 'pronto' && m.file === job.model_file &&
    existsSync(path.join(dir, 'model.glb')) && existsSync(path.join(dir, 'parts.json')));
}

/** Stato "a riposo" dopo un'operazione, in base a ciò che esiste. */
function restStatus(j, dir) {
  if (j.outputs?.video && existsSync(path.join(dir, 'out', 'video.mp4'))) return 'completato';
  if (j.outputs?.pdf && existsSync(path.join(dir, 'out', 'manuale.pdf'))) return 'pdf_pronto';
  if (existsSync(path.join(dir, 'manual.json'))) return 'revisione';
  return null;
}

/** Errori scritti da noi per l'utente (messaggio già in italiano e comprensibile). */
const USER_ERROR_NAMES = new Set(['UserError', 'IngestError', 'AiError', 'SettingsError', 'JobError', 'HttpError', 'CancelledError']);
const ITALIAN_HINT = /[àèéìòù’]|\b(?:il|lo|la|non|del|della|delle|dei|per|che|una?|nel|nella|alla|sul|questo|questa|prova|impossibile|errore|file\s+3d)\b/gi;

function looksItalian(msg) {
  return (String(msg).match(ITALIAN_HINT) || []).length >= 2;
}

/** Testo tecnico ripulito: senza "Error:", senza prefissi di Playwright, senza stack né "Call log". */
function cleanMessage(err) {
  let msg = String(err?.message || err || '').trim();
  msg = msg.replace(/^(?:Error|TypeError|RangeError):\s*/, '')
    .replace(/^(?:page|browser|browserType|locator|frame|context|elementHandle)\.\w+:\s*/i, '');
  msg = msg.split(/\n|\bCall log:/)[0].trim();
  return msg;
}

const GENERIC = {
  analisi: 'La lettura del documento si è fermata per un errore imprevisto. Premi «Riprova»; se si ripete, i dettagli tecnici sono nel registro del lavoro.',
  pdf: 'La creazione del PDF si è fermata per un errore imprevisto. Premi «Riprova»; se si ripete, i dettagli tecnici sono nel registro del lavoro.',
  video: 'La creazione del video si è fermata per un errore imprevisto. Premi «Riprova»; se si ripete, i dettagli tecnici sono nel registro del lavoro.',
  http: 'Errore interno del programma. Riprova; se si ripete, i dettagli tecnici sono nel registro (finestra nera del programma o registro del lavoro).',
};

/**
 * Messaggio per l'utente da un errore qualsiasi: i nostri messaggi passano così come sono; quelli delle librerie
 * (in inglese, tecnici, con percorsi) diventano una frase italiana. I dettagli restano solo nel registro.
 * @param {{ task?: string, modelName?: string }} [ctx]
 */
function friendlyError(err, { task = null, modelName = null } = {}) {
  const code = err?.code;
  if (code === 'ENOSPC') return 'Spazio su disco esaurito: libera un po’ di spazio e premi «Riprova».';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
    return 'Un file del lavoro è bloccato o non si può scrivere (forse è aperto in un altro programma): chiudilo e premi «Riprova».';
  }
  let msg = cleanMessage(err);
  const ours = USER_ERROR_NAMES.has(err?.name) || err instanceof UserError || err instanceof HttpError || err instanceof JobError;
  if (!ours && !looksItalian(msg)) {
    if (task === 'modello' || err?.stage === 'modello') {
      const ext = (/\.([a-z0-9]{1,5})$/i.exec(modelName || '')?.[1] || '').toUpperCase();
      return `Non riesco a leggere il file 3D${modelName ? ` «${modelName}»` : ''}: forse è danneggiato o non è davvero un file ${ext || '3D'}. ` +
        'Esportalo di nuovo (meglio in STEP, con le parti separate) e caricalo con «Carica un altro file».';
    }
    return GENERIC[task] || GENERIC.http;
  }
  if (!msg) msg = GENERIC[task] || 'Errore sconosciuto.';
  if (msg.length > 700) msg = msg.slice(0, 700) + '…';
  return msg;
}

// ============================================================================================ coda dei lavori

const MAIN_TASKS = new Set(['analisi', 'pdf', 'video']);
const TASK_LABEL = { analisi: 'analisi del documento', pdf: 'creazione del PDF', video: 'creazione del video', modello: 'lettura del modello 3D' };
const QUEUED_STATUS = { analisi: 'estrazione', pdf: 'pdf', video: 'video' };
const PRIORITY_USER = 10;
const PRIORITY_BACKGROUND = 1;

const queue = [];
let current = null;
let taskSeq = 0;

function taskKind(type) { return MAIN_TASKS.has(type) ? 'main' : type; }

function findTask(jobId, kind) {
  const match = (t) => t.jobId === jobId && taskKind(t.type) === kind;
  if (current && match(current)) return current;
  return queue.find(match) || null;
}

function queueState(jobId) {
  const st = (kind) => {
    const t = findTask(jobId, kind);
    if (!t) return null;
    return { type: t.type, state: t === current ? 'in_corso' : 'in_coda', cancelling: !!t.cancelled, position: t === current ? 0 : queue.indexOf(t) + 1 + (current ? 1 : 0) };
  };
  return { main: st('main'), model: st('modello') };
}

async function waitingMessage() {
  if (!current) return 'Avvio…';
  const j = await getJob(current.jobId).catch(() => null);
  return `In attesa: è in corso un’altra operazione (${TASK_LABEL[current.type]}${j ? ` di «${j.name}»` : ''}).`;
}

async function enqueue(jobId, type, params = {}, { priority = PRIORITY_USER } = {}) {
  const kind = taskKind(type);
  if (findTask(jobId, kind)) {
    throw new HttpError(409, kind === 'main'
      ? 'C’è già un’operazione in corso per questo lavoro: attendi che finisca oppure annullala.'
      : 'Il modello 3D è già in lettura: attendi che finisca.');
  }
  const task = { id: ++taskSeq, jobId, type, params: params || {}, priority, controller: new AbortController(), cancelled: false, enqueuedAt: Date.now() };
  queue.push(task);
  const message = await waitingMessage();
  if (kind === 'main') {
    await updateJob(jobId, (j) => {
      j.task = type;
      j.task_params = task.params;
      j.status = QUEUED_STATUS[type];
      j.error = null;
      j.progress = { stage: type === 'analisi' ? 'estrazione' : type, pct: 0, message, queued: true, started_at: null, eta_s: null };
    });
  } else {
    await updateJob(jobId, (j) => {
      j.model3d.status = 'in_coda';
      j.model3d.error = null;
      j.model3d.pct = 0;
      j.model3d.message = message;
    });
  }
  setImmediate(pump);
  return task;
}

function checkCancel(task) {
  if (task.cancelled || task.controller.signal.aborted) throw new CancelledError();
}

function isAbortError(err) {
  return err instanceof CancelledError || err?.name === 'AbortError' || err?.code === 'aborted' || err?.code === 'cancelled' ||
    /annullat/i.test(String(err?.message || ''));
}

async function pump() {
  if (current || !queue.length) return;
  let idx = 0;
  for (let i = 1; i < queue.length; i++) if (queue[i].priority > queue[idx].priority) idx = i;
  const task = queue.splice(idx, 1)[0];
  current = task;
  try {
    await runTask(task);
  } catch (err) {
    console.error('[coda] errore imprevisto:', err);
  } finally {
    current = null;
    // lavoro cancellato mentre l'operazione girava: si tolgono anche i file scritti dopo la cancellazione
    if (task.deleteAfter) await deleteJob(task.jobId).catch(() => removeJobDir(task.jobId));
    setImmediate(pump);
  }
}

async function runTask(task) {
  const { jobId, type } = task;
  if (!(await getJob(jobId))) return; // cancellato nel frattempo
  const t0 = Date.now();
  await appendLog(jobId, `inizio: ${TASK_LABEL[type]} ${JSON.stringify(task.params)}`);
  try {
    await TASKS[type](task);
    await appendLog(jobId, `fine: ${TASK_LABEL[type]} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } catch (err) {
    if (!(await getJob(jobId))) return;
    if (task.cancelled || isAbortError(err)) {
      await appendLog(jobId, `annullato: ${TASK_LABEL[type]}`);
      await onCancelled(task).catch(() => {});
      return;
    }
    const jobNow = await getJob(jobId).catch(() => null);
    const message = friendlyError(err, { task: type, modelName: jobNow?.model_name || null });
    await appendLog(jobId, `ERRORE (${TASK_LABEL[type]}): ${err?.stack || err}`);
    console.error(`[${jobId}] ${TASK_LABEL[type]} non riuscita: ${message}`);
    if (type === 'modello') {
      await updateJob(jobId, (j) => {
        j.model3d.status = 'errore';
        j.model3d.error = message;
        j.model3d.pct = 0;
        j.model3d.message = '';
      }).catch(() => {});
    } else {
      await updateJob(jobId, (j) => {
        j.status = 'errore';
        j.error = { task: type, message, code: err?.code && typeof err.code === 'string' ? err.code : null, params: task.params, at: nowIso() };
        j.progress = null;
        j.task = null;
        if (type === 'video' && task.params?.mode === '3d' && j.model3d.status === 'importazione') {
          j.model3d.status = 'errore';
          j.model3d.error = message;
        }
      }).catch(() => {});
    }
  }
}

async function onCancelled(task) {
  const dir = jobDir(task.jobId);
  if (task.type === 'modello') {
    await updateJob(task.jobId, (j) => {
      j.model3d.status = 'errore';
      j.model3d.error = 'Lettura del modello 3D annullata.';
      j.model3d.pct = 0;
      j.model3d.message = '';
    });
    return;
  }
  await updateJob(task.jobId, (j) => {
    const rest = restStatus(j, dir);
    j.progress = null;
    j.task = null;
    if (rest) {
      j.status = rest;
      j.error = null;
    } else {
      j.status = 'errore';
      j.error = { task: task.type, message: `${TASK_LABEL[task.type][0].toUpperCase()}${TASK_LABEL[task.type].slice(1)} annullata. Premi «Riprova» per ricominciare.`, code: 'cancelled', params: task.params, at: nowIso() };
    }
    if (j.model3d.status === 'importazione') { j.model3d.status = 'errore'; j.model3d.error = 'Lettura del modello 3D interrotta.'; }
  });
}

/**
 * Avanzamento di una fase dell'operazione principale: pct della fase (0-100) → pct complessivo [from, to].
 * Gli aggiornamenti vanno subito via SSE e su disco al massimo ogni mezzo secondo.
 */
function reporter(task, { from = 0, to = 100, stage, eta = false, alsoModel = false } = {}) {
  let maxPct = 0;
  let etaStart = null;
  let etaFrom = 0;
  return (pct, message) => {
    if (task.cancelled) return;
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const overall = Math.max(maxPct, Math.round(from + ((to - from) * p) / 100));
    maxPct = overall;
    let etaS = null;
    let msg = typeof message === 'string' && message ? message : null;
    if (eta) {
      // Rendering: i fotogrammi vanno dal 3 % al 95 % (src/video/render.js); stima del tempo rimanente.
      if (p >= 3 && etaStart === null) { etaStart = Date.now(); etaFrom = p; }
      if (etaStart !== null && p > etaFrom + 2 && p < 99) {
        const f = (p - etaFrom) / (95 - etaFrom);
        const el = (Date.now() - etaStart) / 1000;
        if (f > 0.03) etaS = Math.max(1, Math.round(el * (1 - Math.min(1, f)) / f + 4));
      }
      if (msg) msg = msg.replace(/\s*·\s*circa .*$/, '').replace(/^Fotogramma (\d+) \/ (\d+)$/, 'Fotogrammi disegnati: $1 di $2');
    }
    updateJob(task.jobId, (j) => {
      j.progress = { ...(j.progress || {}), stage, pct: overall, message: msg ?? j.progress?.message ?? '', queued: false, eta_s: eta ? etaS : null };
      if (alsoModel) { j.model3d.pct = Math.round(p); if (msg) j.model3d.message = msg; }
    }, { lazy: true }).catch(() => {});
  };
}

async function setStage(task, status, stage, pct, message) {
  await updateJob(task.jobId, (j) => {
    if (status) j.status = status;
    j.progress = { stage, pct, message, queued: false, started_at: j.progress?.started_at || nowIso(), eta_s: null };
  });
}

// ---------------------------------------------------------------------------------------- operazioni

/** Import del modello 3D + viste delle parti (usato dall'operazione 'modello' e dal video 3D). */
async function importModelStep(task, { main = false, from = 0, to = 100 } = {}) {
  const { jobId } = task;
  const dir = jobDir(jobId);
  const job = await getJob(jobId);
  if (!job.model_file) throw new UserError('Non è stato caricato nessun modello 3D.', 'no_model');
  const modelPath = path.join(dir, ...job.model_file.split('/'));
  if (!existsSync(modelPath)) throw new UserError('Il file del modello 3D non si trova più: caricalo di nuovo.', 'model_missing');
  const { importModel, renderPartViews } = await import('./src/video/index.js');
  const upAxis = ['y', 'z'].includes(job.model3d.up_axis_requested) ? job.model3d.up_axis_requested : 'auto';
  const settings = await getSettings();

  await updateJob(jobId, (j) => {
    j.model3d.status = 'importazione';
    j.model3d.error = null;
    j.model3d.pct = 0;
    j.model3d.message = 'Preparazione del lettore 3D…';
  });
  const mid = from + (to - from) * 0.75;
  const modelProgress = (a, b) => {
    const rep = main ? reporter(task, { from: a, to: b, stage: 'modello', alsoModel: false }) : null;
    let last = 0;
    return (pct, msg) => {
      const p = Math.max(0, Math.min(100, Number(pct) || 0));
      if (rep) rep(p, msg);
      const own = Math.round(((a - from) + (b - a) * p / 100) / Math.max(1, to - from) * 100);
      if (own < last) return;
      last = own;
      updateJob(jobId, (j) => { j.model3d.pct = own; if (msg) j.model3d.message = msg; }, { lazy: true }).catch(() => {});
    };
  };
  const log = (line) => { if (!/willReadFrequently|GLTFExporter|normalized normal/.test(line)) appendLog(jobId, `[3d] ${line}`); };
  const signal = task.controller.signal;
  let imp, views;
  try {
    imp = await importModel(dir, modelPath, modelProgress(from, mid), { upAxis, log, signal });
    checkCancel(task);
    views = await renderPartViews(dir, imp.parts, { max: 24, theme: settings.theme, onProgress: modelProgress(mid, to), log, signal });
    checkCancel(task);
  } catch (err) {
    if (err && typeof err === 'object' && !isAbortError(err)) err.stage = 'modello'; // messaggio «file 3D non leggibile»
    throw err;
  }
  const meta = imp.meta || {};
  await updateJob(jobId, (j) => {
    j.model3d = {
      ...emptyModel3d(),
      status: 'pronto',
      pct: 100,
      file: job.model_file,
      up_axis_requested: upAxis,
      up_axis: meta.up_axis_in_source || null,
      up_axis_reason: meta.up_axis_reason || null,
      part_count: meta.part_count ?? imp.parts.length,
      group_count: meta.group_count ?? null,
      size_text: meta.size_text || null,
      views: views.map((v) => ({ key: v.key, label: v.label, name: path.basename(String(v.file || v.path)), keys: Array.isArray(v.keys) ? v.keys.slice(0, 400) : [] })),
      imported_at: nowIso(),
      plan_sig: null,
    };
    j.warnings.model = meta.split ? [String(meta.split)] : [];
  });
}

const TASKS = {
  async analisi(task) {
    const { jobId } = task;
    const dir = jobDir(jobId);
    const job = await getJob(jobId);
    if (!job.input_file) throw new UserError('Manca il documento caricato: crea un nuovo lavoro.', 'no_input');
    const inputPath = path.join(dir, ...job.input_file.split('/'));
    if (!existsSync(inputPath)) throw new UserError('Il documento caricato non si trova più nella cartella del lavoro: crea un nuovo lavoro.', 'input_missing');

    await setStage(task, 'estrazione', 'estrazione', 0, 'Lettura del documento…');
    const { ingestDocument, prepareImages } = await import('./src/ingest/index.js');
    const signal = task.controller.signal;
    const ingest = await ingestDocument(dir, inputPath, reporter(task, { from: 0, to: 22, stage: 'estrazione' }), { signal });
    checkCancel(task);

    await setStage(task, null, 'immagini', 22, 'Preparazione delle immagini…');
    const prep = await prepareImages(dir, ingest.catalog, reporter(task, { from: 22, to: 32, stage: 'immagini' }), { signal });
    checkCancel(task);

    const testMode = isTestModeAi();
    await setStage(task, 'analisi', 'analisi', 32, testMode ? 'MODALITÀ TEST: nessuna chiamata a Claude…' : 'Invio del documento a Claude…');
    const { extractManual } = await import('./src/ai/extract.js');
    const manual = await extractManual(dir, ingest, reporter(task, { from: 32, to: 99, stage: 'analisi' }), { signal: task.controller.signal });
    checkCancel(task);

    const cost = await readCost(dir);
    const updated = await updateJob(jobId, (j) => {
      j.status = 'revisione';
      j.name = (manual.short_name || '').trim() || j.name;
      j.thumb = pickThumb(manual);
      j.input_kind = ingest.kind;
      j.scanned = !!ingest.scanned;
      j.warnings.ingest = Array.isArray(ingest.warnings) ? ingest.warnings.map(String) : [];
      j.warnings.images = Array.isArray(prep?.warnings) ? prep.warnings.map(String) : [];
      j.cost = cost;
      j.test_mode = testMode;
      j.analysed_at = nowIso();
      j.manual_saved_at = j.analysed_at;
      j.review = { verified: [] };
      j.progress = null;
      j.error = null;
      j.task = null;
    });
    // Modello 3D caricato insieme al documento: si legge in sottofondo mentre l'utente rivede la scheda.
    if (updated.model_file && !modelReady(updated, dir) && !findTask(jobId, 'modello') && updated.model3d.status !== 'errore') {
      await enqueue(jobId, 'modello', {}, { priority: PRIORITY_BACKGROUND }).catch(() => {});
    }
  },

  async pdf(task) {
    const { jobId } = task;
    const dir = jobDir(jobId);
    const { manual, savedAt } = await readManualSnapshot(jobId);
    const { theme } = await getSettings();
    await setStage(task, 'pdf', 'pdf', 1, 'Preparazione del PDF…');
    const { generatePdf } = await import('./src/pdf/generate.js');
    await generatePdf(dir, manual, {
      outPath: path.join(dir, 'out', 'manuale.pdf'), theme, onProgress: reporter(task, { from: 1, to: 99, stage: 'pdf' }), signal: task.controller.signal,
    });
    checkCancel(task);
    const layout = await readJson(path.join(dir, 'pdf-build', 'layout.json'), {});
    await updateJob(jobId, (j) => {
      j.outputs.pdf = 'out/manuale.pdf';
      j.outputs.pdf_at = nowIso();
      j.outputs.pdf_manual_at = savedAt; // versione della scheda usata (salvataggi fatti durante la creazione → PDF da rifare)
      j.outputs.pdf_pages = Array.isArray(layout?.pages) ? layout.pages.length : Number.isFinite(layout?.pages) ? layout.pages : null;
      j.warnings.pdf = Array.isArray(layout?.warnings) ? layout.warnings.map(String) : [];
      j.progress = null;
      j.error = null;
      j.task = null;
      j.status = restStatus(j, dir) || 'pdf_pronto';
    });
  },

  async video(task) {
    const { jobId } = task;
    const dir = jobDir(jobId);
    const mode = task.params.mode === '3d' ? '3d' : 'immagini';
    const quality = ['1080p', '720p', 'anteprima'].includes(task.params.quality) ? task.params.quality : '1080p';
    const { manual, savedAt } = await readManualSnapshot(jobId);
    const { theme } = await getSettings();
    await setStage(task, 'video', mode === '3d' ? 'modello' : 'render', 0, 'Preparazione del video…');
    const video = await import('./src/video/index.js');

    let plan = null;
    let glbPath = null;
    let renderFrom = 0;
    if (mode === '3d') {
      let job = await getJob(jobId);
      if (!job.model_file) throw new UserError('Per il video 3D serve il modello 3D: caricalo nella pagina del video (oppure scegli «Video con immagini»).', 'no_model');
      if (!modelReady(job, dir)) {
        await setStage(task, null, 'modello', 0, 'Lettura del modello 3D…');
        await importModelStep(task, { main: true, from: 0, to: 25 });
        checkCancel(task);
        job = await getJob(jobId);
      }
      const parts = await readJson(path.join(dir, 'parts.json'), null);
      if (!Array.isArray(parts) || !parts.length) throw new UserError('Le parti del modello 3D non sono disponibili: carica di nuovo il modello.', 'parts_missing');
      const sig = planSignature(manual, job.model3d.imported_at);
      const planFile = path.join(dir, 'plan.json');
      const oldPlan = await readJson(planFile, null);
      if (!task.params.replan && job.model3d.plan_sig === sig && oldPlan && AnimationPlan.safeParse(oldPlan).success) {
        plan = oldPlan;
        await appendLog(jobId, 'piano dell’animazione riutilizzato (scheda e modello invariati)');
        await updateJob(jobId, (j) => { j.model3d.views = labelViews(j.model3d.views, plan, manual); });
      } else {
        await setStage(task, null, 'piano', 25, isTestModePlan() ? 'MODALITÀ TEST: piano dell’animazione di prova…' : 'Claude prepara il piano dell’animazione…');
        const { planAnimation } = await import('./src/ai/animate.js');
        const views = (job.model3d.views || []).map((v) => ({ key: v.key, label: v.label, file: `viste_parti/${v.name}`, path: path.join(dir, 'viste_parti', v.name) }))
          .filter((v) => existsSync(v.path));
        plan = await planAnimation(dir, manual, parts, reporter(task, { from: 25, to: 38, stage: 'piano' }), { views, signal: task.controller.signal });
        checkCancel(task);
        const cost = await readCost(dir);
        await updateJob(jobId, (j) => { j.model3d.plan_sig = sig; j.cost = cost; j.model3d.views = labelViews(j.model3d.views, plan, manual); });
      }
      glbPath = path.join(dir, 'model.glb');
      renderFrom = 38;
    }
    checkCancel(task);
    await setStage(task, null, 'render', renderFrom, 'Avvio del motore di rendering…');
    const res = await video.renderVideo(dir, {
      mode, manual, plan, glbPath, quality, theme,
      onProgress: reporter(task, { from: renderFrom, to: 99, stage: 'render', eta: true }),
      signal: task.controller.signal,
      log: (line) => appendLog(jobId, `[video] ${line}`),
    });
    checkCancel(task);
    await updateJob(jobId, (j) => {
      j.outputs.video = 'out/video.mp4';
      j.outputs.poster = res.posterPath && existsSync(res.posterPath) ? 'out/poster.jpg' : null;
      j.outputs.video_at = nowIso();
      j.outputs.video_manual_at = savedAt;
      j.video_mode = mode;
      j.video_quality = quality;
      j.video_duration = Number.isFinite(res.duration) ? Math.round(res.duration * 10) / 10 : null;
      j.warnings.video = Array.isArray(res.warnings) ? res.warnings.map(String) : [];
      j.progress = null;
      j.error = null;
      j.task = null;
      j.status = 'completato';
    });
  },

  async modello(task) {
    const dir = jobDir(task.jobId);
    const job = await getJob(task.jobId);
    if (modelReady(job, dir)) return; // già letto (per esempio da un video 3D partito prima)
    await importModelStep(task, { main: false });
  },
};

// ============================================================================================ applicazione

function publicJob(j) {
  return { ...j, queue: queueState(j.id) };
}

function summary(j) {
  return {
    id: j.id, name: j.name, created_at: j.created_at, updated_at: j.updated_at, status: j.status,
    input_name: j.input_name, input_kind: j.input_kind, model_name: j.model_name, thumb: j.thumb,
    progress: j.progress, error: j.error ? { task: j.error.task, message: j.error.message } : null,
    outputs: j.outputs, test_mode: j.test_mode, cost: j.cost ? { text: j.cost.text } : null,
  };
}

async function requireJob(id) {
  if (!isValidJobId(id)) throw new HttpError(404, 'Lavoro non trovato.');
  const job = await getJob(id);
  if (!job) throw new HttpError(404, 'Lavoro non trovato: forse è stato cancellato.');
  return job;
}

function sendFileSafe(res, file, opts = {}) {
  return new Promise((resolve, reject) => {
    res.sendFile(file, { dotfiles: 'allow', ...opts }, (err) => {
      if (!err) return resolve();
      if (res.headersSent) return resolve();
      if (err.code === 'ENOENT' || err.status === 404) return reject(new HttpError(404, 'File non trovato.'));
      reject(err);
    });
  });
}

/**
 * Protezione dal "DNS rebinding": un sito esterno il cui nome punta improvvisamente a 127.0.0.1 arriverebbe qui
 * con il proprio nome nell'intestazione Host. Si accettano solo i nomi di questo computer (localhost, 127.0.0.1, [::1]),
 * HOST se è un nome preciso e quelli in MANUALI_ALLOWED_HOSTS (per Docker o per l'uso da altri computer della rete).
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
function allowedHostNames() {
  const set = new Set(LOOPBACK_HOSTS);
  const add = (h) => {
    const v = String(h || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (v && v !== '0.0.0.0' && v !== '::') set.add(v);
  };
  add(HOST);
  for (const h of String(process.env.MANUALI_ALLOWED_HOSTS || '').split(/[,;\s]+/)) add(h.replace(/:\d+$/, ''));
  return set;
}
const ALLOWED_HOSTS = allowedHostNames();

export function hostNameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined);
  return h.replace(/:\d*$/, '').replace(/\.$/, '');
}

function hostGuard(req, res, next) {
  const name = hostNameOf(req.headers.host);
  if (ALLOWED_HOSTS.has(name)) return next();
  res.status(421).type('text/plain; charset=utf-8').send(
    `Indirizzo non riconosciuto («${String(req.headers.host || '').slice(0, 80)}»). Apri lo strumento da http://localhost:${PORT}.` +
    ' Per usarlo da un altro computer della rete, avvialo con la variabile MANUALI_ALLOWED_HOSTS (vedi README).');
}

/** Le richieste che cambiano qualcosa devono arrivare dalla pagina dello strumento (non da altri siti). */
function originGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const site = req.get('sec-fetch-site');
  if (site && !['same-origin', 'none'].includes(site)) return next(new HttpError(403, 'Richiesta non consentita da un altro sito.'));
  const origin = req.get('origin');
  if (origin === 'null') return next(new HttpError(403, 'Richiesta non consentita da un altro sito.')); // iframe isolati, file locali…
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* origine non valida */ }
    if (host !== req.get('host')) return next(new HttpError(403, 'Richiesta non consentita da un altro sito.'));
  }
  next();
}

function makeUpload() {
  const tmpDir = path.join(jobsRoot(), '.caricamenti');
  const storage = multer.diskStorage({
    destination: (req, file, cb) => fs.mkdir(tmpDir, { recursive: true }).then(() => cb(null, tmpDir), cb),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.upload`),
  });
  return multer({
    storage,
    defParamCharset: 'utf8',
    limits: { fileSize: MODEL_MAX, files: 2, fields: 10, fieldSize: 1024 * 64 },
    fileFilter: (req, file, cb) => {
      const name = displayName(file.originalname);
      if (file.fieldname === 'documento') {
        if (!safeFileName(file.originalname, DOC_EXTS)) return cb(new HttpError(400, `«${name}» non è un formato supportato per il manuale: carica un PDF (.pdf) o un documento Word (.docx).`));
      } else if (file.fieldname === 'modello3d') {
        if (!safeFileName(file.originalname, MODEL_EXTS)) return cb(new HttpError(400, `«${name}» non è un formato 3D supportato. Formati ammessi: STEP (.step, .stp), IGES (.iges, .igs), GLB/GLTF, OBJ, STL.`));
      } else {
        return cb(new HttpError(400, `Campo file non previsto: ${file.fieldname}.`));
      }
      cb(null, true);
    },
  });
}

async function removeUploads(files) {
  for (const list of Object.values(files || {})) for (const f of list || []) await fs.rm(f.path, { force: true }).catch(() => {});
}

/** Controllo veloce del contenuto (prime righe del file) per rifiutare subito un file sbagliato. */
async function sniffDocument(file, ext) {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, 1024, 0);
    const head = buf.subarray(0, bytesRead);
    if (!bytesRead) return 'Il file caricato è vuoto.';
    if (ext === 'pdf' && !head.includes(Buffer.from('%PDF'))) {
      return 'Il file ha estensione .pdf ma non è un PDF valido (forse è danneggiato o scaricato in modo incompleto).';
    }
    if (ext === 'docx') {
      if (head[0] === 0xd0 && head[1] === 0xcf) return 'Questo file Word è nel vecchio formato (.doc) oppure è protetto da password: aprilo in Word e salvalo come .docx senza password, oppure esportalo in PDF.';
      if (!(head[0] === 0x50 && head[1] === 0x4b)) return 'Il file ha estensione .docx ma non è un documento Word valido.';
    }
    return null;
  } finally {
    await fh.close();
  }
}

/** Sposta il file caricato nella cartella del lavoro (rename; copia se su dischi diversi). */
async function moveInto(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err;
    await fs.copyFile(src, dest);
    await fs.rm(src, { force: true });
  }
}

async function storeModelFile(jobId, file, upAxis) {
  const name = displayName(file.originalname);
  const safe = safeFileName(file.originalname, MODEL_EXTS, 'modello');
  if (file.size > MODEL_MAX) throw new HttpError(413, 'Il modello 3D è troppo grande: il massimo è 300 MB.');
  if (!file.size) throw new HttpError(400, 'Il file del modello 3D è vuoto.');
  const dir = jobDir(jobId);
  const modelDir = path.join(dir, 'modello');
  await fs.rm(modelDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  await moveInto(file.path, path.join(modelDir, safe));
  for (const f of ['model.glb', 'parts.json', 'model.meta.json', 'plan.json', 'plan.ai.json']) await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
  await fs.rm(path.join(dir, 'viste_parti'), { recursive: true, force: true }).catch(() => {});
  await updateJob(jobId, (j) => {
    j.model_file = `modello/${safe}`;
    j.model_name = name;
    j.model3d = { ...emptyModel3d(), up_axis_requested: ['y', 'z'].includes(upAxis) ? upAxis : 'auto' };
    j.warnings.model = [];
  });
  await appendLog(jobId, `modello 3D caricato: ${name} (${(file.size / MB).toFixed(1)} MB)`);
}

/**
 * @param {{ ready?: Promise<void> }} [opts]  ready: le API (tranne /api/health) aspettano la fine della
 *   manutenzione all'avvio (lavori interrotti, file temporanei) prima di rispondere
 */
export function createApp({ ready = null } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', 'strong');
  const upload = makeUpload();

  app.use(hostGuard);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use('/api', originGuard);
  if (ready) app.use('/api', (req, res, next) => (req.path === '/health' ? next() : ready.then(() => next(), next)));
  app.use('/api', express.json({ limit: '8mb' }));

  // ------------------------------------------------------------------ informazioni e impostazioni
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, app: 'strumento-manuali', version: PKG.version, pid: process.pid, testMode: { ai: isTestModeAi(), plan: isTestModePlan() } });
  });

  app.get('/api/settings', async (req, res) => {
    const s = await getSettings();
    res.json({ ...s, defaultModel: DEFAULT_MODEL, defaultTheme: DEFAULT_THEME, testMode: { ai: isTestModeAi(), plan: isTestModePlan() } });
  });

  const saveSettingsRoute = async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const partial = {};
    for (const k of ['apiKey', 'model', 'theme']) if (k in body) partial[k] = body[k];
    try {
      const s = await saveSettings(partial);
      res.json({ ...s, defaultModel: DEFAULT_MODEL, defaultTheme: DEFAULT_THEME, testMode: { ai: isTestModeAi(), plan: isTestModePlan() } });
    } catch (err) {
      if (err instanceof SettingsError) throw new HttpError(400, err.message);
      throw err;
    }
  };
  app.post('/api/settings', saveSettingsRoute);
  app.put('/api/settings', saveSettingsRoute);

  // ------------------------------------------------------------------ lavori
  app.get('/api/jobs', async (req, res) => {
    res.json((await listJobs()).map(summary));
  });

  app.post('/api/jobs', (req, res, next) => {
    upload.fields([{ name: 'documento', maxCount: 1 }, { name: 'modello3d', maxCount: 1 }])(req, res, (err) => (err ? next(err) : next()));
  }, async (req, res) => {
    const files = req.files || {};
    const doc = files.documento?.[0];
    const model = files.modello3d?.[0];
    let created = null;
    try {
      if (!doc) throw new HttpError(400, 'Scegli il manuale da caricare (PDF o Word .docx).');
      if (doc.size > DOC_MAX) throw new HttpError(413, 'Il documento è troppo grande: il massimo è 100 MB. Prova a esportarlo di nuovo con immagini meno pesanti.');
      const docName = displayName(doc.originalname);
      const safeDoc = safeFileName(doc.originalname, DOC_EXTS, 'manuale');
      const ext = safeDoc.split('.').pop();
      const bad = await sniffDocument(doc.path, ext);
      if (bad) throw new HttpError(400, bad);
      if (model && !model.size) throw new HttpError(400, 'Il file del modello 3D è vuoto.');

      created = await createJob({ name: prettyName(docName), inputName: docName });
      const dir = jobDir(created.id);
      await moveInto(doc.path, path.join(dir, 'input', safeDoc));
      await updateJob(created.id, { input_file: `input/${safeDoc}`, input_name: docName, input_kind: ext });
      await appendLog(created.id, `lavoro creato: ${docName} (${(doc.size / MB).toFixed(1)} MB)`);
      if (model) await storeModelFile(created.id, model, String(req.body?.upAxis || 'auto'));
      await enqueue(created.id, 'analisi', {});
      if (model) await enqueue(created.id, 'modello', {}, { priority: PRIORITY_BACKGROUND });
      const job = await getJob(created.id);
      res.status(201).json({ id: created.id, job: publicJob(job) });
    } catch (err) {
      await removeUploads(files);
      if (created) await deleteJob(created.id).catch(() => {});
      throw err;
    }
  });

  app.get('/api/jobs/:id', async (req, res) => {
    res.json(publicJob(await requireJob(req.params.id)));
  });

  app.patch('/api/jobs/:id', async (req, res) => {
    await requireJob(req.params.id);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const job = await updateJob(req.params.id, (j) => {
      if (body.review && Array.isArray(body.review.verified)) {
        j.review = { ...j.review, verified: [...new Set(body.review.verified.filter((n) => Number.isInteger(n) && n >= 0 && n < 1000))].sort((a, b) => a - b) };
      }
      if (typeof body.name === 'string' && body.name.trim()) j.name = body.name.trim().slice(0, 120);
    });
    res.json(publicJob(job));
  });

  app.delete('/api/jobs/:id', async (req, res) => {
    const id = req.params.id;
    await requireJob(id);
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].jobId === id) queue.splice(i, 1);
    let running = null;
    if (current && current.jobId === id) {
      running = current;
      running.cancelled = true;
      running.deleteAfter = true; // a operazione finita si toglie anche quello che avesse scritto nel frattempo
      running.controller.abort();
      const until = Date.now() + 20000;
      while (current === running && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    }
    try {
      await deleteJob(id);
    } catch (err) {
      if (running && current === running) {
        // l'operazione tiene ancora aperto qualche file (Windows): la cartella si toglie quando finisce
        await fs.rm(jobPath(id, 'job.json'), { force: true }).catch(() => {});
        return res.json({ ok: true, pending: true });
      }
      throw new HttpError(500, `Impossibile cancellare il lavoro (${err?.code || 'file bloccato'}): forse un suo file è aperto in un altro programma. Chiudilo e riprova.`);
    }
    res.json({ ok: true });
  });

  // Avanzamento in tempo reale (Server-Sent Events): job.json a ogni aggiornamento.
  app.get('/api/jobs/:id/events', async (req, res) => {
    const id = req.params.id;
    const job = await requireJob(id);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const send = (j) => res.write(`data: ${JSON.stringify(publicJob(j))}\n\n`);
    send(job);
    const onUpdate = (j) => { if (j.id === id) send(j); };
    const onDeleted = (did) => { if (did === id) res.write('event: deleted\ndata: {}\n\n'); };
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    events.on('update', onUpdate);
    events.on('deleted', onDeleted);
    req.on('close', () => {
      clearInterval(ping);
      events.off('update', onUpdate);
      events.off('deleted', onDeleted);
    });
  });

  // Aggiornamenti di tutti i lavori (pagina iniziale).
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const onUpdate = (j) => res.write(`data: ${JSON.stringify(summary(j))}\n\n`);
    const onDeleted = (id) => res.write(`event: deleted\ndata: ${JSON.stringify({ id })}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    events.on('update', onUpdate);
    events.on('deleted', onDeleted);
    req.on('close', () => {
      clearInterval(ping);
      events.off('update', onUpdate);
      events.off('deleted', onDeleted);
    });
  });

  app.get('/api/jobs/:id/catalog', async (req, res) => {
    await requireJob(req.params.id);
    const catalog = await readJson(jobPath(req.params.id, 'estratte', 'catalog.json'), []);
    res.set('Cache-Control', 'no-cache').json(Array.isArray(catalog) ? catalog : []);
  });

  app.get('/api/jobs/:id/image/:imgId', async (req, res) => {
    const { id, imgId } = req.params;
    await requireJob(id);
    if (!IMG_ID_RE.test(imgId)) throw new HttpError(404, 'Immagine non trovata.');
    const candidates = req.query.thumb
      ? [['immagini', 'thumb', `${imgId}.jpg`], ['immagini', 'final', `${imgId}.png`], ['estratte', `${imgId}.png`]]
      : [['immagini', 'final', `${imgId}.png`], ['estratte', `${imgId}.png`]];
    for (const segs of candidates) {
      const f = jobPath(id, ...segs);
      if (await exists(f)) {
        res.set('Cache-Control', 'no-cache');
        return sendFileSafe(res, f);
      }
    }
    throw new HttpError(404, 'Immagine non trovata.');
  });

  app.get('/api/jobs/:id/views/:name', async (req, res) => {
    const { id, name } = req.params;
    await requireJob(id);
    if (!VIEW_RE.test(name)) throw new HttpError(404, 'Vista non trovata.');
    res.set('Cache-Control', 'no-cache');
    return sendFileSafe(res, jobPath(id, 'viste_parti', name));
  });

  // Documento originale: PDF per l'anteprima nel browser (inline); Word come download.
  app.get('/api/jobs/:id/document', async (req, res) => {
    const job = await requireJob(req.params.id);
    if (!job.input_file) throw new HttpError(404, 'Documento non trovato.');
    const file = jobPath(req.params.id, ...job.input_file.split('/'));
    const isPdf = /\.pdf$/i.test(file);
    const name = job.input_name || path.basename(file);
    res.set('Content-Type', isPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.attachment(name);
    if (isPdf && !req.query.download) res.set('Content-Disposition', res.get('Content-Disposition').replace(/^attachment/, 'inline'));
    res.set('Cache-Control', 'no-cache');
    return sendFileSafe(res, file);
  });

  // Testo estratto da un documento Word, con le immagini al loro posto (anteprima nella revisione).
  app.get('/api/jobs/:id/document/preview', async (req, res) => {
    const id = req.params.id;
    const job = await requireJob(id);
    const text = await readJson(jobPath(id, 'estratte', 'text.json'), null);
    let body;
    if (text && typeof text.html === 'string') {
      body = text.html.replace(/\[\[(img_\d{1,4})\]\]/g, (m, imgId) => `<figure><img src="/api/jobs/${id}/image/${imgId}" alt="${imgId}"><figcaption>${imgId}</figcaption></figure>`);
    } else if (text && Array.isArray(text.pages)) {
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      body = text.pages.map((p) => `<h2>Pagina ${Number(p.page) || ''}</h2><p>${esc(p.text || '').replace(/\n/g, '<br>')}</p>`).join('\n');
    } else {
      body = '<p>Il testo del documento non è ancora disponibile.</p>';
    }
    const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${job.input_name ? 'Documento' : 'Anteprima'}</title>
<style>
@font-face{font-family:Barlow;src:url(/fonts/barlow-latin-400-normal.woff2) format("woff2");font-weight:400}
@font-face{font-family:Barlow;src:url(/fonts/barlow-latin-600-normal.woff2) format("woff2");font-weight:600}
body{font-family:Barlow,system-ui,sans-serif;color:#1F1C1A;background:#fff;margin:0;padding:22px 26px;line-height:1.5;font-size:15px}
h1,h2,h3{font-weight:600;line-height:1.2;margin:1.2em 0 .4em}h1{font-size:22px}h2{font-size:18px}h3{font-size:16px}
figure{margin:12px 0;padding:8px;border:1px solid #E4DED7;border-radius:8px;display:inline-block;max-width:100%}
img{max-width:100%;max-height:300px;height:auto;display:block}figcaption{font-size:12px;color:#766D66;margin-top:4px}
table{border-collapse:collapse;margin:10px 0}td,th{border:1px solid #E4DED7;padding:4px 8px;vertical-align:top}
</style></head><body>${body}</body></html>`;
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; font-src 'self'");
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(html);
  });

  app.get('/api/jobs/:id/manual', async (req, res) => {
    await requireJob(req.params.id);
    const m = await readJson(jobPath(req.params.id, 'manual.json'), null);
    if (!m) throw new HttpError(404, 'La scheda del manuale non c’è ancora: attendi la fine dell’analisi.');
    res.set('Cache-Control', 'no-cache').json(m);
  });

  app.put('/api/jobs/:id/manual', async (req, res) => {
    const id = req.params.id;
    const job = await requireJob(id);
    const t = findTask(id, 'main');
    if (t && t.type === 'analisi') throw new HttpError(409, 'L’analisi è in corso: attendi che finisca prima di salvare.');
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'La scheda inviata non è valida.', { issues: [] });
    const r = ManualData.safeParse(body);
    if (!r.success) {
      const issues = zodIssuesItalian(r.error.issues, body);
      throw new HttpError(400, `La scheda contiene ${issues.length === 1 ? 'un errore' : `${issues.length} errori`}: ${issues.slice(0, 3).map((i) => `${i.label}: ${i.message}`).join('; ')}${issues.length > 3 ? '…' : ''}`, { issues });
    }
    const manual = r.data;
    const catalog = await readJson(jobPath(id, 'estratte', 'catalog.json'), null);
    // in fila con gli altri salvataggi (due schede aperte) e con la lettura della scheda da parte di PDF e video
    const updated = await withManualLock(id, async () => {
      const t2 = findTask(id, 'main');
      if (t2 && t2.type === 'analisi' && t2 === current) throw new HttpError(409, 'L’analisi è in corso: attendi che finisca prima di salvare.');
      await writeJsonAtomic(jobPath(id, 'manual.json'), manual);
      return updateJob(id, (j) => {
        // sempre crescente, anche con due salvataggi nello stesso millisecondo
        const now = nowIso();
        j.manual_saved_at = j.manual_saved_at && j.manual_saved_at >= now ? new Date(Date.parse(j.manual_saved_at) + 1).toISOString() : now;
        if (manual.short_name.trim()) j.name = manual.short_name.trim();
        j.thumb = pickThumb(manual);
      });
    });
    await appendLog(id, 'scheda salvata dalla revisione');
    res.json({ ok: true, manual, warnings: manualWarnings(manual, Array.isArray(catalog) ? catalog : null), job: publicJob(updated), previous: job.manual_saved_at });
  });

  app.post('/api/jobs/:id/reanalyze', async (req, res) => {
    await requireJob(req.params.id);
    await enqueue(req.params.id, 'analisi', {});
    res.status(202).json(publicJob(await getJob(req.params.id)));
  });

  app.post('/api/jobs/:id/pdf', async (req, res) => {
    const id = req.params.id;
    await requireJob(id);
    if (!(await exists(jobPath(id, 'manual.json')))) throw new HttpError(409, 'La scheda del manuale non c’è ancora: attendi la fine dell’analisi.');
    await enqueue(id, 'pdf', {});
    res.status(202).json(publicJob(await getJob(id)));
  });

  app.post('/api/jobs/:id/video', async (req, res) => {
    const id = req.params.id;
    const job = await requireJob(id);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const mode = body.mode === '3d' ? '3d' : body.mode === 'immagini' || body.mode === undefined ? 'immagini' : null;
    if (!mode) throw new HttpError(400, 'Tipo di video non valido: scegli «Video 3D» o «Video con immagini».');
    const quality = body.quality ?? '1080p';
    if (!['1080p', '720p', 'anteprima'].includes(quality)) throw new HttpError(400, 'Qualità non valida: scegli 1080p, 720p o anteprima.');
    if (!(await exists(jobPath(id, 'manual.json')))) throw new HttpError(409, 'La scheda del manuale non c’è ancora: attendi la fine dell’analisi.');
    if (mode === '3d' && !job.model_file) throw new HttpError(409, 'Per il video 3D serve il modello 3D: caricalo prima (oppure scegli «Video con immagini»).');
    await enqueue(id, 'video', { mode, quality, replan: !!body.replan });
    res.status(202).json(publicJob(await getJob(id)));
  });

  app.post('/api/jobs/:id/model', (req, res, next) => {
    upload.fields([{ name: 'modello3d', maxCount: 1 }])(req, res, (err) => (err ? next(err) : next()));
  }, async (req, res) => {
    const id = req.params.id;
    const files = req.files || {};
    try {
      await requireJob(id);
      const model = files.modello3d?.[0];
      if (!model) throw new HttpError(400, 'Scegli il file del modello 3D (STEP, IGES, GLB, OBJ o STL).');
      const main = findTask(id, 'main');
      if (main && main.type === 'video') throw new HttpError(409, 'È in corso la creazione del video: attendi che finisca (o annullala) prima di cambiare il modello 3D.');
      const mt = findTask(id, 'modello');
      if (mt && mt === current) throw new HttpError(409, 'Il modello 3D è in lettura: attendi che finisca prima di caricarne un altro.');
      if (mt) queue.splice(queue.indexOf(mt), 1);
      await storeModelFile(id, model, String(req.body?.upAxis || 'auto'));
      await enqueue(id, 'modello', {}, { priority: PRIORITY_USER });
      res.status(202).json(publicJob(await getJob(id)));
    } catch (err) {
      await removeUploads(files);
      throw err;
    }
  });

  // Rilegge il modello già caricato, per esempio con l'altro asse verticale ("il modello è capovolto?").
  app.post('/api/jobs/:id/model/reimport', async (req, res) => {
    const id = req.params.id;
    const job = await requireJob(id);
    if (!job.model_file) throw new HttpError(409, 'Non è stato caricato nessun modello 3D.');
    const upAxis = req.body?.upAxis ?? 'auto';
    if (!['auto', 'y', 'z'].includes(upAxis)) throw new HttpError(400, 'Asse verticale non valido: usa «auto», «y» o «z».');
    const main = findTask(id, 'main');
    if (main && main.type === 'video') throw new HttpError(409, 'È in corso la creazione del video: attendi che finisca prima di rileggere il modello.');
    if (findTask(id, 'modello')) throw new HttpError(409, 'Il modello 3D è già in lettura: attendi che finisca.');
    const dir = jobDir(id);
    for (const f of ['model.glb', 'parts.json', 'model.meta.json']) await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
    await updateJob(id, (j) => { j.model3d = { ...emptyModel3d(), up_axis_requested: upAxis }; });
    await appendLog(id, `rilettura del modello 3D richiesta (asse verticale: ${upAxis})`);
    await enqueue(id, 'modello', {}, { priority: PRIORITY_USER });
    res.status(202).json(publicJob(await getJob(id)));
  });

  app.delete('/api/jobs/:id/model', async (req, res) => {
    const id = req.params.id;
    const job = await requireJob(id);
    if (!job.model_file) return res.json(publicJob(job));
    const main = findTask(id, 'main');
    if (main && main.type === 'video') throw new HttpError(409, 'È in corso la creazione del video: attendi che finisca.');
    const mt = findTask(id, 'modello');
    if (mt && mt === current) throw new HttpError(409, 'Il modello 3D è in lettura: attendi che finisca.');
    if (mt) queue.splice(queue.indexOf(mt), 1);
    const dir = jobDir(id);
    await fs.rm(path.join(dir, 'modello'), { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
    for (const f of ['model.glb', 'parts.json', 'model.meta.json', 'plan.json', 'plan.ai.json']) await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
    await fs.rm(path.join(dir, 'viste_parti'), { recursive: true, force: true }).catch(() => {});
    const updated = await updateJob(id, (j) => { j.model_file = null; j.model_name = null; j.model3d = emptyModel3d(); j.warnings.model = []; });
    res.json(publicJob(updated));
  });

  app.post('/api/jobs/:id/retry', async (req, res) => {
    const id = req.params.id;
    const job = await requireJob(id);
    if (req.body?.what === 'modello') {
      if (!job.model_file) throw new HttpError(409, 'Non è stato caricato nessun modello 3D.');
      await enqueue(id, 'modello', {}, { priority: PRIORITY_USER });
    } else {
      const task = job.error?.task;
      if (!task || !MAIN_TASKS.has(task)) throw new HttpError(409, 'Non c’è nessuna operazione da riprovare.');
      await enqueue(id, task, job.error.params || {});
    }
    res.status(202).json(publicJob(await getJob(id)));
  });

  app.post('/api/jobs/:id/cancel', async (req, res) => {
    const id = req.params.id;
    await requireJob(id);
    const kind = req.body?.what === 'modello' ? 'modello' : 'main';
    const t = findTask(id, kind);
    if (!t) throw new HttpError(409, 'Non c’è nessuna operazione in corso da annullare.');
    if (t !== current) {
      queue.splice(queue.indexOf(t), 1);
      await appendLog(id, `tolto dalla coda: ${TASK_LABEL[t.type]}`);
      await onCancelled(t);
    } else {
      t.cancelled = true;
      t.controller.abort();
      await updateJob(id, (j) => {
        if (kind === 'main' && j.progress) j.progress = { ...j.progress, message: 'Annullamento in corso…', cancelling: true };
        if (kind === 'modello') j.model3d.message = 'Annullamento in corso…';
      });
    }
    res.status(202).json(publicJob(await getJob(id)));
  });

  // File prodotti: anteprima (inline) o download (?download=1) con un nome comprensibile.
  app.get('/api/jobs/:id/files/:name', async (req, res) => {
    const { id, name } = req.params;
    const job = await requireJob(id);
    const spec = OUT_FILES[name];
    if (!spec) throw new HttpError(404, 'File non trovato.');
    const file = jobPath(id, ...spec.rel);
    if (!(await exists(file))) throw new HttpError(404, 'Il file non è ancora stato generato.');
    let short = job.name;
    const m = await readJson(jobPath(id, 'manual.json'), null);
    if (m && typeof m.short_name === 'string' && m.short_name.trim()) short = m.short_name;
    res.attachment(spec.name(fileSafeName(short)));
    if (!req.query.download) res.set('Content-Disposition', res.get('Content-Disposition').replace(/^attachment/, 'inline'));
    res.set('Content-Type', spec.type);
    res.set('Cache-Control', 'no-cache');
    return sendFileSafe(res, file, { acceptRanges: true });
  });

  app.get('/api/jobs/:id/log', async (req, res) => {
    const id = req.params.id;
    await requireJob(id);
    const file = jobPath(id, 'log.txt');
    if (!(await exists(file))) return res.type('text/plain; charset=utf-8').send('');
    if (req.query.download) res.attachment(`registro_${id}.txt`);
    res.set('Cache-Control', 'no-cache');
    // sendFile gestisce gli errori di lettura (file tolto nel frattempo, file bloccato su Windows) senza far cadere il server
    return sendFileSafe(res, file, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Indirizzo non trovato.' });
  });

  // ------------------------------------------------------------------ interfaccia
  app.use('/fonts', express.static(FONTS_DIR, { maxAge: '7d', fallthrough: false }));
  app.use(express.static(PUBLIC_DIR, {
    index: 'index.html',
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  // ------------------------------------------------------------------ errori
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err?.status || err?.statusCode || 500;
    let message = err?.message || 'Errore interno.';
    const extra = {};
    if (err instanceof multer.MulterError) {
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      message = {
        LIMIT_FILE_SIZE: 'Il file è troppo grande: il massimo è 100 MB per il documento e 300 MB per il modello 3D.',
        LIMIT_FILE_COUNT: 'Troppi file: carica un documento e, se vuoi, un modello 3D.',
        LIMIT_UNEXPECTED_FILE: 'Campo file non previsto.',
        LIMIT_PART_COUNT: 'Richiesta non valida (troppe parti).',
        LIMIT_FIELD_COUNT: 'Richiesta non valida (troppi campi).',
      }[err.code] || `Caricamento non riuscito (${err.code}).`;
    } else if (err?.type === 'entity.parse.failed') {
      status = 400; message = 'Dati non validi: il contenuto inviato non è un JSON corretto.';
    } else if (err?.type === 'entity.too.large') {
      status = 413; message = 'Dati troppo grandi.';
    } else if (err instanceof JobError) {
      status = err.status;
    } else if (err instanceof UserError) {
      status = 400;
    } else if (status >= 500) {
      // dettagli tecnici (con i percorsi) solo nei registri; all'utente una frase comprensibile
      console.error(`[server] ${req.method} ${req.originalUrl}:`, err);
      const jid = /^\/api\/jobs\/([^/]+)/.exec(req.path)?.[1];
      if (jid && isValidJobId(jid)) appendLog(jid, `ERRORE (${req.method} ${req.path}): ${err?.stack || err}`).catch(() => {});
      message = friendlyError(err, { task: 'http' });
    }
    if (Array.isArray(err?.issues)) extra.issues = err.issues;
    if (res.headersSent) return res.end();
    if (req.path.startsWith('/api/') || req.path === '/api') res.status(status).json({ error: message, ...extra });
    else res.status(status).type('text/plain; charset=utf-8').send(message);
  });

  return app;
}

// ============================================================================================ avvio

function openBrowser(url) {
  try {
    let child;
    if (process.platform === 'win32') {
      child = spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    child.on('error', () => console.log(`Apri il browser all’indirizzo ${url}`));
    child.unref();
  } catch {
    console.log(`Apri il browser all’indirizzo ${url}`);
  }
}

/** Un'altra copia dello strumento risponde su questa porta? → { pid } oppure null */
async function alreadyRunning(port) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    return j?.app === 'strumento-manuali' ? { pid: j.pid ?? null } : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Lucchetto lavori/.server.lock: la copia dello strumento che sta usando questa cartella dei lavori (pid e porta).
 * Copre anche il caso di due copie avviate su porte diverse con la stessa cartella.
 * @returns {Promise<{ port:number }|null>}  l'altra copia ancora attiva, oppure null
 */
async function otherInstanceFromLock() {
  const lock = await readJson(LOCK_FILE(), null);
  if (!lock || lock.pid === process.pid || !pidAlive(lock.pid) || !Number.isInteger(lock.port)) return null;
  const other = await alreadyRunning(lock.port);
  return other && (other.pid === null || other.pid === lock.pid) ? { port: lock.port } : null;
}

async function cleanUploadTmp() {
  const dir = path.join(jobsRoot(), '.caricamenti');
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function exitAlreadyOpen(port) {
  const url = `http://localhost:${port}`;
  console.log(`Strumento manuali è già aperto: ${url}`);
  console.log('Questa finestra si può chiudere: lo strumento continua nella finestra già aperta.');
  if (!NO_BROWSER) openBrowser(url);
  process.exit(0);
}

async function start() {
  // Stesso requisito di package.json (engines) e degli script avvia-*: pdfjs-dist richiede Node 22.13 o successivo.
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) {
    console.error(`Questa versione di Node.js (${process.version}) è troppo vecchia: serve la 22.13 o successiva. ` +
      'Installa la versione «LTS» da https://nodejs.org/ e riavvia lo strumento.');
    process.exit(1);
  }
  // Prima di toccare il disco: se lo strumento è già aperto (doppio clic in più sullo script) si apre quello.
  // Pulire la cartella dei caricamenti o segnare come interrotti i lavori di un'altra copia ancora attiva
  // rovinerebbe i suoi caricamenti e le sue operazioni in corso.
  if (await alreadyRunning(PORT)) exitAlreadyOpen(PORT);
  await fs.mkdir(jobsRoot(), { recursive: true });
  const other = await otherInstanceFromLock();
  if (other) exitAlreadyOpen(other.port);

  let markReady;
  const ready = new Promise((r) => { markReady = r; });
  const app = createApp({ ready });
  const server = http.createServer(app);
  server.requestTimeout = 0;      // caricamenti grandi su connessioni lente
  server.keepAliveTimeout = 65000;

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, HOST, () => { server.off('error', reject); resolve(); });
    });
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      if (await alreadyRunning(PORT)) exitAlreadyOpen(PORT);
      console.error(`La porta ${PORT} è occupata da un altro programma. Chiudilo, oppure avvia lo strumento su un’altra porta (variabile PORT, per esempio PORT=3211).`);
      process.exit(1);
    }
    if (err?.code === 'EACCES') {
      console.error(`Non è permesso usare la porta ${PORT}: scegline un’altra con la variabile PORT (per esempio PORT=3211).`);
      process.exit(1);
    }
    throw err;
  }
  server.on('error', (err) => console.error('Errore del server:', err?.message || err));

  // Solo ora (porta ottenuta: nessun'altra copia attiva) si sistema la cartella dei lavori.
  const port = server.address().port;
  await writeJsonFile(LOCK_FILE(), { pid: process.pid, port, started_at: nowIso() }).catch(() => {});
  await cleanUploadTmp();
  const interrupted = await markInterrupted().catch((err) => { console.error(err); return 0; });
  const orphans = await sweepOrphans().catch(() => 0);
  markReady();

  const url = `http://localhost:${port}`;
  console.log(`Strumento manuali pronto: ${url}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') console.log(`(in ascolto su ${HOST}:${port})`);
  if (isTestModeAi()) console.log('MODALITÀ TEST: l’analisi usa la scheda di prova (MANUALI_AI_FIXTURE), nessuna chiamata a Claude.');
  if (isTestModePlan()) console.log('MODALITÀ TEST: il video 3D usa il piano di prova (MANUALI_PLAN_FIXTURE), nessuna chiamata a Claude.');
  if (interrupted) console.log(`${interrupted} ${interrupted === 1 ? 'lavoro era rimasto' : 'lavori erano rimasti'} a metà: si possono riprendere con «Riprova».`);
  if (orphans) console.log(`Tolte ${orphans} ${orphans === 1 ? 'cartella rimasta' : 'cartelle rimaste'} da lavori cancellati.`);
  console.log('Per chiudere lo strumento chiudi questa finestra (oppure premi Ctrl+C).');
  if (!NO_BROWSER) openBrowser(url);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\nChiusura dello strumento…');
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    await flushAll().catch(() => {});
    const lock = await readJson(LOCK_FILE(), null);
    if (lock?.pid === process.pid) await fs.rm(LOCK_FILE(), { force: true }).catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  process.on('SIGBREAK', shutdown); // Windows: Ctrl+Break / chiusura della finestra

  // Ultima difesa: un errore imprevisto (per esempio la lettura di un file che sparisce) non deve chiudere lo
  // strumento e con lui tutte le operazioni in corso. Si scrive nel registro e si continua.
  let strays = 0;
  const onStray = (kind) => (err) => {
    strays++;
    console.error(`[server] errore imprevisto (${kind}), lo strumento continua a funzionare:`, err?.stack || err);
    if (strays > 50) {
      console.error('Troppi errori imprevisti: chiudo lo strumento. Riaprilo con lo script avvia-*.');
      flushAll().catch(() => {}).finally(() => process.exit(1));
    }
  };
  process.on('uncaughtException', onStray('uncaughtException'));
  process.on('unhandledRejection', onStray('unhandledRejection'));
}

start().catch((err) => {
  console.error('Impossibile avviare lo strumento:', err?.message || err);
  process.exit(1);
});
