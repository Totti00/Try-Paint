#!/usr/bin/env node
// Test dell'interfaccia nel browser (Chromium di Playwright) in MODALITÀ TEST, senza Claude:
//   - pagina del video con un modello 3D non leggibile (niente pagina bloccata, «Riprova» funzionante via SSE);
//   - errore «manca la chiave»: «Vai a Impostazioni» è il pulsante principale;
//   - revisione e PDF su uno schermo da telefono (390 px: niente scorrimento orizzontale, PDF da aprire a parte);
//   - 7 schede aperte: le schede nascoste chiudono il flusso SSE e lo strumento resta raggiungibile.
//
//   node test/test-ui.js        (circa 1 minuto)
//
// Cartella di lavoro: <MANUALI_TEST_DIR>/ui oppure <tmp>/strumento-manuali-test/ui (lì restano anche le schermate).

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'tavolo-levante');
const WORK = path.resolve(process.env.MANUALI_TEST_DIR ? path.join(process.env.MANUALI_TEST_DIR, 'ui') : path.join(os.tmpdir(), 'strumento-manuali-test', 'ui'));
const SHOTS = path.join(WORK, 'schermate');

let failures = 0;
let passed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log('  ok   ' + msg); } else { failures++; console.log('  FAIL ' + msg); }
};
const section = (s) => console.log('\n== ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

const servers = [];
async function startServer(name, { fixture = true } = {}) {
  const port = await freePort();
  const dir = path.join(WORK, name);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), NO_BROWSER: '1', HOST: '',
      MANUALI_JOBS_DIR: path.join(dir, 'lavori'), MANUALI_CONFIG_DIR: path.join(dir, 'config'),
      MANUALI_AI_FIXTURE: fixture ? path.join(FIX, 'manual.json') : '',
      MANUALI_PLAN_FIXTURE: fixture ? path.join(FIX, 'plan.json') : '',
      ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const srv = { child, base: `http://127.0.0.1:${port}`, out: () => out };
  servers.push(srv);
  for (let i = 0; i < 150; i++) {
    if (out.includes('Strumento manuali pronto:')) return srv;
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error('Il server non è partito:\n' + out);
}

async function api(srv, method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(srv.base + url, opts);
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

async function waitFor(srv, id, pred, timeout = 120000) {
  const until = Date.now() + timeout;
  let job = null;
  while (Date.now() < until) {
    job = (await api(srv, 'GET', `/api/jobs/${id}`)).data;
    if (pred(job)) return job;
    await sleep(250);
  }
  throw new Error(`tempo scaduto in attesa del lavoro ${id} (stato: ${job?.status}, modello: ${job?.model3d?.status})`);
}

async function newJob(srv) {
  const fd = new FormData();
  fd.append('documento', await openAsBlob(path.join(FIX, 'TAVOLO_LEVANTE_originale.pdf')), 'TAVOLO_LEVANTE.pdf');
  const r = await api(srv, 'POST', '/api/jobs', fd);
  if (r.status !== 201) throw new Error('creazione del lavoro non riuscita: ' + JSON.stringify(r.data));
  return r.data.id;
}

/** pagina con raccolta degli errori JavaScript */
async function openPage(context, url, errors) {
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e?.message || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_ABORTED|net::/.test(m.text())) errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(SHOTS, { recursive: true });
  const t0 = Date.now();
  const srv = await startServer('principale');
  const browser = await chromium.launch();
  try {
    // ----------------------------------------------------------------------------------------------
    section('Lavoro di prova: analisi (scheda di prova) e modello 3D non leggibile');
    const id = await newJob(srv);
    await waitFor(srv, id, (j) => j.status === 'revisione');
    ok(true, `lavoro ${id} pronto per la revisione`);
    const fd = new FormData();
    fd.append('modello3d', new Blob([Buffer.alloc(1024, 0xab)]), 'rotto.stl');
    let r = await api(srv, 'POST', `/api/jobs/${id}/model`, fd);
    ok(r.status === 202, 'file .stl non valido caricato');
    let job = await waitFor(srv, id, (j) => j.model3d.status === 'errore' || j.model3d.status === 'pronto');
    ok(job.model3d.status === 'errore', 'lettura del modello non riuscita, come previsto');
    ok(/Non riesco a leggere il file 3D «rotto\.stl»/.test(job.model3d.error || '') && !/DataView|Offset|bounds|undefined/.test(job.model3d.error || ''),
      `messaggio in italiano, senza dettagli tecnici («${(job.model3d.error || '').slice(0, 80)}…»)`);

    // ----------------------------------------------------------------------------------------------
    section('Pagina del video con il modello in errore');
    const errors = [];
    const desk = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'it-IT' });
    let page = await openPage(desk, `${srv.base}/#/lavoro/${id}/video`, errors);
    await page.getByText('Il modello 3D non è stato letto', { exact: true }).waitFor({ timeout: 15000 });
    ok(true, 'riquadro «Il modello 3D non è stato letto»');
    ok(!(await page.getByText('Qualcosa non ha funzionato').count()), 'nessuna pagina di errore generico');
    const box = page.locator('.model-box');
    ok(await box.getByRole('button', { name: 'Riprova' }).count() === 1, 'pulsante «Riprova» del modello');
    ok(await box.getByRole('button', { name: 'Carica un altro file' }).count() >= 1 && await box.getByRole('button', { name: 'Togli' }).count() === 1,
      'pulsanti «Carica un altro file» e «Togli» raggiungibili');
    ok(/btn-primary/.test(await box.locator('.notice').getByRole('button', { name: 'Carica un altro file' }).getAttribute('class')),
      'file rovinato: azione principale «Carica un altro file» (rileggere lo stesso file non serve)');
    ok(await page.getByRole('button', { name: 'Crea il video' }).isDisabled(), '«Crea il video» (3D) disattivato finché il modello non è letto');
    await page.screenshot({ path: path.join(SHOTS, 'video-modello-errore.png'), fullPage: true });
    // «Riprova» nella pagina: in coda → lettura → errore di nuovo, tutto via SSE senza bloccare la pagina
    const before = (await api(srv, 'GET', `/api/jobs/${id}`)).data.updated_at;
    await box.getByRole('button', { name: 'Riprova' }).click();
    await waitFor(srv, id, (j) => j.model3d.status === 'errore' && j.updated_at !== before);
    await page.getByText('Il modello 3D non è stato letto', { exact: true }).waitFor({ timeout: 15000 });
    await sleep(500);
    ok(await page.locator('.model-box .notice').count() === 1, 'dopo «Riprova» la pagina si aggiorna da sola e mostra di nuovo l’errore');
    // apertura del lavoro dalla pagina iniziale (il passo predefinito di un lavoro con il modello in errore)
    page = await openPage(desk, `${srv.base}/#/lavoro/${id}`, errors);
    await page.locator('.stepper').waitFor({ timeout: 15000 });
    await sleep(800);
    ok(!(await page.getByText('Qualcosa non ha funzionato').count()), '«Apri» il lavoro: pagina regolare');
    ok(!errors.length, `nessun errore JavaScript${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
    await desk.close();

    // ----------------------------------------------------------------------------------------------
    section('Schermo da telefono (390 px): revisione e PDF');
    r = await api(srv, 'POST', `/api/jobs/${id}/pdf`, {});
    ok(r.status === 202, 'creazione del PDF avviata');
    const phoneErrors = [];
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'it-IT' });
    page = await openPage(phone, `${srv.base}/#/lavoro/${id}/revisione`, phoneErrors);
    await page.locator('.change').first().waitFor({ timeout: 15000 });
    await sleep(500);
    const sw = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
    ok(sw.sw <= sw.w, `revisione: nessuno scorrimento orizzontale (larghezza contenuto ${sw.sw} px su ${sw.w})`);
    const chg = await page.locator('.change').first().boundingBox();
    ok(chg && chg.x >= 0 && chg.x + chg.width <= 390.5, 'riquadri «Modifiche fatte dall’AI» dentro lo schermo');
    await page.locator('#sez-modifiche').screenshot({ path: path.join(SHOTS, 'telefono-modifiche.png') }).catch(() => {});
    await waitFor(srv, id, (j) => j.status === 'pdf_pronto' || j.status === 'errore', 180000);
    page = await openPage(phone, `${srv.base}/#/lavoro/${id}/pdf`, phoneErrors);
    await page.getByText('Il tuo manuale PDF').waitFor({ timeout: 15000 });
    ok(!(await page.locator('iframe.pdf-frame').isVisible()), 'PDF: anteprima incorporata nascosta sul telefono');
    ok(await page.locator('.pdf-mobile-note').isVisible() && await page.getByRole('link', { name: 'Scarica il PDF' }).isVisible(), 'PDF: avviso e pulsanti «Scarica»/«Apri in una scheda»');
    await page.screenshot({ path: path.join(SHOTS, 'telefono-pdf.png'), fullPage: true });
    ok(!phoneErrors.length, `nessun errore JavaScript${phoneErrors.length ? ': ' + phoneErrors.slice(0, 3).join(' | ') : ''}`);
    await phone.close();

    // ----------------------------------------------------------------------------------------------
    section('Sette schede aperte (il browser concede 6 connessioni per indirizzo)');
    const tabs = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    const tabErrors = [];
    const pages = [];
    const hide = (p) => p.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const show = (p) => p.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    for (let i = 0; i < 7; i++) {
      const url = i % 2 ? `${srv.base}/#/lavoro/${id}/pdf` : `${srv.base}/#/`;
      const p = await tabs.newPage();
      p.on('pageerror', (e) => tabErrors.push(String(e?.message || e)));
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await sleep(400);
      pages.push(p);
      if (i < 6) await hide(p); // le schede "dietro" non sono visibili
    }
    const last = pages[6];
    const fetchMs = (p) => p.evaluate(async () => {
      const t = performance.now();
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 5000);
      try { const res = await fetch('/api/jobs', { signal: ctrl.signal, cache: 'no-store' }); await res.json(); return Math.round(performance.now() - t); } catch { return -1; }
    });
    let ms = await fetchMs(last);
    ok(ms >= 0, `settima scheda: lo strumento risponde (${ms} ms)`);
    await hide(last);
    await show(pages[0]);
    await sleep(500);
    ms = await fetchMs(pages[0]);
    ok(ms >= 0, `prima scheda tornata visibile: flusso riaperto e richieste regolari (${ms} ms)`);
    ok(!tabErrors.length, `nessun errore JavaScript${tabErrors.length ? ': ' + tabErrors.slice(0, 3).join(' | ') : ''}`);
    await tabs.close();

    // ----------------------------------------------------------------------------------------------
    section('Analisi senza chiave API: «Vai a Impostazioni» è l’azione principale');
    const nokey = await startServer('senza-chiave', { fixture: false });
    const id2 = await newJob(nokey);
    job = await waitFor(nokey, id2, (j) => j.status === 'errore' || j.status === 'revisione');
    ok(job.status === 'errore' && job.error?.code === 'missing_key', `analisi ferma per la chiave mancante («${job.error?.message}»)`);
    const keyErrors = [];
    const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await openPage(ctx3, `${nokey.base}/#/lavoro/${id2}`, keyErrors);
    await page.getByText('L’analisi non è riuscita').waitFor({ timeout: 15000 });
    const actions = page.locator('.notice .actions').first();
    const firstBtn = actions.locator('a, button').first();
    ok((await firstBtn.textContent()).includes('Vai a Impostazioni') && /btn-primary/.test(await firstBtn.getAttribute('class')), 'primo pulsante: «Vai a Impostazioni» (arancione)');
    const retryCls = await actions.getByRole('button', { name: 'Riprova' }).getAttribute('class');
    ok(!/btn-primary/.test(retryCls), '«Riprova» come pulsante secondario');
    await page.screenshot({ path: path.join(SHOTS, 'errore-chiave.png') });
    ok(!keyErrors.length, `nessun errore JavaScript${keyErrors.length ? ': ' + keyErrors.slice(0, 3).join(' | ') : ''}`);
    await ctx3.close();
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\nSchermate: ${SHOTS}`);
  console.log(`Durata: ${Math.round((Date.now() - t0) / 1000)} s`);
}

main().catch((err) => {
  failures++;
  console.error('\nERRORE:', err?.stack || err);
  for (const s of servers) console.error('--- uscita del server ---\n' + s.out().slice(-2000));
}).finally(() => {
  for (const s of servers) s.child.kill();
  console.log(`\n${passed} verifiche superate, ${failures} fallite.`);
  process.exit(failures ? 1 : 0);
});
