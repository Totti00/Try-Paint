// Archivio dei lavori su disco: lavori/<id>/job.json, registro log.txt ed eventi di avanzamento.
//
//   jobsRoot()                     cartella dei lavori (MANUALI_JOBS_DIR oppure <progetto>/lavori)
//   isValidJobId(id)               id = "AAAAMMGG-hhmmss-slug" (solo minuscole, cifre e trattini)
//   jobDir(id)                     cartella del lavoro (lancia JobError 404 se l'id non è valido)
//   jobPath(id, ...segmenti)       percorso dentro la cartella del lavoro (mai fuori: niente path traversal)
//   createJob({ name, inputName }) → job (cartella creata, job.json scritto)
//   listJobs()                     → [job] dal più recente
//   getJob(id)                     → job | null   (copia: modificarla non cambia l'archivio)
//   updateJob(id, patch|fn, { lazy }) → job aggiornato; emette events 'update' (job)
//                                  patch: oggetto unito in superficie; fn(job) modifica la copia di lavoro.
//                                  lazy:true = scrittura su disco raggruppata (per gli aggiornamenti di avanzamento)
//   deleteJob(id)                  cancella la cartella; emette events 'deleted' (id)
//   appendLog(id, message)         riga con data/ora in log.txt
//   markInterrupted()              all'avvio: i lavori rimasti "in corso" (programma chiuso) passano a 'errore'
//   sweepOrphans()                 all'avvio: toglie le cartelle di lavori senza job.json (resti di cancellazioni)
//   flushAll()                     scrive subito su disco gli aggiornamenti in attesa
//   slugify, prettyName, safeFileName   utilità per nomi di file sicuri (anche su Windows)
//
// job.json: vedi ARCHITETTURA.md (campi aggiuntivi: input_name, input_kind, task, warnings, cost, test_mode,
// review, model3d, outputs.pdf_at/video_at/pdf_manual_at/video_manual_at, manual_saved_at, thumb).

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './fsutil.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const JOB_ID_RE = /^\d{8}-\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const JOB_ID_MAX = 80;

/** Stati in cui un'operazione è in corso (all'avvio del programma non possono esserlo davvero). */
export const BUSY_STATUSES = new Set(['nuovo', 'estrazione', 'analisi', 'pdf', 'video']);

export class JobError extends Error {
  constructor(message, { status = 400, code = 'job' } = {}) {
    super(message);
    this.name = 'JobError';
    this.status = status;
    this.code = code;
  }
}

export const events = new EventEmitter();
events.setMaxListeners(0);

export function jobsRoot() {
  return path.resolve(process.env.MANUALI_JOBS_DIR || path.join(ROOT, 'lavori'));
}

export function isValidJobId(id) {
  return typeof id === 'string' && id.length <= JOB_ID_MAX && JOB_ID_RE.test(id);
}

export function jobDir(id) {
  if (!isValidJobId(id)) throw new JobError('Lavoro non trovato.', { status: 404, code: 'job_not_found' });
  return path.join(jobsRoot(), id);
}

/** Percorso dentro la cartella del lavoro; rifiuta segmenti che escono dalla cartella. */
export function jobPath(id, ...segments) {
  const base = jobDir(id);
  for (const s of segments) {
    if (typeof s !== 'string' || !s || s === '.' || s === '..' || /[\\/\0]/.test(s) || /^[a-z]:/i.test(s)) {
      throw new JobError('Nome di file non valido.', { status: 400, code: 'bad_path' });
    }
  }
  const p = path.resolve(base, ...segments);
  const rel = path.relative(base, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new JobError('Nome di file non valido.', { status: 400, code: 'bad_path' });
  return p;
}

// ------------------------------------------------------------------------------------------ nomi

const strip = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** "Tavolo Levante (v2).pdf" → "tavolo-levante-v2" */
export function slugify(s, max = 40) {
  const out = strip(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out.slice(0, max).replace(/-+$/g, '');
}

/** Nome leggibile da un nome di file: "TAVOLO_LEVANTE_originale.pdf" → "TAVOLO LEVANTE originale" */
export function prettyName(fileName) {
  const base = String(fileName ?? '').replace(/\.[a-z0-9]{1,5}$/i, '');
  const s = base.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s.slice(0, 80) || 'Manuale';
}

const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Nome di file sicuro (ASCII, niente percorsi, niente nomi riservati di Windows) con estensione dalla whitelist.
 * @returns {string|null}  null se l'estensione non è ammessa
 */
export function safeFileName(original, allowedExts, fallback = 'file') {
  const base = path.basename(String(original ?? '').replace(/\\/g, '/'));
  const m = /\.([a-z0-9]{1,5})$/i.exec(base);
  const ext = m ? m[1].toLowerCase() : '';
  if (!allowedExts.includes(ext)) return null;
  let stem = strip(base.slice(0, base.length - ext.length - 1))
    .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 80);
  if (!stem || WIN_RESERVED.test(stem)) stem = fallback;
  return `${stem}.${ext}`;
}

/**
 * Testo da mostrare (nome originale del file) senza caratteri di controllo. I nomi lunghi si accorciano
 * nella parte prima dell'estensione, che resta sempre (serve anche per riconoscere il formato).
 */
export function displayName(original, max = 160) {
  const base = path.basename(String(original ?? '').replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '');
  if (base.length <= max) return base;
  const m = /\.[A-Za-z0-9]{1,5}$/.exec(base);
  const ext = m ? m[0] : '';
  return base.slice(0, max - ext.length - 1).trimEnd() + '…' + ext;
}

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ------------------------------------------------------------------------------------------ struttura del job

export function emptyModel3d() {
  return {
    status: 'nessuno',          // nessuno | in_coda | importazione | pronto | errore
    pct: 0, message: '', error: null,
    file: null,                 // file importato (relativo al lavoro)
    up_axis_requested: 'auto',  // auto | y | z
    up_axis: null, up_axis_reason: null,
    part_count: null, group_count: null, size_text: null,
    views: [],                  // [{ key, label, file }] (file relativo a viste_parti/)
    imported_at: null,
    plan_sig: null,             // firma (manuale + modello) dell'ultimo piano dell'animazione
  };
}

function normalize(raw) {
  const j = raw && typeof raw === 'object' ? raw : {};
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const arr = (v) => (Array.isArray(v) ? v : []);
  const w = obj(j.warnings);
  return {
    ...j,
    id: j.id,
    name: typeof j.name === 'string' && j.name ? j.name : 'Manuale',
    created_at: j.created_at || new Date().toISOString(),
    updated_at: j.updated_at || j.created_at || new Date().toISOString(),
    input_file: j.input_file ?? null,
    input_name: j.input_name ?? null,
    input_kind: j.input_kind ?? null,
    model_file: j.model_file ?? null,
    model_name: j.model_name ?? null,
    status: typeof j.status === 'string' ? j.status : 'nuovo',
    progress: j.progress ?? null,
    error: j.error ?? null,
    task: j.task ?? null,
    outputs: { pdf: null, pdf_at: null, pdf_manual_at: null, video: null, poster: null, video_at: null, video_manual_at: null, ...obj(j.outputs) },
    video_mode: j.video_mode ?? null,
    video_quality: j.video_quality ?? null,
    video_duration: j.video_duration ?? null,
    warnings: { ingest: arr(w.ingest), images: arr(w.images), pdf: arr(w.pdf), video: arr(w.video), model: arr(w.model) },
    cost: j.cost ?? null,
    test_mode: !!j.test_mode,
    analysed_at: j.analysed_at ?? null,
    manual_saved_at: j.manual_saved_at ?? null,
    thumb: j.thumb ?? null,
    review: { verified: [], ...obj(j.review) },
    model3d: { ...emptyModel3d(), ...obj(j.model3d) },
  };
}

// ------------------------------------------------------------------------------------------ disco

const cache = new Map();        // id -> job (copia di lavoro)
const writeChains = new Map();  // id -> Promise (scritture in fila)
const lazyTimers = new Map();   // id -> timeout
const deleted = new Set();

async function atomicWrite(file, text) {
  // Su Windows rename può fallire per un attimo se il file è aperto (antivirus, indicizzatore): si riprova,
  // e in ultima istanza si scrive direttamente su job.json (meglio che perdere lo stato).
  // mkdir:false → se la cartella del lavoro è stata cancellata, ENOENT (gestito da persist) invece di ricrearla
  await writeFileAtomic(file, text, { fallbackCopy: true, mkdir: false });
}

function persist(id) {
  const t = lazyTimers.get(id);
  if (t) { clearTimeout(t); lazyTimers.delete(id); }
  const prev = writeChains.get(id) || Promise.resolve();
  const next = prev.then(async () => {
    if (deleted.has(id)) return;
    const job = cache.get(id);
    if (!job) return;
    try {
      await atomicWrite(path.join(jobDir(id), 'job.json'), JSON.stringify(job, null, 2) + '\n');
    } catch (err) {
      if (err?.code === 'ENOENT') return; // cartella cancellata nel frattempo
      console.error(`[lavori] impossibile salvare job.json di ${id}: ${err?.message || err}`);
    }
  });
  writeChains.set(id, next.catch(() => {}));
  return next;
}

function persistLazy(id) {
  if (lazyTimers.has(id)) return;
  lazyTimers.set(id, setTimeout(() => { lazyTimers.delete(id); persist(id); }, 500));
}

async function load(id) {
  if (cache.has(id)) return cache.get(id);
  const file = path.join(jobDir(id), 'job.json');
  let txt;
  try {
    txt = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  }
  let raw;
  try {
    raw = JSON.parse(txt.replace(/^﻿/, ''));
  } catch {
    return null; // job.json rovinato: il lavoro viene ignorato
  }
  if (cache.has(id)) return cache.get(id); // caricato da un'altra chiamata nel frattempo
  const job = normalize({ ...raw, id });
  cache.set(id, job);
  deleted.delete(id);
  return job;
}

const copy = (j) => structuredClone(j);

// ------------------------------------------------------------------------------------------ API

export async function createJob({ name, inputName } = {}) {
  const root = jobsRoot();
  await fs.mkdir(root, { recursive: true });
  const base = `${stamp()}-${slugify(name || prettyName(inputName)) || 'manuale'}`;
  let id = base;
  for (let n = 2; ; n++) {
    try {
      await fs.mkdir(path.join(root, id)); // non ricorsiva: fallisce se esiste già (id unico anche con richieste simultanee)
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST' || n > 999) throw err;
      id = `${base}-${n}`;
    }
  }
  const now = new Date().toISOString();
  const job = normalize({ id, name: name || prettyName(inputName), created_at: now, updated_at: now, status: 'nuovo' });
  cache.set(id, job);
  deleted.delete(id);
  await persist(id);
  events.emit('update', copy(job));
  return copy(job);
}

export async function listJobs() {
  let entries = [];
  try {
    entries = await fs.readdir(jobsRoot(), { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const jobs = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isValidJobId(e.name)) continue;
    try {
      const j = await load(e.name);
      if (j) jobs.push(copy(j));
    } catch { /* lavoro illeggibile: ignorato */ }
  }
  jobs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id));
  return jobs;
}

export async function getJob(id) {
  if (!isValidJobId(id)) return null;
  const j = await load(id);
  return j ? copy(j) : null;
}

export async function updateJob(id, patch, { lazy = false } = {}) {
  const j = await load(id);
  if (!j) throw new JobError('Lavoro non trovato.', { status: 404, code: 'job_not_found' });
  if (typeof patch === 'function') {
    const r = patch(j);
    if (r && typeof r === 'object' && r !== j) Object.assign(j, r);
  } else if (patch && typeof patch === 'object') {
    Object.assign(j, patch);
  }
  j.id = id;
  j.updated_at = new Date().toISOString();
  if (lazy) persistLazy(id);
  else await persist(id);
  const out = copy(j);
  events.emit('update', out);
  return out;
}

export async function deleteJob(id) {
  const dir = jobDir(id);
  deleted.add(id);
  const t = lazyTimers.get(id);
  if (t) { clearTimeout(t); lazyTimers.delete(id); }
  await (writeChains.get(id) || Promise.resolve());
  cache.delete(id);
  writeChains.delete(id);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  events.emit('deleted', id);
}

export async function appendLog(id, message) {
  if (!isValidJobId(id)) return;
  const lines = String(message).split(/\r?\n/).map((l) => `[${new Date().toISOString()}] [server] ${l}`);
  try {
    await fs.appendFile(path.join(jobDir(id), 'log.txt'), lines.join('\n') + '\n', 'utf8');
  } catch { /* il registro è facoltativo */ }
}

export async function markInterrupted() {
  const jobs = await listJobs();
  let n = 0;
  for (const job of jobs) {
    const busyMain = BUSY_STATUSES.has(job.status);
    const busyModel = job.model3d && (job.model3d.status === 'in_coda' || job.model3d.status === 'importazione');
    if (!busyMain && !busyModel) continue;
    n++;
    await updateJob(job.id, (j) => {
      if (busyMain) {
        const task = j.task || (j.status === 'pdf' ? 'pdf' : j.status === 'video' ? 'video' : 'analisi');
        j.error = {
          task,
          message: 'Il programma è stato chiuso mentre questa operazione era in corso. Premi «Riprova» per ricominciare.',
          code: 'interrupted',
          params: j.error?.params ?? j.task_params ?? null,
          at: new Date().toISOString(),
        };
        j.status = 'errore';
        j.progress = null;
        j.task = null;
      }
      if (busyModel) {
        j.model3d.status = 'errore';
        j.model3d.error = 'Il programma è stato chiuso durante la lettura del modello 3D. Premi «Riprova».';
        j.model3d.pct = 0;
      }
    });
    await appendLog(job.id, 'operazione interrotta: il programma era stato chiuso');
  }
  return n;
}

/**
 * All'avvio: toglie le cartelle con un id di lavoro valido ma senza job.json (resti di un lavoro cancellato
 * mentre un'operazione stava ancora scrivendo). Non tocca le cartelle con un job.json, anche se rovinato.
 * @returns {Promise<number>} cartelle tolte
 */
export async function sweepOrphans() {
  let entries = [];
  try {
    entries = await fs.readdir(jobsRoot(), { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !isValidJobId(e.name) || cache.has(e.name)) continue;
    const dir = path.join(jobsRoot(), e.name);
    try {
      await fs.access(path.join(dir, 'job.json'));
    } catch (err) {
      if (err?.code !== 'ENOENT') continue;
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).then(() => { n++; }, () => {});
    }
  }
  return n;
}

export async function flushAll() {
  for (const id of [...lazyTimers.keys()]) persist(id);
  await Promise.all([...writeChains.values()]);
}
