#!/usr/bin/env node
// Test del server (API HTTP, coda dei lavori, SSE, download, sicurezza dei percorsi) in MODALITÀ TEST:
// nessuna chiamata a Claude (MANUALI_AI_FIXTURE / MANUALI_PLAN_FIXTURE con le fixture del Tavolo Levante).
//
//   node test/test-server.js
//
// Avvia server.js su una porta libera con NO_BROWSER=1 e cartelle temporanee per lavori e impostazioni
// (<MANUALI_TEST_DIR>/server oppure <tmp>/strumento-manuali-test/server). Dura circa 3 minuti su 4 CPU senza GPU
// (PDF, video con immagini e video 3D in qualità "anteprima"). Esce con codice 1 se una verifica fallisce.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, openAsBlob } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeQrPng, renderPdfPage } from './qr-decode.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'tavolo-levante');
const WORK = path.resolve(process.env.MANUALI_TEST_DIR ? path.join(process.env.MANUALI_TEST_DIR, 'server') : path.join(os.tmpdir(), 'strumento-manuali-test', 'server'));
const JOBS = path.join(WORK, 'lavori');
const CONFIG = path.join(WORK, 'config');

let failures = 0;
let passed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log('  ok   ' + msg); } else { failures++; console.log('  FAIL ' + msg); }
};
const section = (s) => console.log('\n== ' + s);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

let server = null;
let BASE = '';
let PORT = 0;
async function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT), NO_BROWSER: '1', HOST: '',
      MANUALI_JOBS_DIR: JOBS, MANUALI_CONFIG_DIR: CONFIG,
      MANUALI_AI_FIXTURE: path.join(FIX, 'manual.json'),
      MANUALI_PLAN_FIXTURE: path.join(FIX, 'plan.json'),
      ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 150; i++) {
    if (out.includes('Strumento manuali pronto:')) return { child, out: () => out };
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Il server non è partito:\n' + out);
}

async function req(method, url, { json, body, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (json !== undefined) { opts.body = JSON.stringify(json); opts.headers['Content-Type'] = 'application/json'; }
  else if (body !== undefined) opts.body = body;
  const res = await fetch(BASE + url, opts);
  const type = res.headers.get('content-type') || '';
  let data = null;
  if (type.includes('application/json')) data = await res.json();
  else data = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, data };
}

/** Segue gli eventi SSE di un lavoro finché pred(job) è vero. */
async function waitJob(id, pred, { timeout = 300000, allowError = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const seen = [];
  let events = 0;
  try {
    const res = await fetch(`${BASE}/api/jobs/${id}/events`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`SSE: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('flusso SSE chiuso');
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        if (!data) continue;
        const job = JSON.parse(data);
        events++;
        if (seen[seen.length - 1] !== job.status) seen.push(job.status);
        if (pred(job)) return { job, seen, events };
        if (job.status === 'errore' && !allowError) throw new Error(`il lavoro è finito in errore: ${job.error?.message}`);
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`tempo scaduto in attesa del lavoro ${id} (stati visti: ${seen.join(' → ')})`);
    throw err;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/** Richiesta HTTP "a mano" (fetch non permette di cambiare l'intestazione Host). */
function rawReq(method, url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: url, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

/** Avvia una seconda copia del server (stessa cartella dei lavori) e ne aspetta l'uscita. */
function runSecondCopy(port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), NO_BROWSER: '1', HOST: '', MANUALI_JOBS_DIR: JOBS, MANUALI_CONFIG_DIR: CONFIG,
        MANUALI_AI_FIXTURE: path.join(FIX, 'manual.json'), MANUALI_PLAN_FIXTURE: path.join(FIX, 'plan.json'), ANTHROPIC_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function form(fields) {
  const fd = new FormData();
  for (const [name, file, filename] of fields) {
    if (typeof file === 'string' && existsSync(file)) fd.append(name, await openAsBlob(file), filename || path.basename(file));
    else fd.append(name, new Blob([file]), filename);
  }
  return fd;
}

const isMp4 = (buf) => buf.length > 1000 && buf.subarray(4, 8).toString('latin1') === 'ftyp';

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const t0 = Date.now();
  server = await startServer();

  // ------------------------------------------------------------------------------------------------
  section('Avvio, interfaccia e file statici');
  ok(server.out().includes(`Strumento manuali pronto: http://localhost:${PORT}`), 'messaggio di avvio con l’indirizzo');
  ok(server.out().includes('MODALITÀ TEST'), 'avviso di modalità test nella console');
  let r = await req('GET', '/api/health');
  ok(r.status === 200 && r.data.app === 'strumento-manuali' && r.data.testMode.ai === true, '/api/health');
  r = await req('GET', '/');
  ok(r.status === 200 && r.data.toString().includes('Strumento manuali') && r.headers.get('content-type').includes('html'), 'pagina principale');
  r = await req('GET', '/js/app.js');
  ok(r.status === 200 && /javascript/.test(r.headers.get('content-type')), 'script dell’interfaccia');
  r = await req('GET', '/fonts/barlow-latin-400-normal.woff2');
  ok(r.status === 200 && r.data.length > 1000, 'font Barlow servito da /fonts');
  r = await req('GET', '/api/non-esiste');
  ok(r.status === 404 && /non trovato/i.test(r.data.error), 'API sconosciuta → 404 in italiano');

  // ------------------------------------------------------------------------------------------------
  section('Impostazioni (la chiave non arriva mai al browser)');
  r = await req('GET', '/api/settings');
  ok(r.status === 200 && r.data.hasApiKey === false && r.data.model === 'claude-opus-5-5', 'nessuna chiave, modello predefinito');
  const fakeKey = 'sk-ant-api03-SEGRETO-TEST-0123456789abcdefghij-wxyz';
  r = await req('POST', '/api/settings', { json: { apiKey: fakeKey } });
  ok(r.status === 200 && r.data.hasApiKey === true && r.data.apiKeyHint === 'sk-ant-…wxyz', `chiave salvata, suggerimento mascherato (${r.data.apiKeyHint})`);
  ok(!JSON.stringify(r.data).includes('SEGRETO'), 'la risposta non contiene la chiave');
  r = await req('GET', '/api/settings');
  ok(!JSON.stringify(r.data).includes('SEGRETO') && r.data.apiKeySource === 'impostazioni', 'GET /api/settings non contiene la chiave');
  const saved = JSON.parse(await fs.readFile(path.join(CONFIG, 'settings.json'), 'utf8'));
  ok(saved.apiKey === fakeKey, 'chiave salvata sul server (config/settings.json)');
  r = await req('POST', '/api/settings', { json: { apiKey: 'ciao' } });
  ok(r.status === 400 && /sk-ant-/.test(r.data.error), `chiave non valida → 400 («${r.data.error}»)`);
  r = await req('POST', '/api/settings', { json: { theme: { accent: 'rosso' } } });
  ok(r.status === 400 && /#RRGGBB/.test(r.data.error), 'colore non valido → 400');
  r = await req('POST', '/api/settings', { json: { theme: { accent: '#0055AA' }, model: 'claude-opus-5-5' } });
  ok(r.status === 200 && r.data.theme.accent === '#0055AA', 'colore salvato');
  r = await req('POST', '/api/settings', { json: { theme: null, apiKey: null } });
  ok(r.status === 200 && r.data.theme.accent === '#FF7E00' && r.data.hasApiKey === false, 'colori predefiniti ripristinati e chiave rimossa');
  r = await req('POST', '/api/settings', { json: { apiKey: fakeKey }, headers: { Origin: 'http://sito-esterno.example' } });
  ok(r.status === 403, 'richiesta da un altro sito (Origin) rifiutata');
  r = await req('POST', '/api/settings', { body: '{non json', headers: { 'Content-Type': 'application/json' } });
  ok(r.status === 400 && /JSON/.test(r.data.error), 'JSON non valido → 400');
  r = await req('POST', '/api/settings', { json: { theme: null }, headers: { Origin: 'null' } });
  ok(r.status === 403, 'modifica con «Origin: null» (iframe isolato, file locale) rifiutata');

  section('Protezione dal «DNS rebinding» (intestazione Host)');
  let rr = await rawReq('GET', '/api/settings', { Host: `evil.example:${PORT}` });
  ok(rr.status === 421 && /localhost/.test(rr.body), `GET con Host di un altro sito → ${rr.status}`);
  rr = await rawReq('POST', '/api/jobs', { Host: `evil.example:${PORT}`, Origin: `http://evil.example:${PORT}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, '{}');
  ok(rr.status === 421, `POST con Host e Origin dello stesso sito esterno → ${rr.status}`);
  rr = await rawReq('POST', '/api/settings', { Host: `evil.example:${PORT}`, Origin: `http://evil.example:${PORT}`, 'Content-Type': 'application/json' }, '{"theme":{"accent":"#000000"}}');
  ok(rr.status === 421 && (await req('GET', '/api/settings')).data.theme.accent === '#FF7E00', 'impostazioni non modificabili da un sito esterno');
  rr = await rawReq('GET', '/', { Host: `localhost:${PORT}` });
  ok(rr.status === 200, 'Host «localhost» accettato');
  rr = await rawReq('GET', '/api/health', { Host: `[::1]:${PORT}` });
  ok(rr.status === 200, 'Host «[::1]» accettato');

  // ------------------------------------------------------------------------------------------------
  section('Caricamento: file sbagliati rifiutati subito');
  r = await req('POST', '/api/jobs', { body: await form([]) });
  ok(r.status === 400 && /manuale/i.test(r.data.error), `nessun file → 400 («${r.data.error}»)`);
  r = await req('POST', '/api/jobs', { body: await form([['documento', 'testo qualsiasi', 'appunti.txt']]) });
  ok(r.status === 400 && /PDF/.test(r.data.error), `file .txt → 400 («${r.data.error}»)`);
  r = await req('POST', '/api/jobs', { body: await form([['documento', 'questo non è un pdf', 'finto.pdf']]) });
  ok(r.status === 400 && /non è un PDF valido/.test(r.data.error), 'falso PDF → 400');
  r = await req('POST', '/api/jobs', { body: await form([['documento', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]), 'vecchio.docx']]) });
  ok(r.status === 400 && /\.doc|password/.test(r.data.error), 'Word vecchio formato → 400');
  r = await req('POST', '/api/jobs', { body: await form([['documento', path.join(FIX, 'TAVOLO_LEVANTE_originale.pdf')], ['modello3d', 'xx', 'modello.dwg']]) });
  ok(r.status === 400 && /formato 3D/.test(r.data.error), 'modello in formato non supportato → 400');
  r = await req('GET', '/api/jobs');
  ok(r.status === 200 && Array.isArray(r.data) && r.data.length === 0, 'nessun lavoro creato dai tentativi falliti');
  const leftovers = existsSync(path.join(JOBS, '.caricamenti')) ? await fs.readdir(path.join(JOBS, '.caricamenti')) : [];
  ok(leftovers.length === 0, 'nessun file temporaneo rimasto');

  // ------------------------------------------------------------------------------------------------
  section('Nuovo lavoro (PDF) → analisi → revisione');
  r = await req('POST', '/api/jobs', { body: await form([['documento', path.join(FIX, 'TAVOLO_LEVANTE_originale.pdf'), '../../Manuale Tavolo/../evil è.pdf']]) });
  ok(r.status === 201 && /^\d{8}-\d{6}-[a-z0-9-]+$/.test(r.data.id), `lavoro creato: ${r.data.id}`);
  const id = r.data.id;
  const dir = path.join(JOBS, id);
  ok(r.data.job.input_file === 'input/evil_e.pdf' && existsSync(path.join(dir, 'input', 'evil_e.pdf')), `nome del file ripulito (${r.data.job.input_file})`);
  ok(!existsSync(path.join(WORK, 'evil_e.pdf')) && !existsSync(path.join(JOBS, 'evil_e.pdf')), 'nessun file scritto fuori dalla cartella del lavoro');
  let w = await waitJob(id, (j) => j.status === 'revisione', { timeout: 120000 });
  ok(w.seen.includes('estrazione') && w.seen.includes('analisi'), `stati seguiti via SSE: ${w.seen.join(' → ')} (${w.events} eventi)`);
  ok(w.job.name === 'Tavolo Levante' && w.job.thumb === 'img_00' && w.job.test_mode === true, 'nome, miniatura e modalità test aggiornati');
  ok(w.job.cost === null, 'nessun costo in modalità test');
  ok(Array.isArray(w.job.warnings.ingest), 'avvisi della lettura presenti nel job');
  const jobJson = JSON.parse(await fs.readFile(path.join(dir, 'job.json'), 'utf8'));
  ok(jobJson.status === 'revisione' && jobJson.manual_saved_at, 'job.json scritto su disco');

  r = await req('GET', `/api/jobs/${id}/manual`);
  ok(r.status === 200 && r.data.steps.length === 7 && r.data.short_name === 'Tavolo Levante', 'GET scheda (7 passi)');
  const manual = r.data;
  r = await req('GET', `/api/jobs/${id}/catalog`);
  ok(r.status === 200 && r.data.length >= 14, `catalogo immagini (${r.data.length})`);
  r = await req('GET', `/api/jobs/${id}/image/img_00`);
  ok(r.status === 200 && r.headers.get('content-type') === 'image/png', 'immagine finale');
  r = await req('GET', `/api/jobs/${id}/image/img_00?thumb=1`);
  ok(r.status === 200 && r.headers.get('content-type') === 'image/jpeg', 'miniatura');
  r = await req('GET', `/api/jobs/${id}/document`);
  ok(r.status === 200 && r.headers.get('content-type') === 'application/pdf' && /^inline/.test(r.headers.get('content-disposition')), 'documento originale (PDF in linea)');
  r = await req('GET', `/api/jobs/${id}/document/preview`);
  ok(r.status === 200 && /default-src 'none'/.test(r.headers.get('content-security-policy') || ''), 'anteprima del testo con CSP restrittiva');
  r = await req('GET', '/api/jobs');
  ok(r.data.length === 1 && r.data[0].id === id && r.data[0].status === 'revisione', 'elenco dei lavori');

  section('Salvataggio della scheda (zod, messaggi in italiano)');
  const edited = structuredClone(manual);
  edited.steps[0].title = 'Posizionare i due fianchi';
  edited.steps[1].uses.push({ ref: 'X9', qty: 1 });
  r = await req('PUT', `/api/jobs/${id}/manual`, { json: edited });
  ok(r.status === 200 && r.data.ok && Array.isArray(r.data.warnings), 'PUT valido → 200');
  ok(r.data.warnings.some((x) => /X9/.test(x)), `avviso di buon senso sulla sigla sconosciuta («${r.data.warnings[0]}»)`);
  r = await req('GET', `/api/jobs/${id}/manual`);
  ok(r.data.steps[0].title === 'Posizionare i due fianchi', 'modifica salvata');
  const bad = structuredClone(manual);
  bad.steps[0].title = 5;
  bad.hardware[0].qty = 1.5;
  delete bad.short_name;
  bad.changes[0].kind = 'boh';
  r = await req('PUT', `/api/jobs/${id}/manual`, { json: bad });
  ok(r.status === 400 && /errori/.test(r.data.error), `PUT non valido → 400 («${r.data.error.slice(0, 90)}…»)`);
  const labels = (r.data.issues || []).map((i) => `${i.label}: ${i.message}`);
  ok(labels.includes('Passo 1 › Titolo: deve essere un testo'), 'errore «Passo 1 › Titolo: deve essere un testo»');
  ok(labels.some((l) => /^Ferramenta 1 › Quantità: deve essere un numero intero/.test(l)), 'errore sulla quantità non intera');
  ok(labels.includes('Nome breve: manca'), 'errore «Nome breve: manca»');
  ok(labels.some((l) => /^Modifica 1 › Tipo: valore non ammesso/.test(l)), 'errore sul tipo di modifica');
  ok((r.data.issues || []).every((i) => typeof i.path === 'string'), 'ogni errore ha il percorso del campo (per evidenziarlo)');
  r = await req('GET', `/api/jobs/${id}/manual`);
  ok(r.data.steps[0].title === 'Posizionare i due fianchi' && r.data.short_name === 'Tavolo Levante', 'la scheda su disco non è cambiata');
  r = await req('PUT', `/api/jobs/${id}/manual`, { json: [1, 2] });
  ok(r.status === 400, 'PUT con un array → 400');
  r = await req('PATCH', `/api/jobs/${id}`, { json: { review: { verified: [0, 5, 'x', -1] } } });
  ok(r.status === 200 && JSON.stringify(r.data.review.verified) === '[0,5]', 'verifiche «ho verificato» salvate');

  section('Salvataggi simultanei della scheda (due schede aperte)');
  const parallel = await Promise.all(Array.from({ length: 8 }, (_, i) => {
    const m = structuredClone(edited);
    m.steps[0].title = `Titolo parallelo ${i}`;
    return req('PUT', `/api/jobs/${id}/manual`, { json: m });
  }));
  ok(parallel.every((x) => x.status === 200), `8 salvataggi in parallelo → ${[...new Set(parallel.map((x) => x.status))].join(', ')}`);
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'manual.json'), 'utf8'));
  ok(/^Titolo parallelo \d$/.test(onDisk.steps[0].title), 'manual.json integro dopo i salvataggi simultanei');
  ok(!(await fs.readdir(dir)).some((f) => f.endsWith('.tmp')), 'nessun file temporaneo rimasto');
  r = await req('PUT', `/api/jobs/${id}/manual`, { json: edited });
  ok(r.status === 200, 'scheda rimessa com’era');

  section('Nome di file lungo; cancellazione durante la lettura del documento');
  const longName = 'Manuale di montaggio ' + 'tavolo '.repeat(42) + 'versione finale.pdf'; // ~330 caratteri (Windows ne ammette 255)
  r = await req('POST', '/api/jobs', { body: await form([['documento', path.join(FIX, 'TAVOLO_LEVANTE_originale.pdf'), longName]]) });
  ok(r.status === 201 && /\.pdf$/.test(r.data.job?.input_name || '') && r.data.job.input_name.length <= 160,
    `nome lungo accettato, accorciato tenendo l’estensione (${r.status}: «…${String(r.data.job?.input_name || r.data.error).slice(-24)}»)`);
  const id2 = r.data.id;
  if (id2) {
    const w2 = await waitJob(id2, (j) => j.status === 'revisione' || (j.progress && !j.progress.queued && ['estrazione', 'immagini'].includes(j.progress.stage)), { timeout: 60000 });
    const during = w2.job.status !== 'revisione';
    const tDel = Date.now();
    r = await req('DELETE', `/api/jobs/${id2}`);
    const secs = (Date.now() - tDel) / 1000;
    ok(r.status === 200 && secs < 10, `DELETE ${during ? 'durante la lettura del documento' : 'a lettura già finita'} → ${r.status} in ${secs.toFixed(1)} s`);
    await sleep(3000);
    ok(!existsSync(path.join(JOBS, id2)), 'nessuna cartella orfana rimasta (la lettura si è fermata)');
    r = await req('GET', '/api/jobs');
    ok(r.data.length === 1 && r.data[0].id === id, 'elenco dei lavori: resta solo il primo');
  }

  // ------------------------------------------------------------------------------------------------
  section('PDF');
  r = await req('POST', `/api/jobs/${id}/pdf`);
  ok(r.status === 202, 'POST pdf → 202');
  r = await req('POST', `/api/jobs/${id}/pdf`);
  ok(r.status === 409 && /già un’operazione/.test(r.data.error), 'seconda richiesta durante l’operazione → 409');
  w = await waitJob(id, (j) => j.status === 'pdf_pronto', { timeout: 240000 });
  ok(w.job.outputs.pdf === 'out/manuale.pdf' && w.job.outputs.pdf_pages > 3, `PDF pronto (${w.job.outputs.pdf_pages} pagine)`);
  ok(Array.isArray(w.job.warnings.pdf), `avvisi di impaginazione nel job (${w.job.warnings.pdf.length})`);
  ok(w.job.outputs.pdf_manual_at === w.job.manual_saved_at, 'il PDF ricorda la versione della scheda usata (pdf_manual_at)');
  r = await req('GET', `/api/jobs/${id}/files/manuale.pdf?download=1`);
  ok(r.status === 200 && r.headers.get('content-type') === 'application/pdf', 'download del PDF');
  ok(/attachment; filename="?Istruzioni_Montaggio_Tavolo_Levante\.pdf/.test(r.headers.get('content-disposition')), `nome del file: ${r.headers.get('content-disposition')}`);
  ok(r.data.subarray(0, 5).toString() === '%PDF-' && r.data.length > 100000, `contenuto PDF (${Math.round(r.data.length / 1024)} KB)`);
  r = await req('GET', `/api/jobs/${id}/files/manuale.pdf`);
  ok(/^inline/.test(r.headers.get('content-disposition')), 'anteprima del PDF in linea');

  section('Scheda salvata mentre il PDF è in creazione → PDF da rifare');
  r = await req('POST', `/api/jobs/${id}/pdf`);
  await waitJob(id, (j) => j.status === 'pdf' && j.progress && !j.progress.queued && j.progress.pct >= 3, { timeout: 60000 });
  const during = structuredClone(edited);
  during.steps[0].title = 'Titolo cambiato durante la creazione del PDF';
  r = await req('PUT', `/api/jobs/${id}/manual`, { json: during });
  ok(r.status === 200, 'salvataggio durante la creazione del PDF → 200');
  w = await waitJob(id, (j) => j.status === 'pdf_pronto', { timeout: 240000 });
  ok(w.job.outputs.pdf_manual_at && w.job.outputs.pdf_manual_at < w.job.manual_saved_at && w.job.outputs.pdf_at > w.job.manual_saved_at,
    'PDF finito dopo il salvataggio ma fatto con la scheda precedente: segnalato come da rifare');
  r = await req('PUT', `/api/jobs/${id}/manual`, { json: edited });

  // ------------------------------------------------------------------------------------------------
  section('Link del video → QR code a pagina 2 del PDF');
  r = await req('GET', `/api/jobs/${id}`);
  ok(r.data.video_url === null && r.data.outputs.pdf_video_url === null, 'all’inizio nessun link del video (video_url: null)');
  for (const [value, re, label] of [
    ['ftp://esempio.it/video', /https:\/\//, 'ftp://'],
    ['javascript:alert(1)', /https:\/\//, 'javascript:'],
    ['guarda il video', /spazi|valido/, 'testo qualsiasi'],
    [`https://esempio.it/${'v'.repeat(490)}`, /500/, 'più di 500 caratteri'],
    [42, /testo/, 'numero'],
  ]) {
    r = await req('PATCH', `/api/jobs/${id}`, { json: { video_url: value } });
    ok(r.status === 400 && re.test(r.data.error || ''), `link non valido (${label}) → ${r.status} («${r.data.error}»)`);
  }
  r = await req('GET', `/api/jobs/${id}`);
  ok(r.data.video_url === null, 'i link non validi non vengono salvati');
  const VIDEO_URL = 'https://youtu.be/Levante-montaggio';
  r = await req('PATCH', `/api/jobs/${id}`, { json: { video_url: `  ${VIDEO_URL}  `, name: 'Tavolo Levante' } });
  ok(r.status === 200 && r.data.video_url === VIDEO_URL && r.data.name === 'Tavolo Levante', 'link salvato (spazi tolti), insieme agli altri campi');
  ok(r.data.outputs.pdf && r.data.outputs.pdf_video_url === null, 'il PDF esistente non ha ancora il QR (video_url ≠ outputs.pdf_video_url: da ricreare)');
  ok(JSON.parse(await fs.readFile(path.join(dir, 'job.json'), 'utf8')).video_url === VIDEO_URL, 'link scritto in job.json');
  r = await req('POST', `/api/jobs/${id}/pdf`);
  ok(r.status === 202, 'Ricrea il PDF → 202');
  w = await waitJob(id, (j) => j.status === 'pdf_pronto' && j.outputs.pdf_video_url === VIDEO_URL, { timeout: 240000 });
  ok(w.job.outputs.pdf_video_url === VIDEO_URL && w.job.video_url === VIDEO_URL, 'PDF ricreato con il QR del link (outputs.pdf_video_url)');
  const layQr = JSON.parse(await fs.readFile(path.join(dir, 'pdf-build', 'layout.json'), 'utf8'));
  ok(layQr.qr?.page === 2 && layQr.qr.url === VIDEO_URL && layQr.overflow.length === 0 && layQr.forced.length === 0,
    `layout.json: QR a pagina ${layQr.qr?.page}, ${layQr.qr?.size_mm} mm, nessuno sbordamento`);
  const htmlQr = await fs.readFile(path.join(dir, 'pdf-build', 'manuale.impaginato.html'), 'utf8');
  ok((htmlQr.match(/<svg class="qr-svg"/g) || []).length === 1 && htmlQr.includes('>youtu.be/Levante-montaggio<'), 'riquadro con il QR (SVG) e il link stampato');
  const png2 = renderPdfPage(path.join(dir, 'out', 'manuale.pdf'), 2, path.join(WORK, 'pagina2-qr'));
  const qrText = png2 ? await decodeQrPng(png2) : undefined;
  if (qrText === undefined) console.log('  (lettura del QR saltata: manca pdftoppm o un lettore di QR)');
  else ok(qrText === VIDEO_URL, `QR letto dalla pagina 2 del PDF: ${qrText}`);
  r = await req('PATCH', `/api/jobs/${id}`, { json: { video_url: VIDEO_URL } });
  ok(r.status === 200 && r.data.outputs.pdf_video_url === r.data.video_url, 'stesso link salvato di nuovo: il PDF resta aggiornato');
  r = await req('PATCH', `/api/jobs/${id}`, { json: { video_url: '' } });
  ok(r.status === 200 && r.data.video_url === null && r.data.outputs.pdf_video_url === VIDEO_URL, 'link vuoto → null (il PDF con il QR va ricreato)');
  r = await req('PATCH', `/api/jobs/${id}`, { json: { video_url: null } });
  ok(r.status === 200 && r.data.video_url === null, 'link null → null');
  const logQr = await fs.readFile(path.join(dir, 'log.txt'), 'utf8');
  ok(/link del video per il QR code del PDF aggiornato/.test(logQr) && /link del video per il QR code del PDF tolto/.test(logQr), 'modifiche del link nel registro del lavoro');

  // ------------------------------------------------------------------------------------------------
  section('Video con immagini (anteprima)');
  r = await req('POST', `/api/jobs/${id}/video`, { json: { mode: '3d', quality: 'anteprima' } });
  ok(r.status === 409 && /modello 3D/.test(r.data.error), 'video 3D senza modello → 409');
  r = await req('POST', `/api/jobs/${id}/video`, { json: { mode: 'immagini', quality: '4k' } });
  ok(r.status === 400 && /Qualità/.test(r.data.error), 'qualità non valida → 400');
  r = await req('POST', `/api/jobs/${id}/video`, { json: { mode: 'immagini', quality: 'anteprima' } });
  ok(r.status === 202, 'POST video immagini → 202');
  let etaSeen = false;
  w = await waitJob(id, (j) => { if (j.progress?.eta_s) etaSeen = true; return j.status === 'completato'; }, { timeout: 300000 });
  ok(w.job.outputs.video === 'out/video.mp4' && w.job.video_mode === 'immagini' && w.job.video_duration > 10, `video pronto (${w.job.video_duration} s)`);
  ok(etaSeen, 'stima del tempo rimanente durante il rendering');
  r = await req('GET', `/api/jobs/${id}/files/video.mp4?download=1`);
  ok(r.status === 200 && r.headers.get('content-type') === 'video/mp4' && isMp4(r.data), `download MP4 (${Math.round(r.data.length / 1024)} KB)`);
  ok(/Montaggio_Tavolo_Levante\.mp4/.test(r.headers.get('content-disposition')), `nome del file: ${r.headers.get('content-disposition')}`);
  r = await req('GET', `/api/jobs/${id}/files/video.mp4`, { headers: { Range: 'bytes=0-99' } });
  ok(r.status === 206 && r.data.length === 100, 'richieste parziali (Range) per il lettore video');
  r = await req('GET', `/api/jobs/${id}/files/poster.jpg`);
  ok(r.status === 200 && r.headers.get('content-type') === 'image/jpeg', 'immagine di copertina del video');

  section('Annullamento');
  r = await req('POST', `/api/jobs/${id}/video`, { json: { mode: 'immagini', quality: 'anteprima' } });
  await waitJob(id, (j) => j.status === 'video' && j.progress && !j.progress.queued && j.progress.pct > 5, { timeout: 60000 });
  r = await req('POST', `/api/jobs/${id}/cancel`);
  ok(r.status === 202, 'POST cancel → 202');
  w = await waitJob(id, (j) => j.status !== 'video', { timeout: 60000 });
  ok(w.job.status === 'completato' && w.job.error === null && w.job.outputs.video, 'dopo l’annullamento il lavoro torna com’era (video precedente conservato)');
  r = await req('POST', `/api/jobs/${id}/cancel`);
  ok(r.status === 409, 'annullare senza operazioni in corso → 409');

  // ------------------------------------------------------------------------------------------------
  section('Modello 3D non leggibile → messaggio in italiano');
  r = await req('POST', `/api/jobs/${id}/model`, { body: await form([['modello3d', Buffer.alloc(1024, 0xab), 'rotto.stl']]) });
  ok(r.status === 202, 'file .stl qualsiasi caricato');
  w = await waitJob(id, (j) => j.model3d.status === 'errore' || j.model3d.status === 'pronto', { timeout: 120000 });
  ok(w.job.model3d.status === 'errore' && /Non riesco a leggere il file 3D «rotto\.stl»/.test(w.job.model3d.error) && !/DataView|Offset|bounds/i.test(w.job.model3d.error),
    `errore comprensibile («${String(w.job.model3d.error).slice(0, 70)}…»)`);
  ok(w.job.status === 'completato' && w.job.error === null, 'il lavoro resta com’era (PDF e video disponibili)');
  ok(/ERRORE \(lettura del modello 3D\): \S/.test(await fs.readFile(path.join(dir, 'log.txt'), 'utf8')), 'dettagli tecnici solo nel registro del lavoro');

  section('Modello 3D (GLB) → viste delle parti → video 3D (anteprima)');
  r = await req('POST', `/api/jobs/${id}/model`, { body: await form([['modello3d', path.join(FIX, 'tavolo-parametrico.glb')]]) });
  ok(r.status === 202 && r.data.model_file === 'modello/tavolo-parametrico.glb', 'modello caricato');
  w = await waitJob(id, (j) => j.model3d.status === 'pronto' || j.model3d.status === 'errore', { timeout: 300000 });
  ok(w.job.model3d.status === 'pronto' && w.job.model3d.part_count === 32, `modello letto: ${w.job.model3d.part_count} parti, asse ${w.job.model3d.up_axis}`);
  ok(w.job.model3d.views.length >= 2, `viste delle parti: ${w.job.model3d.views.length}`);
  r = await req('GET', `/api/jobs/${id}/views/${w.job.model3d.views[0].name}`);
  ok(r.status === 200 && r.headers.get('content-type') === 'image/png', 'vista d’insieme (PNG)');
  r = await req('GET', `/api/jobs/${id}/views/${w.job.model3d.views[0].ui_name}`);
  ok(r.status === 200 && r.headers.get('content-type') === 'image/png', 'vista d’insieme senza etichetta per l’interfaccia (ui_name)');
  r = await req('POST', `/api/jobs/${id}/model/reimport`, { json: { upAxis: 'x' } });
  ok(r.status === 400, 'asse verticale non valido → 400');
  r = await req('POST', `/api/jobs/${id}/video`, { json: { mode: '3d', quality: 'anteprima' } });
  ok(r.status === 202, 'POST video 3D → 202');
  w = await waitJob(id, (j) => j.status === 'completato' && j.video_mode === '3d', { timeout: 600000 });
  ok(w.seen.includes('video'), 'video 3D seguito via SSE');
  ok(existsSync(path.join(dir, 'plan.json')) && w.job.model3d.plan_sig, 'piano dell’animazione (fixture) salvato');
  ok(w.job.video_duration > 20, `video 3D pronto (${w.job.video_duration} s)`);
  r = await req('GET', `/api/jobs/${id}/files/video.mp4?download=1`);
  ok(r.status === 200 && isMp4(r.data), `download MP4 3D (${Math.round(r.data.length / 1024)} KB)`);
  const log = (await req('GET', `/api/jobs/${id}/log`)).data.toString();
  ok(/MODALITÀ TEST/.test(log) && /inizio: creazione del video/.test(log), 'registro del lavoro (log.txt)');

  section('Registro illeggibile: il server non si ferma');
  const logFile = path.join(dir, 'log.txt');
  await fs.rename(logFile, logFile + '.bak');
  await fs.mkdir(logFile);
  r = await req('GET', `/api/jobs/${id}/log`);
  ok(r.status >= 400 && r.status < 600, `GET del registro con log.txt illeggibile → ${r.status}`);
  r = await req('GET', '/api/health');
  ok(r.status === 200 && server.child.exitCode === null, 'il server risponde ancora');
  await fs.rm(logFile, { recursive: true, force: true });
  await fs.rename(logFile + '.bak', logFile);

  // ------------------------------------------------------------------------------------------------
  section('Percorsi non consentiti (path traversal)');
  const traversal = [
    ['GET', '/api/jobs/..%2F..%2Fpackage.json'],
    ['GET', '/api/jobs/..%2F..%2Fconfig%2Fsettings.json/manual'],
    ['GET', `/api/jobs/${id}/files/..%2Fjob.json`],
    ['GET', `/api/jobs/${id}/files/job.json`],
    ['GET', `/api/jobs/${id}/files/..%5C..%5Cpackage.json`],
    ['GET', `/api/jobs/${id}/image/..%2F..%2Fjob`],
    ['GET', `/api/jobs/${id}/image/img_00.png`],
    ['GET', `/api/jobs/${id}/image/..%2Fmanual`],
    ['GET', `/api/jobs/${id}/views/..%2Fjob.json`],
    ['GET', `/api/jobs/${id}/views/..%5Cjob.json`],
    ['GET', `/api/jobs/${id}/views/.htaccess`],
    ['GET', '/fonts/..%2F..%2Fpackage.json'],
    ['GET', '/..%2Fpackage.json'],
    ['GET', '/%2e%2e/%2e%2e/package.json'],
    ['DELETE', '/api/jobs/..%2F..%2F'],
    ['DELETE', '/api/jobs/%2E%2E'],
  ];
  for (const [method, url] of traversal) {
    r = await req(method, url);
    const text = Buffer.isBuffer(r.data) ? r.data.toString() : JSON.stringify(r.data);
    ok(r.status >= 400 && r.status < 500 && !text.includes('"dependencies"') && !text.includes('"status": "completato"') && !text.includes('apiKey'), `${method} ${url} → ${r.status}`);
  }
  ok(existsSync(path.join(ROOT, 'package.json')) && existsSync(dir), 'nessun file cancellato');

  // ------------------------------------------------------------------------------------------------
  section('Programma chiuso durante un’operazione → «Riprova»');
  r = await req('POST', `/api/jobs/${id}/video`, { json: { mode: 'immagini', quality: 'anteprima' } });
  await waitJob(id, (j) => j.status === 'video' && j.progress && !j.progress.queued && j.progress.pct > 3, { timeout: 60000 });
  // doppio clic in più sullo script di avvio mentre lo strumento lavora: la seconda copia non deve toccare nulla
  await fs.mkdir(path.join(JOBS, '.caricamenti'), { recursive: true });
  await fs.writeFile(path.join(JOBS, '.caricamenti', 'in-corso.upload'), 'caricamento della prima copia');
  const second = await runSecondCopy(PORT);
  ok(second.code === 0 && /già aperto/.test(second.out), `seconda copia sulla stessa porta: «già aperto», uscita ${second.code}`);
  const third = await runSecondCopy(await freePort());
  ok(third.code === 0 && /già aperto/.test(third.out) && third.out.includes(`localhost:${PORT}`), 'seconda copia su un’altra porta: riconosce quella attiva (lavori/.server.lock)');
  ok(existsSync(path.join(JOBS, '.caricamenti', 'in-corso.upload')), 'i caricamenti in corso della prima copia restano');
  const diskJob = JSON.parse(await fs.readFile(path.join(dir, 'job.json'), 'utf8'));
  r = await req('GET', `/api/jobs/${id}`);
  ok(diskJob.status === 'video' && !diskJob.error && r.data.status === 'video', 'il lavoro in corso non viene segnato come interrotto');
  ok(!/interrotta/.test(await fs.readFile(path.join(dir, 'log.txt'), 'utf8').then((t) => t.split('\n').slice(-20).join('\n'))), 'nessuna «operazione interrotta» nel registro');
  server.child.kill('SIGKILL');
  await new Promise((res) => server.child.once('exit', res));
  server = await startServer();
  ok(/a metà/.test(server.out()), 'all’avvio il server segnala il lavoro rimasto a metà');
  r = await req('GET', `/api/jobs/${id}`);
  ok(r.data.status === 'errore' && r.data.error.task === 'video' && r.data.error.code === 'interrupted', `stato dopo il riavvio: ${r.data.status} («${r.data.error?.message}»)`);
  r = await req('POST', `/api/jobs/${id}/retry`);
  ok(r.status === 202 && r.data.status === 'video' && r.data.task === 'video', 'Riprova rimette in coda il video con gli stessi parametri');
  await req('POST', `/api/jobs/${id}/cancel`);
  w = await waitJob(id, (j) => j.status !== 'video', { timeout: 60000, allowError: true });
  ok(w.job.status === 'completato', 'annullato il nuovo tentativo, il video precedente resta disponibile');

  // ------------------------------------------------------------------------------------------------
  section('Cancellazione');
  r = await req('DELETE', `/api/jobs/${id}`);
  ok(r.status === 200, 'DELETE lavoro → 200');
  r = await req('GET', `/api/jobs/${id}`);
  ok(r.status === 404, 'il lavoro non esiste più');
  ok(!existsSync(dir), 'cartella del lavoro eliminata');

  console.log(`\nDurata: ${Math.round((Date.now() - t0) / 1000)} s`);
}

main().catch((err) => {
  failures++;
  console.error('\nERRORE:', err?.stack || err);
  if (server) console.error('--- uscita del server ---\n' + server.out().slice(-3000));
}).finally(async () => {
  if (server) server.child.kill();
  console.log(`\n${passed} verifiche superate, ${failures} fallite.`);
  process.exit(failures ? 1 : 0);
});
