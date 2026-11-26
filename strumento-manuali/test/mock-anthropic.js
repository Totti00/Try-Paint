#!/usr/bin/env node
// Server HTTP finto che imita POST /v1/messages dell'API Anthropic (streaming SSE e non streaming).
// Serve SOLO per i test dell'impianto (src/ai): le risposte sono preconfezionate, NON sono output di Claude.
//
// Uso nei test:
//   const mock = await startMockAnthropic({ responses: [ {kind:'error', status:429}, {kind:'json', data} ] });
//   ... SDK con baseURL: mock.url e una chiave finta ...
//   mock.requests  → [{ method, path, query, headers, body, bytes }]
//   await mock.close();
//
// Tipi di risposta (oggetti della coda; può essere anche una funzione (richiesta) => risposta):
//   { kind:'json', data, thinking=true, model, usage, chunkChars }        testo = JSON.stringify(data), stop end_turn
//   { kind:'text', text }                                                  testo libero (es. JSON rotto)
//   { kind:'truncated', data|text, fraction=0.5 }                          testo tagliato, stop max_tokens
//   { kind:'refusal', category='cyber', explanation, partial }             stop refusal (partial = testo già scritto)
//   { kind:'fallback', data, from, to }                                    blocco "fallback" + risposta del modello di riserva
//   { kind:'error', status, type, message, errorCode, headers }            errore HTTP con corpo JSON dell'API
//   { kind:'sse_error', type='overloaded_error', message, afterChunks=2 }  stream che si interrompe con event: error
//   { kind:'drop', afterChunks=2 }                                         connessione chiusa a metà stream
//   Opzioni comuni: delayMs (attesa prima di rispondere), chunkDelayMs (attesa tra i pezzi dello stream).
//
// Uso da riga di comando (per provare tutta l'app senza chiave vera):
//   node test/mock-anthropic.js [--porta 8787] [--scheda manual.json] [--piano plan.json]
//   poi: ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_API_KEY=sk-ant-finta-0000000000000000 npm start

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const estTokens = (s) => Math.max(1, Math.ceil(String(s || '').length / 3.5));

function chunksOf(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function errorBody(status, scenario, requestId) {
  const type = scenario.type || ({ 400: 'invalid_request_error', 401: 'authentication_error', 402: 'billing_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 500: 'api_error', 529: 'overloaded_error' }[status] || 'api_error');
  const error = { type, message: scenario.message || `errore finto ${status}` };
  if (scenario.errorCode) error.details = { error_code: scenario.errorCode };
  return { type: 'error', error, request_id: requestId };
}

/** Avvia il server finto su 127.0.0.1 (porta libera se port=0). */
export async function startMockAnthropic({ responses = [], defaultResponse = null, port = 0, model = 'claude-opus-5-5', chunkChars = 300 } = {}) {
  const requests = [];
  const queue = [...responses];
  let counter = 0;
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', () => {});
    req.on('end', async () => {
      try {
        await handle(req, res, Buffer.concat(chunks));
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: `mock: ${err.message}` } });
        else res.destroy();
      }
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  async function handle(req, res, raw) {
    const url = new URL(req.url, 'http://mock');
    const n = ++counter;
    const requestId = `req_mock_${String(n).padStart(4, '0')}`;
    let body = null;
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { body = null; }
    const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { ...req.headers }, body, bytes: raw.length, id: requestId };
    requests.push(record);

    if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
      return sendJson(res, 404, errorBody(404, { message: `mock: percorso non gestito ${req.method} ${url.pathname}` }, requestId), { 'request-id': requestId });
    }
    if (!body) return sendJson(res, 400, errorBody(400, { message: 'mock: corpo JSON non valido' }, requestId), { 'request-id': requestId });

    let scenario = queue.length ? queue.shift() : defaultResponse;
    if (typeof scenario === 'function') scenario = scenario(record);
    if (!scenario) return sendJson(res, 500, errorBody(500, { message: 'mock: nessuna risposta in coda' }, requestId), { 'request-id': requestId });
    if (scenario.delayMs) await sleep(scenario.delayMs);

    if (scenario.kind === 'error') {
      const status = scenario.status || 500;
      return sendJson(res, status, errorBody(status, scenario, requestId), { 'request-id': requestId, ...(scenario.headers || {}) });
    }

    const servedModel = scenario.model || body.model || model;
    const size = scenario.chunkChars || chunkChars;
    let text = '';
    if (scenario.kind === 'json' || scenario.kind === 'fallback') text = JSON.stringify(scenario.data);
    else if (scenario.kind === 'text') text = String(scenario.text ?? '');
    else if (scenario.kind === 'truncated') {
      const full = scenario.text ?? JSON.stringify(scenario.data);
      text = full.slice(0, Math.max(1, Math.floor(full.length * (scenario.fraction ?? 0.5))));
    } else if (scenario.kind === 'refusal') text = scenario.partial || '';
    else if (scenario.kind === 'sse_error' || scenario.kind === 'drop') text = JSON.stringify(scenario.data ?? { finto: 'x'.repeat(3000) });

    const stopReason = scenario.kind === 'truncated' ? 'max_tokens' : scenario.kind === 'refusal' ? 'refusal' : 'end_turn';
    const stopDetails = scenario.kind === 'refusal' ? { type: 'refusal', category: scenario.category === undefined ? 'cyber' : scenario.category, explanation: scenario.explanation ?? null } : null;
    const inputTokens = scenario.usage?.input_tokens ?? 20000;
    const thinkingTokens = scenario.thinking === false ? 0 : 500;
    const outputTokens = scenario.usage?.output_tokens ?? (estTokens(text) + thinkingTokens);
    const withThinking = scenario.thinking !== false && scenario.kind !== 'refusal';
    const fallbackBlock = scenario.kind === 'fallback'
      ? { type: 'fallback', from: { model: scenario.from || body.model || model }, to: { model: scenario.to || 'claude-opus-4-8' } }
      : null;
    const iterations = scenario.kind === 'fallback'
      ? [
        { type: 'message', model: body.model || model, input_tokens: inputTokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
        { type: 'fallback_message', model: scenario.to || 'claude-opus-4-8', input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
      ]
      : scenario.usage?.iterations;
    const usage = {
      input_tokens: inputTokens, output_tokens: outputTokens,
      cache_creation_input_tokens: scenario.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: scenario.usage?.cache_read_input_tokens ?? 0,
      ...(iterations ? { iterations } : {}),
    };
    const finalModel = fallbackBlock ? fallbackBlock.to.model : servedModel;

    // ---------------------------------------------------------------- non streaming
    if (!body.stream) {
      if (scenario.kind === 'sse_error') return sendJson(res, 529, errorBody(529, { type: scenario.type || 'overloaded_error', message: scenario.message }, requestId), { 'request-id': requestId });
      if (scenario.kind === 'drop') { res.socket?.destroy(); return; }
      const content = [];
      if (withThinking) content.push({ type: 'thinking', thinking: '', signature: 'mock-signature' });
      if (fallbackBlock) content.push(fallbackBlock);
      if (text) content.push({ type: 'text', text });
      return sendJson(res, 200, {
        id: `msg_mock_${n}`, type: 'message', role: 'assistant', model: finalModel, content,
        stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails, usage,
      }, { 'request-id': requestId });
    }

    // ---------------------------------------------------------------- streaming SSE
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'request-id': requestId });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const pause = () => (scenario.chunkDelayMs ? sleep(scenario.chunkDelayMs) : Promise.resolve());
    send('message_start', {
      type: 'message_start',
      message: { id: `msg_mock_${n}`, type: 'message', role: 'assistant', model: finalModel, content: [], stop_reason: null, stop_sequence: null, stop_details: null,
        usage: { input_tokens: inputTokens, output_tokens: 1, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens } },
    });
    res.write('event: ping\ndata: {"type": "ping"}\n\n');
    let index = 0;
    if (withThinking) {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      if (scenario.thinkingText) send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: scenario.thinkingText } });
      await pause();
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'mock-signature' } });
      send('content_block_stop', { type: 'content_block_stop', index });
      index++;
    }
    if (fallbackBlock) {
      send('content_block_start', { type: 'content_block_start', index, content_block: fallbackBlock });
      send('content_block_stop', { type: 'content_block_stop', index });
      index++;
    }
    if (text || scenario.kind === 'sse_error' || scenario.kind === 'drop') {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      const parts = chunksOf(text, size);
      for (let i = 0; i < parts.length; i++) {
        if ((scenario.kind === 'sse_error' || scenario.kind === 'drop') && i === (scenario.afterChunks ?? 2)) {
          if (scenario.kind === 'drop') { res.socket?.destroy(); return; }
          send('error', { type: 'error', error: { type: scenario.type || 'overloaded_error', message: scenario.message || 'Overloaded' }, request_id: requestId });
          res.end();
          return;
        }
        send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: parts[i] } });
        await pause();
      }
      send('content_block_stop', { type: 'content_block_stop', index });
    }
    send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails }, usage });
    send('message_stop', { type: 'message_stop' });
    res.end();
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const { port: actual } = server.address();
  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    requests,
    push: (...r) => queue.push(...r),
    get pending() { return queue.length; },
    close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

// ------------------------------------------------------------------------------------- riga di comando

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
  const port = Number(arg('--porta', 8787));
  const manualFile = path.resolve(arg('--scheda', path.join(here, 'fixtures', 'tavolo-levante', 'manual.json')));
  const planFile = path.resolve(arg('--piano', path.join(here, 'fixtures', 'tavolo-levante', 'plan.json')));
  const manual = JSON.parse(fs.readFileSync(manualFile, 'utf8'));
  const plan = fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, 'utf8')) : null;
  // Risponde con la scheda o con il piano a seconda dello schema richiesto (il piano ha "caption_title").
  const auto = (rec) => {
    const wantsPlan = JSON.stringify(rec.body?.output_config?.format?.schema || {}).includes('caption_title');
    if (wantsPlan && !plan) return { kind: 'error', status: 400, message: 'mock: nessun piano di prova (--piano)' };
    return { kind: 'json', data: wantsPlan ? plan : manual, chunkDelayMs: 15, chunkChars: 120 };
  };
  const mock = await startMockAnthropic({ port, defaultResponse: auto });
  console.log(`Server Claude FINTO in ascolto su ${mock.url} (risposte preconfezionate, non è Claude).`);
  console.log(`  scheda: ${manualFile}`);
  console.log(`  piano:  ${plan ? planFile : '(nessuno)'}`);
  console.log(`Avvia l'app con: ANTHROPIC_BASE_URL=${mock.url} ANTHROPIC_API_KEY=sk-ant-finta-0000000000000000 npm start`);
  const stop = async () => { await mock.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
