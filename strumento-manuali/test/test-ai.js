#!/usr/bin/env node
// Test dell'integrazione con Claude (src/ai) e delle impostazioni (src/settings.js).
//
//   node test/test-ai.js
//
// IMPORTANTE: sono test dell'IMPIANTO con un server Anthropic FINTO (test/mock-anthropic.js). Nessuna chiamata
// reale a Claude: le risposte sono preconfezionate (la scheda scritta a mano in test/fixtures), quindi questi test
// verificano forma delle richieste, streaming, gestione degli errori, riparazioni e file scritti — NON la qualità
// dell'estrazione. Per una prova vera con la chiave API: node test/try-real-api.js
//
// Cartella di lavoro: MANUALI_TEST_DIR oppure <tmp di sistema>/strumento-manuali-test/ai.
// Uscita con codice 1 se un test fallisce.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import * as z from 'zod';
import Anthropic from '@anthropic-ai/sdk';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'tavolo-levante');
const WORK = path.resolve(process.env.MANUALI_TEST_DIR || path.join(os.tmpdir(), 'strumento-manuali-test', 'ai'));
const REF_EXTRACTED = path.resolve(ROOT, '..', 'manuale-tavolo-levante', 'assets', 'estratte'); // facoltativa

// Ambiente isolato: impostazioni in una cartella di prova, nessuna chiave o URL reale, attese brevi.
const SAVED_ENV = {};
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'MANUALI_AI_FIXTURE', 'MANUALI_PLAN_FIXTURE', 'MANUALI_AI_NO_FALLBACK', 'MANUALI_CONFIG_DIR', 'MANUALI_AI_RETRY_DELAY_MS']) {
  SAVED_ENV[k] = process.env[k];
  delete process.env[k];
}
process.env.MANUALI_CONFIG_DIR = path.join(WORK, 'config');
process.env.MANUALI_AI_RETRY_DELAY_MS = '5';

const { getSettings, saveSettings, getApiKey, maskKey, DEFAULT_MODEL, DEFAULT_THEME, SettingsError, settingsPath } = await import('../src/settings.js');
const { callStructured, callStructuredDetailed, estimateCost, outputFormatFor, parseStructured, AiError, MESSAGES, FALLBACK_BETA, MAX_OUTPUT_TOKENS } = await import('../src/ai/client.js');
const { extractManual, buildExtractContent } = await import('../src/ai/extract.js');
const { planAnimation } = await import('../src/ai/animate.js');
const { repairManual } = await import('../src/ai/repair.js');
const { ManualData, AnimationPlan } = await import('../src/schema.js');
const { startMockAnthropic } = await import('./mock-anthropic.js');

const KEY = 'sk-ant-api03-PROVA-finta-0000000000000000000000000-abcd';
const GOLDEN = JSON.parse(await fs.readFile(path.join(FIX, 'manual.json'), 'utf8'));
const GOLDEN_PLAN = JSON.parse(await fs.readFile(path.join(FIX, 'plan.json'), 'utf8'));
const EXTRACT_PROMPT = (await fs.readFile(path.join(ROOT, 'src', 'ai', 'prompts', 'extract.md'), 'utf8')).trim();
const ANIMATE_PROMPT = (await fs.readFile(path.join(ROOT, 'src', 'ai', 'prompts', 'animate.md'), 'utf8')).trim();
const Small = z.object({ a: z.number().int(), b: z.string().nullable() });

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
    console.log(`  FAIL ${name}\n       ${String(err?.stack || err).split('\n').slice(0, 8).join('\n       ')}`);
  }
}
const readJson = async (f) => JSON.parse(await fs.readFile(f, 'utf8'));
async function freshDir(d) { await fs.rm(d, { recursive: true, force: true }); await fs.mkdir(d, { recursive: true }); return d; }

async function withMock(responses, fn, opts = {}) {
  const mock = await startMockAnthropic({ responses, ...opts });
  try { return await fn(mock); } finally { await mock.close(); }
}

async function expectAiError(promise, code, text) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, `doveva fallire con ${code}`);
  assert.ok(err instanceof AiError, `atteso AiError, arrivato ${err?.name}: ${err?.message}`);
  assert.equal(err.code, code, `codice atteso ${code}, arrivato ${err.code}: ${err.message}`);
  if (text) assert.ok(err.message.includes(text), `messaggio senza «${text}»: ${err.message}`);
  return err;
}

const small = (mock, extra = {}) => callStructured({ system: 'prova', content: [{ type: 'text', text: 'ciao' }], schema: Small, apiKey: KEY, baseURL: mock.url, retryDelayMs: 5, ...extra });
const authOf = (req) => req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

// ------------------------------------------------------------------ lavori di prova

const PAGES = [1, 3, 3, 3, 5, 5, 5, 5, 6, 6, 7, 9, 10, 11, 12];
const SIZES = [[1000, 672], [421, 467], [417, 557], [267, 197], [517, 552], [1257, 727], [1032, 587], [920, 546], [517, 552], [1226, 732], [1347, 747], [817, 712], [842, 712], [992, 641], [612, 482]];
const id2 = (i) => `img_${String(i).padStart(2, '0')}`;

/** Lavoro PDF finto ma realistico: PDF originale + 15 immagini (img_08 duplicato di img_04) come dall'ingest. */
async function makePdfJob(name) {
  const dir = await freshDir(path.join(WORK, 'lavori', name));
  await fs.mkdir(path.join(dir, 'estratte'), { recursive: true });
  await fs.mkdir(path.join(dir, 'input'), { recursive: true });
  const pdfPath = path.join(dir, 'input', 'TAVOLO_LEVANTE_originale.pdf');
  await fs.copyFile(path.join(FIX, 'TAVOLO_LEVANTE_originale.pdf'), pdfPath);
  const catalog = [];
  for (let i = 0; i < 15; i++) {
    const file = path.join(dir, 'estratte', `${id2(i)}.png`);
    const ref = path.join(REF_EXTRACTED, `img-${String(i).padStart(3, '0')}.png`);
    if (fss.existsSync(ref)) await fs.copyFile(ref, file);
    else await sharp({ create: { width: SIZES[i][0], height: SIZES[i][1], channels: 3, background: { r: 200, g: 120 + i * 5, b: 60 } } }).png().toFile(file);
    catalog.push({ id: id2(i), page: PAGES[i], index: i, width: SIZES[i][0], height: SIZES[i][1], file: `estratte/${id2(i)}.png`, bbox: null, duplicate_of: i === 8 ? 'img_04' : null });
  }
  await fs.writeFile(path.join(dir, 'estratte', 'catalog.json'), JSON.stringify(catalog, null, 2));
  const pages = Array.from({ length: 12 }, (_, i) => ({ page: i + 1, text: `pagina ${i + 1}` }));
  return { dir, ingest: { kind: 'pdf', catalog, pages, html: null, pdfPath, warnings: [] } };
}

/** Parti finte coerenti con il piano di riferimento (p01…p32) + un pavimento p33. */
function makeParts() {
  const P = (key, name, size, center, group) => ({
    key, name, size, center,
    bbox_min: center.map((c, i) => Math.round((c - size[i] / 2) * 10) / 10), bbox_max: center.map((c, i) => Math.round((c + size[i] / 2) * 10) / 10),
    triangles: 1200, similar_group: group,
  });
  const parts = [
    P('p01', 'Fianco', [40, 720, 700], [-880, 360, 0], 'g1'), P('p02', 'Fianco', [40, 720, 700], [880, 360, 0], 'g1'),
    P('p03', 'Traverso sup', [1720, 40, 40], [0, 700, 300], 'g2'), P('p04', 'Traverso sup', [1720, 40, 40], [0, 700, -300], 'g2'),
    P('p05', 'Traverso inf', [1720, 40, 40], [0, 120, 0], 'g3'), P('p06', 'Piano', [1800, 30, 800], [0, 735, 0], 'g4'),
  ];
  let k = 7;
  for (let i = 0; i < 10; i++) {
    parts.push(P(`p${String(k++).padStart(2, '0')}`, 'M8x20', [8, 8, 20], [i < 5 ? -870 : 870, 700, -200 + i * 40], 'g5'));
    parts.push(P(`p${String(k++).padStart(2, '0')}`, 'Rondella', [17, 17, 2], [i < 5 ? -860 : 860, 700, -200 + i * 40], 'g6'));
  }
  for (let i = 0; i < 6; i++) parts.push(P(`p${String(k++).padStart(2, '0')}`, 'Vite legno 4x20', [4, 20, 4], [-600 + i * 240, 715, 280], 'g7'));
  parts.push(P('p33', 'Pavimento', [3000, 2, 3000], [0, -1, 0], 'g8'));
  return parts;
}

// ------------------------------------------------------------------ test

async function main() {
  console.log('TEST DELL’IMPIANTO AI CON SERVER CLAUDE FINTO — nessuna chiamata reale: risposte preconfezionate, non risultati di Claude.');
  console.log(`Cartella di lavoro: ${WORK}\n`);
  await freshDir(WORK);

  console.log('Impostazioni');
  await test('impostazioni predefinite senza chiave', async () => {
    const s = await getSettings();
    assert.deepEqual(s, { hasApiKey: false, apiKeyHint: '', apiKeySource: null, model: DEFAULT_MODEL, theme: { ...DEFAULT_THEME } });
    assert.equal(DEFAULT_MODEL, 'claude-opus-5-5');
    assert.equal(await getApiKey(), null);
  });

  await test('salvataggio della chiave: pulita, mascherata, mai nella vista pubblica, file 0600', async () => {
    const s = await saveSettings({ apiKey: `  "${KEY}"\n` });
    assert.equal(s.hasApiKey, true);
    assert.equal(s.apiKeyHint, 'sk-ant-…abcd');
    assert.equal(s.apiKeySource, 'impostazioni');
    assert.ok(!JSON.stringify(s).includes(KEY.slice(10)), 'la chiave non deve uscire da getSettings');
    assert.ok(!JSON.stringify(await getSettings()).includes(KEY.slice(10)));
    assert.equal((await readJson(settingsPath())).apiKey, KEY);
    assert.equal(await getApiKey(), KEY);
    if (process.platform !== 'win32') assert.equal((await fs.stat(settingsPath())).mode & 0o777, 0o600);
  });

  await test('chiavi non valide rifiutate con messaggi italiani', async () => {
    for (const [bad, part] of [['ciao-sono-una-chiave-lunga-ma-sbagliata', 'sk-ant-'], ['sk-ant-api03 con spazi dentro 00000000', 'spazi'], ['sk-ant-1234', 'troppo corta'], ['sk-ant-àèìòù-0000000000000000000', 'caratteri']]) {
      await assert.rejects(saveSettings({ apiKey: bad }), (e) => e instanceof SettingsError && e.message.includes(part), bad);
    }
    assert.equal(await getApiKey(), KEY, 'una chiave sbagliata non deve cancellare quella buona');
  });

  await test('modello e tema: validazione e unione', async () => {
    assert.equal((await saveSettings({ model: 'claude-opus-5' })).model, 'claude-opus-5');
    assert.equal((await saveSettings({ model: '' })).model, DEFAULT_MODEL);
    await assert.rejects(saveSettings({ model: 'rm -rf /' }), SettingsError);
    const t = (await saveSettings({ theme: { accent: '#0a0', inutile: '#fff' } })).theme;
    assert.equal(t.accent, '#00AA00');
    assert.equal(t.beige, DEFAULT_THEME.beige);
    assert.equal((await saveSettings({ theme: { ink: '#111111' } })).theme.accent, '#00AA00', 'i colori salvati prima restano');
    await assert.rejects(saveSettings({ theme: { accent: 'rosso' } }), (e) => e instanceof SettingsError && e.message.includes('accent'));
    assert.deepEqual((await saveSettings({ theme: null })).theme, { ...DEFAULT_THEME });
    const [a, b] = await Promise.all([saveSettings({ model: 'claude-opus-4-8' }), saveSettings({ theme: { muted: '#777777' } })]);
    assert.ok(a && b);
    const s = await getSettings();
    assert.equal(s.model, 'claude-opus-4-8');
    assert.equal(s.theme.muted, '#777777', 'due salvataggi contemporanei non si sovrascrivono');
    await saveSettings({ model: null, theme: null });
  });

  await test('chiave dalla variabile d’ambiente ANTHROPIC_API_KEY; cancellazione', async () => {
    await saveSettings({ apiKey: null });
    assert.equal((await getSettings()).hasApiKey, false);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-ambiente-0000000000000000000-wxyz';
    try {
      const s = await getSettings();
      assert.equal(s.apiKeySource, 'ambiente');
      assert.equal(s.apiKeyHint, 'sk-ant-…wxyz');
      assert.equal(await getApiKey(), process.env.ANTHROPIC_API_KEY);
      await saveSettings({ apiKey: KEY });
      assert.equal(await getApiKey(), KEY, 'la chiave delle impostazioni vince su quella d’ambiente');
    } finally { delete process.env.ANTHROPIC_API_KEY; }
  });

  await test('settings.json rovinato: messo da parte, valori predefiniti', async () => {
    await fs.writeFile(settingsPath(), '{ questo non è json');
    const warn = console.warn; console.warn = () => {};
    try { assert.equal((await getSettings()).model, DEFAULT_MODEL); } finally { console.warn = warn; }
    const aside = (await fs.readdir(path.dirname(settingsPath()))).filter((f) => f.includes('rovinato'));
    assert.equal(aside.length, 1);
    assert.equal(maskKey(''), '');
    assert.equal(maskKey(KEY), 'sk-ant-…abcd');
    assert.equal(maskKey('corta'), '…ta');
  });

  console.log('\nCosti e schema');
  await test('estimateCost: prezzi claude-opus-5-5 ($4/$20, cache $0,20) e iterazioni di fallback', async () => {
    const c = estimateCost({ input_tokens: 1e6, output_tokens: 1e6 });
    assert.equal(c.usd, 24);
    assert.ok(c.text.startsWith('24,00 $'), c.text);
    assert.equal(estimateCost({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1e6 }).usd, 0.2);
    assert.equal(estimateCost({ input_tokens: 1e6, output_tokens: 0 }, 'claude-opus-5-5-20261101').usd, 4);
    assert.equal(estimateCost({ input_tokens: 1e6, output_tokens: 0 }, 'claude-opus-5').usd, 5);
    const fb = estimateCost({ input_tokens: 1e6, output_tokens: 1e6, iterations: [
      { type: 'message', model: 'claude-opus-5-5', input_tokens: 1e6, output_tokens: 0 },
      { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1e6, output_tokens: 1e6 },
    ] });
    assert.equal(fb.usd, 4 + 5 + 25);
    assert.equal(estimateCost({ input_tokens: 10, output_tokens: 10 }, 'modello-sconosciuto').approx, true);
  });

  await test('formato di output: JSON Schema chiuso, senza vincoli numerici rumorosi', async () => {
    const f = outputFormatFor(ManualData);
    assert.equal(f.type, 'json_schema');
    assert.equal(typeof f.parse, 'undefined', 'niente parse automatico dell’SDK');
    const txt = JSON.stringify(f.schema);
    assert.ok(!txt.includes('9007199254740991'));
    assert.deepEqual(Object.keys(f.schema.properties).sort(), Object.keys(ManualData.shape).sort());
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      if (n.type === 'object') assert.equal(n.additionalProperties, false, 'ogni oggetto chiuso');
      Object.values(n).forEach(walk);
    };
    walk(f.schema);
    assert.ok(JSON.stringify(outputFormatFor(AnimationPlan).schema).includes('caption_title'));
  });

  await test('numeri all’italiana: 3.200 token, 0,42 $', async () => {
    const { formatInt } = await import('../src/ai/log.js');
    assert.equal(formatInt(3200), '3.200');
    assert.equal(formatInt(64000), '64.000');
    assert.equal(estimateCost({ input_tokens: 105000, output_tokens: 0 }).text, '0,42 $ — 105.000 token in ingresso, 0 in uscita');
  });

  await test('parseStructured: testo diviso da un blocco di fallback', async () => {
    const S = z.object({ a: z.number() });
    assert.deepEqual(parseStructured({ content: [{ type: 'text', text: '{"a":' }, { type: 'fallback' }, { type: 'text', text: '{"a":2}' }] }, S).data, { a: 2 });
    assert.deepEqual(parseStructured({ content: [{ type: 'text', text: '{"a":' }, { type: 'fallback' }, { type: 'text', text: '3}' }] }, S).data, { a: 3 });
    assert.equal(parseStructured({ content: [{ type: 'thinking', thinking: '' }] }, S).ok, false);
    assert.equal(parseStructured({ content: [{ type: 'text', text: '{"a":"x"}' }] }, S).ok, false);
  });

  console.log('\nServer finto');
  await test('il server finto risponde anche senza streaming (SDK messages.create)', async () => {
    await withMock([{ kind: 'json', data: { a: 1, b: null } }, { kind: 'error', status: 401, message: 'invalid x-api-key' }], async (mock) => {
      const client = new Anthropic({ apiKey: KEY, baseURL: mock.url, maxRetries: 0 });
      const msg = await client.messages.create({ model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'ciao' }] });
      assert.equal(msg.stop_reason, 'end_turn');
      assert.deepEqual(JSON.parse(msg.content.find((b) => b.type === 'text').text), { a: 1, b: null });
      await assert.rejects(client.messages.create({ model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'ciao' }] }), Anthropic.AuthenticationError);
      assert.equal(mock.requests[0].body.stream, undefined);
    });
  });

  console.log('\nEstrazione della scheda (PDF)');
  await test('extractManual PDF: forma della richiesta, streaming, scheda validata e file scritti', async () => {
    const { dir, ingest } = await makePdfJob('pdf-ok');
    await saveSettings({ apiKey: KEY });
    const events = [];
    const manual = await withMock([{ kind: 'json', data: GOLDEN, chunkChars: 200, thinkingText: '' }], async (mock) => {
      const m = await extractManual(dir, ingest, (pct, msg) => events.push([pct, msg]), { baseURL: mock.url });
      assert.equal(mock.requests.length, 1, 'una sola richiesta');
      const req = mock.requests[0];
      assert.equal(req.path, '/v1/messages');
      assert.equal(authOf(req), KEY, 'chiave dalle impostazioni');
      assert.ok(String(req.headers['anthropic-beta']).split(',').includes(FALLBACK_BETA), 'header beta del fallback');
      const b = req.body;
      assert.equal(b.model, 'claude-opus-5-5');
      assert.equal(b.max_tokens, 64000);
      assert.equal(b.stream, true);
      assert.equal(b.fallbacks, 'default');
      assert.equal(b.output_config.effort, 'high');
      assert.equal(b.output_config.format.type, 'json_schema');
      assert.ok(b.output_config.format.schema.properties.steps);
      for (const forbidden of ['thinking', 'temperature', 'top_p', 'top_k', 'betas', 'tools', 'tool_choice']) assert.ok(!(forbidden in b), `campo ${forbidden} non atteso`);
      assert.equal(b.system, EXTRACT_PROMPT);
      assert.equal(b.messages.length, 1);
      assert.equal(b.messages[0].role, 'user');
      const c = b.messages[0].content;
      assert.equal(c[0].type, 'document', 'il PDF è il primo blocco');
      assert.equal(c[0].source.type, 'base64');
      assert.equal(c[0].source.media_type, 'application/pdf');
      assert.ok(Buffer.from(c[0].source.data, 'base64').equals(await fs.readFile(ingest.pdfPath)), 'PDF intero e identico');
      assert.equal(c[1].type, 'text');
      assert.ok(c[1].text.includes('12 pagine'));
      // catalogo: etichetta + immagine per le 14 non duplicate; il duplicato solo come testo
      const imgs = c.filter((x) => x.type === 'image');
      assert.equal(imgs.length, 14);
      for (let i = 0; i < 15; i++) {
        const at = c.findIndex((x) => x.type === 'text' && x.text.startsWith(`${id2(i)} — `));
        assert.ok(at > 0, `etichetta di ${id2(i)}`);
        if (i === 8) {
          assert.ok(c[at].text.includes('identica a img_04'));
          assert.notEqual(c[at + 1].type, 'image', 'il duplicato non è allegato');
          continue;
        }
        assert.equal(c[at].text, `${id2(i)} — pagina ${PAGES[i]} — ${SIZES[i][0]}×${SIZES[i][1]} px`);
        assert.equal(c[at + 1].type, 'image');
        assert.equal(c[at + 1].source.media_type, 'image/jpeg');
        const meta = await sharp(Buffer.from(c[at + 1].source.data, 'base64')).metadata();
        assert.equal(meta.format, 'jpeg');
        assert.ok(Math.max(meta.width, meta.height) <= 512, `${id2(i)} ridotta (${meta.width}×${meta.height})`);
      }
      const last = c.at(-1);
      assert.equal(last.type, 'text');
      assert.ok(last.text.includes(`Id immagine validi (15): ${Array.from({ length: 15 }, (_, i) => id2(i)).join(', ')}`));
      return m;
    });
    const { manual: expected } = repairManual(ManualData.parse(GOLDEN), ingest.catalog);
    assert.deepEqual(manual, expected);
    assert.deepEqual(await readJson(path.join(dir, 'manual.ai.json')), ManualData.parse(GOLDEN), 'manual.ai.json = risposta non modificata');
    assert.deepEqual(await readJson(path.join(dir, 'manual.json')), expected);
    const log = await fs.readFile(path.join(dir, 'log.txt'), 'utf8');
    assert.match(log, /Claude \(estrazione scheda\): risposta — stop end_turn, modello claude-opus-5-5/);
    assert.match(log, /costo stimato \d+,\d+ \$/);
    assert.match(log, /riparazione: immagine img_04 indicata come non usata/);
    const usage = await readJson(path.join(dir, 'ai-usage.json'));
    assert.equal(usage.length, 1);
    assert.equal(usage[0].cost_usd, estimateCost({ input_tokens: usage[0].input_tokens, output_tokens: usage[0].output_tokens }).usd);
    // avanzamento: percentuali non decrescenti, messaggi italiani, fine a 100
    const pcts = events.map((e) => e[0]);
    assert.ok(pcts.every((p, i) => typeof p === 'number' && (i === 0 || p >= pcts[i - 1])), `percentuali: ${pcts.join(',')}`);
    assert.equal(pcts.at(-1), 100);
    const msgs = events.map((e) => e[1]).join('\n');
    assert.match(msgs, /Claude sta ragionando…/);
    assert.match(msgs, /Claude sta scrivendo… circa [\d.]+ token/);
    assert.match(events.at(-1)[1], /^Scheda pronta: 7 passi/);
  });

  await test('extractManual DOCX: HTML con segnaposto, miniature preferite, riparazione dei riferimenti', async () => {
    const dir = await freshDir(path.join(WORK, 'lavori', 'docx-ok'));
    await fs.mkdir(path.join(dir, 'estratte'), { recursive: true });
    await fs.mkdir(path.join(dir, 'immagini', 'thumb'), { recursive: true });
    const catalog = [];
    for (let i = 0; i < 4; i++) {
      await sharp({ create: { width: 800, height: 500, channels: 3, background: { r: 30 * i, g: 90, b: 160 } } }).png().toFile(path.join(dir, 'estratte', `${id2(i)}.png`));
      catalog.push({ id: id2(i), page: null, index: i, width: 800, height: 500, file: `estratte/${id2(i)}.png`, bbox: null, duplicate_of: null });
    }
    const thumb = await sharp({ create: { width: 360, height: 225, channels: 3, background: '#ff7e00' } }).jpeg().toBuffer();
    await fs.writeFile(path.join(dir, 'immagini', 'thumb', 'img_00.jpg'), thumb);
    const html = '<h1>ISTRUZIONI DI MONTAGGIO</h1><p>[[img_00]]</p><p>FISSARE I PIEDI (A) <strong><u>SENZA SERRARE</u></strong>.</p><p>[[img_01]]</p><p>[[img_02]]</p><p>[[img_03]]</p>';
    const ingest = { kind: 'docx', catalog, pages: [], html, pdfPath: null, warnings: [], inputName: 'esempio.docx' };
    // risposta con riferimenti rotti: immagine inesistente, sigla inesistente, passi numerati male, fase su passo inesistente
    const broken = structuredClone(GOLDEN);
    broken.cover_image_id = 'img_00';
    broken.brand_logo_image_id = 'img_14';
    broken.steps = broken.steps.slice(0, 3).map((s, i) => ({ ...s, number: (i + 1) * 10, image_ids: [id2(i + 1), 'img_99'] }));
    broken.steps[1].uses.push({ ref: 't1', qty: 1 }, { ref: 'Z9', qty: 3 });
    broken.phases = [{ title: 'Tutto', step_numbers: [10, 20, 30, 70] }];
    broken.hardware.forEach((h) => { h.image_id = null; });
    broken.components.forEach((c) => { c.image_id = null; });
    broken.notes = [];
    broken.unused_image_ids = ['img_08'];
    const manual = await withMock([{ kind: 'json', data: broken }], async (mock) => {
      const m = await extractManual(dir, ingest, null, { baseURL: mock.url });
      const c = mock.requests[0].body.messages[0].content;
      assert.ok(!c.some((x) => x.type === 'document'), 'nessun blocco PDF per il DOCX');
      assert.equal(c[0].type, 'text');
      assert.ok(c[0].text.includes('<documento>') && c[0].text.includes('[[img_00]]') && c[0].text.includes('<strong><u>SENZA SERRARE</u></strong>'));
      assert.ok(c[0].text.includes('«esempio.docx»'));
      const at = c.findIndex((x) => x.type === 'text' && x.text.startsWith('img_00 — '));
      assert.equal(c[at].text, 'img_00 — 800×500 px — segnaposto [[img_00]] nel testo');
      assert.ok(Buffer.from(c[at + 1].source.data, 'base64').equals(thumb), 'usa immagini/thumb/img_00.jpg');
      assert.equal(c.filter((x) => x.type === 'image').length, 4);
      return m;
    });
    assert.deepEqual(manual.steps.map((s) => s.number), [1, 2, 3]);
    assert.deepEqual(manual.steps.map((s) => s.image_ids), [['img_01'], ['img_02'], ['img_03']]);
    assert.equal(manual.brand_logo_image_id, null, 'img_14 non esiste nel catalogo DOCX');
    assert.deepEqual(manual.phases, [{ title: 'Tutto', step_numbers: [1, 2, 3] }]);
    assert.deepEqual(manual.steps[1].uses.map((u) => u.ref), ['T1'], 'riferimento «t1» corretto, «Z9» tolto');
    assert.ok(manual.changes.some((ch) => ch.kind === 'incongruenza' && ch.description.includes('«Z9»') && ch.needs_confirmation));
    assert.deepEqual(manual.unused_image_ids, [], 'img_08 non esiste; tutte le altre sono usate');
    const raw = await readJson(path.join(dir, 'manual.ai.json'));
    assert.equal(raw.steps[0].number, 10, 'manual.ai.json resta com’era');
    const log = await fs.readFile(path.join(dir, 'log.txt'), 'utf8');
    assert.match(log, /riparazione: passo 1: immagine «img_99» inesistente/);
    assert.match(log, /riparazione: passi rinumerati/);
  });

  await test('rianalisi: il manual.json precedente viene conservato in manual.precedente.json', async () => {
    const { dir, ingest } = await makePdfJob('pdf-rianalisi');
    const edited = { ...GOLDEN, short_name: 'Modificato dall’utente' };
    await fs.writeFile(path.join(dir, 'manual.json'), JSON.stringify(edited));
    await withMock([{ kind: 'json', data: GOLDEN }], (mock) => extractManual(dir, null, null, { baseURL: mock.url }));
    assert.equal((await readJson(path.join(dir, 'manual.precedente.json'))).short_name, 'Modificato dall’utente');
    assert.equal((await readJson(path.join(dir, 'manual.json'))).short_name, 'Tavolo Levante');
    assert.ok(ingest);
  });

  console.log('\nErrori e nuovi tentativi');
  await test('chiave mancante: messaggio esatto, nessuna richiesta', async () => {
    await saveSettings({ apiKey: null });
    await withMock([{ kind: 'json', data: { a: 1, b: null } }], async (mock) => {
      const e = await expectAiError(callStructured({ system: 's', content: 'x', schema: Small, baseURL: mock.url }), 'missing_key');
      assert.equal(e.message, 'Manca la chiave API di Claude: inseriscila in Impostazioni.');
      const { dir, ingest } = await makePdfJob('senza-chiave');
      await expectAiError(extractManual(dir, ingest, null, { baseURL: mock.url }), 'missing_key');
      assert.equal(mock.requests.length, 0);
    });
    await saveSettings({ apiKey: KEY });
  });

  const cases = [
    ['401 chiave non valida', [{ kind: 'error', status: 401, message: 'invalid x-api-key' }], 'invalid_key', MESSAGES.invalid_key, 1],
    ['403 permesso negato', [{ kind: 'error', status: 403 }], 'permission', 'errore 403', 1],
    ['400 credito esaurito', [{ kind: 'error', status: 400, message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' }], 'billing', 'Credito esaurito', 1],
    ['402 billing_error', [{ kind: 'error', status: 402 }], 'billing', 'Plans & Billing', 1],
    ['429 limite di spesa (non si ripete)', [{ kind: 'error', status: 429, errorCode: 'enforced_spend_limit_reached' }], 'spend_limit', 'limite di spesa', 1],
    ['429 tre volte → limite di velocità', [{ kind: 'error', status: 429 }, { kind: 'error', status: 429 }, { kind: 'error', status: 429 }], 'rate_limit', MESSAGES.rate_limit, 3],
    ['529 tre volte → sovraccarico', [{ kind: 'error', status: 529 }, { kind: 'error', status: 529 }, { kind: 'error', status: 529 }], 'overloaded', MESSAGES.overloaded, 3],
    ['500 tre volte → errore del server', [{ kind: 'error', status: 500 }, { kind: 'error', status: 500 }, { kind: 'error', status: 500 }], 'server', 'errore 500', 3],
    ['404 modello inesistente', [{ kind: 'error', status: 404, message: 'model: claude-inesistente' }], 'model_not_found', '«claude-opus-5-5»', 1],
    ['413 richiesta troppo grande', [{ kind: 'error', status: 413 }], 'too_large', '32 MB', 1],
    ['400 prompt troppo lungo', [{ kind: 'error', status: 400, message: 'prompt is too long: 1200000 tokens > 1000000 maximum' }], 'too_large', 'troppo grande', 1],
    ['400 generico', [{ kind: 'error', status: 400, message: 'messages.0.content.3: strano' }], 'bad_request', 'messages.0.content.3: strano', 1],
    ['rifiuto prima dell’output', [{ kind: 'refusal', category: 'cyber' }], 'refusal', 'sicurezza informatica', 1],
    ['rifiuto a metà risposta (JSON parziale)', [{ kind: 'refusal', category: null, partial: '{"a": 1, "b": "ciao' }], 'refusal', 'motivo non specificato', 1],
    ['max_tokens due volte → troncata', [{ kind: 'truncated', data: { a: 1, b: 'x'.repeat(200) } }, { kind: 'truncated', data: { a: 1, b: 'x'.repeat(200) } }], 'truncated', 'limite di lunghezza', 2],
    ['JSON non valido due volte', [{ kind: 'text', text: 'non è json' }, { kind: 'text', text: '{"a": "uno"}' }], 'invalid_output', MESSAGES.invalid_output, 2],
    ['stream interrotto da event: error tre volte', [{ kind: 'sse_error' }, { kind: 'sse_error' }, { kind: 'sse_error' }], 'overloaded', MESSAGES.overloaded, 3],
    ['400 sull’header beta anche senza beta', [{ kind: 'error', status: 400, message: 'Unexpected value(s) for the `anthropic-beta` header.' }, { kind: 'error', status: 400, message: 'Unexpected value(s) for the `anthropic-beta` header.' }], 'bad_request', 'anthropic-beta', 2],
  ];
  for (const [name, responses, code, text, nReq] of cases) {
    await test(`errore: ${name}`, async () => {
      await withMock(responses, async (mock) => {
        await expectAiError(small(mock), code, text);
        assert.equal(mock.requests.length, nReq, `richieste: ${mock.requests.length}`);
      });
    });
  }

  await test('429 poi successo: nuovo tentativo con retry-after, messaggio di avanzamento e registro', async () => {
    const dir = await freshDir(path.join(WORK, 'lavori', 'retry'));
    const msgs = [];
    await withMock([{ kind: 'error', status: 429, headers: { 'retry-after': '0.05' } }, { kind: 'json', data: { a: 7, b: null } }], async (mock) => {
      const t0 = Date.now();
      const r = await callStructuredDetailed({ system: 's', content: 'x', schema: Small, apiKey: KEY, baseURL: mock.url, retryDelayMs: 5, jobDir: dir, onProgress: (p, m) => msgs.push(m) });
      assert.ok(Date.now() - t0 >= 45, 'rispetta retry-after');
      assert.deepEqual(r.data, { a: 7, b: null });
      assert.equal(r.attempts, 2);
      assert.equal(mock.requests.length, 2);
    });
    assert.ok(msgs.some((m) => /Troppe richieste a Claude.*nuovo tentativo tra/.test(m)), msgs.join(' | '));
    assert.match(await fs.readFile(path.join(dir, 'log.txt'), 'utf8'), /rate_limit 429 — nuovo tentativo 1 di 2/);
  });

  await test('529 / 500 / event: error / connessione caduta, poi successo', async () => {
    for (const first of [{ kind: 'error', status: 529 }, { kind: 'error', status: 500 }, { kind: 'sse_error', afterChunks: 1, chunkChars: 4 }, { kind: 'drop', afterChunks: 1, chunkChars: 4 }]) {
      await withMock([first, { kind: 'json', data: { a: 2, b: 'ok' } }], async (mock) => {
        assert.deepEqual(await small(mock), { a: 2, b: 'ok' }, first.kind + ' ' + (first.status || ''));
        assert.equal(mock.requests.length, 2);
      });
    }
  });

  await test('rete irraggiungibile: messaggio sulla connessione dopo i nuovi tentativi', async () => {
    const srv = http.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    await new Promise((r) => srv.close(r));
    const e = await expectAiError(callStructured({ system: 's', content: 'x', schema: Small, apiKey: KEY, baseURL: `http://127.0.0.1:${port}`, retryDelayMs: 5 }), 'network');
    assert.equal(e.message, MESSAGES.network);
  });

  await test('max_tokens poi successo: secondo tentativo con il limite massimo', async () => {
    await withMock([{ kind: 'truncated', data: { a: 1, b: 'x'.repeat(100) } }, { kind: 'json', data: { a: 1, b: 'completo' } }], async (mock) => {
      assert.deepEqual(await small(mock), { a: 1, b: 'completo' });
      assert.deepEqual(mock.requests.map((r) => r.body.max_tokens), [64000, MAX_OUTPUT_TOKENS]);
    });
  });

  await test('JSON non valido poi valido: un nuovo tentativo', async () => {
    await withMock([{ kind: 'text', text: '{"a": 1, "b": ' }, { kind: 'json', data: { a: 4, b: null } }], async (mock) => {
      assert.deepEqual(await small(mock), { a: 4, b: null });
      assert.equal(mock.requests.length, 2);
    });
  });

  await test('beta del fallback non disponibile: si ripete senza header e senza fallbacks', async () => {
    const dir = await freshDir(path.join(WORK, 'lavori', 'senza-beta'));
    await withMock([{ kind: 'error', status: 400, message: 'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.' }, { kind: 'json', data: { a: 5, b: null } }], async (mock) => {
      assert.deepEqual(await small(mock, { jobDir: dir }), { a: 5, b: null });
      const [r1, r2] = mock.requests;
      assert.ok(String(r1.headers['anthropic-beta']).includes(FALLBACK_BETA));
      assert.equal(r1.body.fallbacks, 'default');
      assert.ok(!String(r2.headers['anthropic-beta'] || '').includes('server-side-fallback'));
      assert.ok(!('fallbacks' in r2.body));
    });
    assert.match(await fs.readFile(path.join(dir, 'log.txt'), 'utf8'), /non accetta il fallback lato server/);
  });

  await test('fallback lato server: risposta del modello di riserva accettata, costo delle due iterazioni', async () => {
    const dir = await freshDir(path.join(WORK, 'lavori', 'fallback'));
    const msgs = [];
    await withMock([{ kind: 'fallback', data: { a: 9, b: 'riserva' }, to: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 100 } }], async (mock) => {
      const r = await callStructuredDetailed({ system: 's', content: 'x', schema: Small, apiKey: KEY, baseURL: mock.url, jobDir: dir, onProgress: (p, m) => msgs.push(m) });
      assert.deepEqual(r.data, { a: 9, b: 'riserva' });
      assert.equal(r.fallbackUsed, true);
      assert.equal(r.model, 'claude-opus-4-8');
      assert.equal(r.costUsd, estimateCost({ iterations: [{ model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 0 }, { model: 'claude-opus-4-8', input_tokens: 1000, output_tokens: 100 }] }).usd);
    });
    assert.ok(msgs.some((m) => m.includes('modello di riserva')), msgs.join(' | '));
    assert.match(await fs.readFile(path.join(dir, 'log.txt'), 'utf8'), /ha declinato la richiesta: continua claude-opus-4-8/);
  });

  await test('annullamento e tempo massimo', async () => {
    await withMock([{ kind: 'json', data: { a: 1, b: null }, delayMs: 3000 }], async (mock) => {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 100);
      await expectAiError(small(mock, { signal: ctrl.signal }), 'aborted', 'annullata');
    });
    await withMock([{ kind: 'json', data: { a: 1, b: null }, delayMs: 3000 }], async (mock) => {
      await expectAiError(small(mock, { totalTimeoutMs: 150 }), 'timeout', 'non ha risposto in tempo');
    });
  });

  await test('ANTHROPIC_BASE_URL e chiave dalle impostazioni (nessuna opzione esplicita)', async () => {
    await withMock([{ kind: 'json', data: { a: 3, b: null } }], async (mock) => {
      process.env.ANTHROPIC_BASE_URL = mock.url;
      try {
        assert.deepEqual(await callStructured({ system: 's', content: 'x', schema: Small }), { a: 3, b: null });
      } finally { delete process.env.ANTHROPIC_BASE_URL; }
      assert.equal(authOf(mock.requests[0]), KEY);
      assert.equal(mock.requests[0].body.model, DEFAULT_MODEL);
    });
  });

  console.log('\nModalità test (fixture)');
  await test('MANUALI_AI_FIXTURE: nessuna chiamata, scheda validata, MODALITÀ TEST nel registro', async () => {
    const { dir, ingest } = await makePdfJob('fixture');
    await saveSettings({ apiKey: null });
    process.env.MANUALI_AI_FIXTURE = path.join(FIX, 'manual.json');
    try {
      await withMock([], async (mock) => {
        const msgs = [];
        const m = await extractManual(dir, ingest, (p, msg) => msgs.push(msg), { baseURL: mock.url });
        assert.equal(mock.requests.length, 0);
        assert.equal(m.short_name, 'Tavolo Levante');
        assert.equal(m.steps.length, 7);
        assert.ok(msgs.every((x) => x.startsWith('MODALITÀ TEST')));
      });
      assert.match(await fs.readFile(path.join(dir, 'log.txt'), 'utf8'), /MODALITÀ TEST: scheda letta da .*manual\.json — nessuna chiamata a Claude/);
      const bad = path.join(WORK, 'scheda-rotta.json');
      await fs.writeFile(bad, JSON.stringify({ version: 2 }));
      process.env.MANUALI_AI_FIXTURE = bad;
      await expectAiError(extractManual(dir, ingest), 'fixture_invalid', 'MODALITÀ TEST');
    } finally {
      delete process.env.MANUALI_AI_FIXTURE;
      await saveSettings({ apiKey: KEY });
    }
  });

  console.log('\nPiano dell’animazione');
  await test('planAnimation: richiesta (scheda, parti, viste etichettate), riparazione del piano, file scritti', async () => {
    const dir = await freshDir(path.join(WORK, 'lavori', 'piano'));
    const parts = makeParts();
    await fs.writeFile(path.join(dir, 'parts.json'), JSON.stringify(parts));
    await fs.writeFile(path.join(dir, 'model.meta.json'), JSON.stringify({ up_axis_in_source: 'y', up_axis_reason: 'Y già verticale', size_text: '1.800 × 800 × 750 mm (larghezza × profondità × altezza)' }));
    await fs.mkdir(path.join(dir, 'viste_parti'), { recursive: true });
    await sharp({ create: { width: 640, height: 480, channels: 3, background: '#eeeeee' } }).png().toFile(path.join(dir, 'viste_parti', 'insieme.png'));
    await sharp({ create: { width: 640, height: 480, channels: 3, background: '#ff7e00' } }).png().toFile(path.join(dir, 'viste_parti', 'g5.png'));
    const views = [
      { key: 'insieme', label: 'Vista d’insieme', file: 'viste_parti/insieme.png', keys: [] },
      { key: 'g5', label: 'Gruppo g5 (10 pezzi)', file: 'viste_parti/g5.png', keys: ['p07', 'p09'] },
    ];
    const broken = structuredClone(GOLDEN_PLAN);
    broken.up_axis_in_source = 'z';
    broken.parts.push({ key: 'p99', role: 'component', ref: 'F1' });
    broken.parts[0].ref = 'X1';
    broken.steps[0].actions[0].direction = [0, 0, -2];
    broken.steps[1].actions[0].keys.push('p98');
    broken.steps[3].actions.unshift({ type: 'insert', keys: ['p03'], direction: null, distance_factor: -1, loose: null, axis: null, angle_deg: null });
    broken.steps[5].actions[0].axis = null;
    const manual = ManualData.parse(GOLDEN);
    const plan = await withMock([{ kind: 'json', data: broken }], async (mock) => {
      const p = await planAnimation(dir, manual, parts, null, { views, baseURL: mock.url });
      const b = mock.requests[0].body;
      assert.equal(b.system, ANIMATE_PROMPT);
      assert.equal(b.output_config.effort, 'high');
      assert.ok(JSON.stringify(b.output_config.format.schema).includes('caption_title'));
      const c = b.messages[0].content;
      assert.ok(c[0].text.startsWith('Scheda del manuale (ManualData):'));
      const sent = JSON.parse(c[0].text.slice(c[0].text.indexOf('{')));
      assert.equal(sent.steps.length, 7);
      assert.equal(sent.steps[2].uses[0].ref, 'H1');
      assert.ok(!('image_ids' in sent.steps[0]) && !('changes' in sent), 'solo ciò che serve al piano');
      assert.ok(c[1].text.includes('Usa up_axis_in_source = "y"'));
      assert.match(c[1].text, /gruppo g5: 10 pezzi, misure \[8, 8, 20\], minuteria/);
      assert.match(c[1].text, /gruppo g2: 2 pezzi, misure \[1720, 40, 40\], asta lungo X/);
      assert.ok(c[1].text.includes('{"key":"p01","name":"Fianco"'));
      const imgs = c.filter((x) => x.type === 'image');
      assert.equal(imgs.length, 2);
      assert.equal(imgs[0].source.media_type, 'image/png');
      const lab = c.findIndex((x) => x.type === 'text' && x.text.startsWith('Vista «Gruppo g5'));
      assert.ok(c[lab].text.includes('parti evidenziate: p07 p09') && c[lab + 1].type === 'image');
      assert.ok(c.at(-1).text.includes('Chiavi valide (33)'));
      assert.ok(c.at(-1).text.includes('Sigle valide: F1, T1, T2, P1, H1, H2, H3'));
      return p;
    });
    assert.ok(!plan.parts.some((r) => r.key === 'p99'));
    assert.equal(plan.parts[0].ref, null, 'sigla X1 inesistente tolta');
    assert.equal(plan.up_axis_in_source, 'y', 'asse dal caricatore del modello');
    assert.deepEqual(plan.steps[0].actions[0].direction, [0, 0, -1], 'direzione normalizzata');
    assert.ok(!plan.steps[1].actions[0].keys.includes('p98'));
    assert.equal(plan.steps[3].actions.find((a) => a.type === 'insert' && a.keys.includes('p03')), undefined, 'p03 non si inserisce due volte');
    assert.equal(plan.steps[5].actions[0].axis, 'x');
    assert.deepEqual(await readJson(path.join(dir, 'plan.json')), plan);
    assert.ok((await readJson(path.join(dir, 'plan.ai.json'))).parts.some((r) => r.key === 'p99'), 'plan.ai.json non modificato');
    const log = await fs.readFile(path.join(dir, 'log.txt'), 'utf8');
    assert.match(log, /piano — riparazione: ruolo per la parte «p99» inesistente/);
    assert.match(log, /piano — avviso: 1 parti senza ruolo/);
  });

  await test('MANUALI_PLAN_FIXTURE: nessuna chiamata, piano di riferimento validato', async () => {
    const dir = await freshDir(path.join(WORK, 'lavori', 'piano-fixture'));
    process.env.MANUALI_PLAN_FIXTURE = path.join(FIX, 'plan.json');
    try {
      await withMock([], async (mock) => {
        const plan = await planAnimation(dir, ManualData.parse(GOLDEN), makeParts(), null, { baseURL: mock.url });
        assert.equal(mock.requests.length, 0);
        assert.deepEqual(plan.steps, AnimationPlan.parse(GOLDEN_PLAN).steps);
      });
      assert.match(await fs.readFile(path.join(dir, 'log.txt'), 'utf8'), /MODALITÀ TEST: piano dell’animazione letto da/);
    } finally { delete process.env.MANUALI_PLAN_FIXTURE; }
  });

  console.log('\nIntegrazione con l’ingest reale (facoltativa)');
  await test('ingest vero del PDF di riferimento → contenuto per Claude (14 immagini allegate + 1 duplicata)', async () => {
    let ingestMod;
    try { ingestMod = await import('../src/ingest/index.js'); } catch (err) {
      console.log(`       (saltato: src/ingest non disponibile — ${err.message})`);
      return;
    }
    const dir = await freshDir(path.join(WORK, 'lavori', 'ingest-vero'));
    await fs.mkdir(path.join(dir, 'input'), { recursive: true });
    const pdf = path.join(dir, 'input', 'TAVOLO_LEVANTE_originale.pdf');
    await fs.copyFile(path.join(FIX, 'TAVOLO_LEVANTE_originale.pdf'), pdf);
    const ingest = await ingestMod.ingestDocument(dir, pdf);
    await ingestMod.prepareImages(dir, ingest.catalog);
    const { content, stats } = await buildExtractContent(dir, ingest);
    assert.equal(ingest.catalog.length, 15);
    assert.equal(stats.attached, 14);
    assert.equal(stats.duplicates, 1);
    assert.equal(content[0].type, 'document');
    const lab5 = content.find((x) => x.type === 'text' && x.text.startsWith('img_05 — '));
    assert.match(lab5.text, /^img_05 — pagina 5 — 1257×727 px — riquadro sulla pagina x \d+–\d+, y \d+–\d+ pt/);
    const dup = content.find((x) => x.type === 'text' && x.text.startsWith('img_08 — '));
    assert.ok(dup.text.includes('identica a img_04'));
    // le miniature dell'ingest (≤ 360 px) sono quelle allegate
    const at = content.indexOf(lab5);
    const meta = await sharp(Buffer.from(content[at + 1].source.data, 'base64')).metadata();
    assert.ok(Math.max(meta.width, meta.height) <= 360, `${meta.width}×${meta.height}`);
    await withMock([{ kind: 'json', data: GOLDEN }], async (mock) => {
      const m = await extractManual(dir, ingest, null, { baseURL: mock.url });
      assert.equal(m.steps.length, 7);
      const bytes = mock.requests[0].bytes;
      console.log(`       richiesta di ${(bytes / 1048576).toFixed(2)} MB con PDF + 14 miniature`);
    });
  });

  await test('ingest vero del DOCX di esempio + rianalisi da disco (extractManual senza ingestResult)', async () => {
    let ingestMod;
    try { ingestMod = await import('../src/ingest/index.js'); } catch (err) {
      console.log(`       (saltato: src/ingest non disponibile — ${err.message})`);
      return;
    }
    const dir = await freshDir(path.join(WORK, 'lavori', 'docx-vero'));
    await fs.mkdir(path.join(dir, 'input'), { recursive: true });
    const docx = path.join(dir, 'input', 'esempio.docx');
    await fs.copyFile(path.join(ROOT, 'test', 'fixtures', 'docx-esempio', 'esempio.docx'), docx);
    const ingest = await ingestMod.ingestDocument(dir, docx);
    await ingestMod.prepareImages(dir, ingest.catalog);
    const data = structuredClone(GOLDEN);
    data.cover_image_id = 'img_03'; data.brand_logo_image_id = null; data.notes = []; data.unused_image_ids = [];
    data.hardware.forEach((h, i) => { h.image_id = id2(i); });
    data.components.forEach((c) => { c.image_id = null; });
    data.steps.forEach((st) => { st.image_ids = []; });
    await withMock([{ kind: 'json', data }], async (mock) => {
      const m = await extractManual(dir, null, null, { baseURL: mock.url });
      const c = mock.requests[0].body.messages[0].content;
      assert.equal(c[0].type, 'text');
      assert.ok(c[0].text.includes('«esempio.docx»') && c[0].text.includes('<documento>') && c[0].text.includes('[[img_03]]'));
      assert.equal(c.filter((x) => x.type === 'image').length, ingest.catalog.filter((e) => !e.duplicate_of).length);
      assert.deepEqual(m.unused_image_ids, ingest.catalog.map((e) => e.id).filter((x) => !['img_00', 'img_01', 'img_02', 'img_03'].includes(x)), 'immagini dimenticate → non usate');
    });
  });

  console.log('\nSicurezza');
  await test('la chiave API non compare mai nei file dei lavori (log, consumi, schede)', async () => {
    const hits = [];
    const walk = async (d) => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) await walk(f);
        else if (/\.(txt|json)$/.test(e.name) && (await fs.readFile(f, 'utf8')).includes(KEY.slice(14))) hits.push(f);
      }
    };
    await walk(path.join(WORK, 'lavori'));
    assert.deepEqual(hits, []);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} test superati${failed.length ? ` — FALLITI: ${failed.map((f) => f.name).join('; ')}` : ''}.`);
  console.log('Promemoria: test dell’impianto con server finto, non una valutazione della qualità di Claude (vedi test/try-real-api.js).');
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
