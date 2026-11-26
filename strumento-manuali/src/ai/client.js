// Chiamata a Claude con output strutturato (JSON Schema generato da uno schema zod), in streaming.
//
//   callStructured({ system, content, schema, maxTokens=64000, effort='high', onProgress, jobDir, label, signal }) → oggetto validato
//   callStructuredDetailed(...)  → { data, model, usage, costUsd, stopReason, fallbackUsed, requestId, attempts }
//   estimateCost(usage, model)   → { usd, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, approx, text }
//   AiError                      → errore con messaggio italiano per l'utente e `code` per il programma
//
// Scelte (vedi skill claude-api, SDK @anthropic-ai/sdk 1.13):
// - client.beta.messages.stream() con `betas: ['server-side-fallback-2026-07-01']` e `fallbacks: 'default'`: se i
//   classificatori di sicurezza declinano la richiesta, l'API la ripete da sé sul modello di riserva consigliato.
//   Se l'organizzazione non ha la beta (400 sull'header anthropic-beta / sul campo fallbacks) si ripete subito senza.
// - output_config.format = JSON Schema prodotto da betaZodOutputFormat(schema), ma SENZA la funzione parse(): il
//   parse automatico dell'SDK scatta a fine stream e lancia un'eccezione su JSON parziale (refusal, max_tokens) o su
//   più blocchi di testo (fallback a metà risposta), perdendo stop_reason. Qui si controlla prima stop_reason, poi si
//   fa JSON.parse e si valida di nuovo con zod.
// - thinking non si imposta: su claude-opus-5-5 è sempre attivo (adattivo); la profondità si regola con
//   output_config.effort ('high' per l'estrazione).
// - I tentativi li gestisce questo modulo (maxRetries: 0 nell'SDK) per poter dire all'utente cosa succede:
//   429 / 529 / 5xx / rete → fino a `retries` nuovi tentativi con attesa crescente (o quella chiesta da retry-after).
//   max_tokens → un nuovo tentativo con il limite massimo (128K); JSON non valido → un nuovo tentativo.

import Anthropic, {
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AnthropicError,
} from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { getApiKey, getModel, DEFAULT_MODEL } from '../settings.js';
import { appendJobLog, recordUsage, formatInt } from './log.js';

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const MAX_OUTPUT_TOKENS = 128000;
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024; // limite dell'API per richiesta (PDF e immagini in base64 compresi)

// Prezzi in dollari per milione di token (input, output, lettura cache, scrittura cache 5 min).
export const PRICES = Object.freeze({
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
});

// ------------------------------------------------------------------------------------- errori

export class AiError extends Error {
  /**
   * @param {string} message  messaggio italiano per l'utente
   * @param {{ code: string, retryable?: boolean, status?: number|null, requestId?: string|null, details?: object|null, cause?: unknown }} o
   */
  constructor(message, { code, retryable = false, status = null, requestId = null, details = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AiError';
    this.code = code || 'ai';
    this.retryable = retryable;
    this.status = status;
    this.requestId = requestId;
    this.details = details;
  }
}

export const MESSAGES = Object.freeze({
  missing_key: 'Manca la chiave API di Claude: inseriscila in Impostazioni.',
  invalid_key: 'La chiave API di Claude non è valida o è stata revocata: controllala in Impostazioni (la trovi nella Console Anthropic › API Keys).',
  permission: 'La chiave API non ha il permesso di usare Claude (errore 403): controlla organizzazione e area di lavoro della chiave nella Console Anthropic.',
  billing: 'Credito esaurito sull’account Anthropic: ricaricalo nella Console Anthropic › Plans & Billing (console.anthropic.com), poi riprova.',
  spend_limit: 'È stato raggiunto il limite di spesa dell’account Anthropic: alzalo nella Console Anthropic › Limits, oppure attendi il rinnovo mensile.',
  rate_limit: 'Troppe richieste a Claude in poco tempo (limite di velocità dell’account): attendi un paio di minuti e riprova.',
  overloaded: 'I server di Claude sono sovraccarichi in questo momento: riprova tra qualche minuto.',
  server: 'Errore temporaneo dei server di Claude: riprova tra qualche minuto.',
  network: 'Impossibile contattare Claude: controlla la connessione a Internet (o un eventuale proxy/firewall) e riprova.',
  interrupted: 'La connessione con Claude si è interrotta durante la risposta: controlla la connessione a Internet e riprova.',
  timeout: 'Claude non ha risposto in tempo: controlla la connessione a Internet e riprova.',
  too_large: 'Il documento è troppo grande per essere inviato a Claude in una sola volta (al massimo 32 MB e 600 pagine): dividilo in parti più piccole o riduci la risoluzione delle immagini.',
  aborted: 'Analisi annullata.',
  invalid_output: 'Claude ha restituito dati incompleti o in un formato non valido: riprova l’analisi.',
});

const REFUSAL_CATEGORY = {
  cyber: 'contenuti di sicurezza informatica',
  bio: 'contenuti di rischio biologico',
  reasoning_extraction: 'richiesta di esporre il ragionamento interno',
  frontier_llm: 'sviluppo di modelli di intelligenza artificiale',
  general_harms: 'norme d’uso',
};

function apiMessageOf(err) {
  return String(err?.apiMessage || err?.error?.error?.message || err?.message || '').slice(0, 400);
}

/** Traduce un errore dell'SDK (o di rete) in AiError con messaggio italiano. */
export function classifyError(err, { model = DEFAULT_MODEL, timedOut = false } = {}) {
  if (err instanceof AiError) return err;
  const requestId = err?.requestID ?? null;
  if (timedOut) return new AiError(MESSAGES.timeout, { code: 'timeout', retryable: false, cause: err });
  if (err instanceof APIUserAbortError || err?.name === 'AbortError') return new AiError(MESSAGES.aborted, { code: 'aborted', cause: err });
  if (err instanceof APIConnectionTimeoutError) return new AiError(MESSAGES.timeout, { code: 'timeout', retryable: true, cause: err });
  if (err instanceof APIConnectionError) return new AiError(MESSAGES.network, { code: 'network', retryable: true, cause: err });

  if (err instanceof APIError) {
    const status = typeof err.status === 'number' ? err.status : null;
    const type = err.type || err?.error?.error?.type || null;
    const code = err.errorCode || null;
    const msg = apiMessageOf(err);
    const base = { status, requestId, cause: err, details: { type, error_code: code, api_message: msg } };
    if (status === 401 || type === 'authentication_error') return new AiError(MESSAGES.invalid_key, { ...base, code: 'invalid_key' });
    if (type === 'billing_error' || status === 402 || (status === 400 && /credit balance/i.test(msg))) {
      return new AiError(MESSAGES.billing, { ...base, code: 'billing' });
    }
    if (code === 'enforced_spend_limit_reached' || code === 'contract_spend_limit_reached') return new AiError(MESSAGES.spend_limit, { ...base, code: 'spend_limit' });
    if (status === 403 || type === 'permission_error') return new AiError(MESSAGES.permission, { ...base, code: 'permission' });
    if (status === 404 || type === 'not_found_error') {
      return new AiError(`Il modello «${model}» non esiste o non è disponibile per questa chiave API: controlla il modello in Impostazioni (quello consigliato è ${DEFAULT_MODEL}).`, { ...base, code: 'model_not_found' });
    }
    if (status === 413 || type === 'request_too_large') return new AiError(MESSAGES.too_large, { ...base, code: 'too_large' });
    if (status === 400 && /prompt is too long|too many (images|pages|documents)|maximum of \d+ (pages|images)|exceeds the maximum/i.test(msg)) {
      return new AiError(MESSAGES.too_large, { ...base, code: 'too_large' });
    }
    if (status === 400 && /anthropic-beta|fallbacks?\b/i.test(msg)) {
      // Interno: l'organizzazione non ha la beta del fallback lato server → si ripete senza.
      return new AiError('Fallback lato server non disponibile per questa organizzazione.', { ...base, code: 'beta_unsupported' });
    }
    if (status === 429 || type === 'rate_limit_error') return new AiError(MESSAGES.rate_limit, { ...base, code: 'rate_limit', retryable: true });
    if (status === 529 || type === 'overloaded_error') return new AiError(MESSAGES.overloaded, { ...base, code: 'overloaded', retryable: true });
    if ((status && status >= 500) || type === 'api_error' || type === 'timeout_error' || status === 408) {
      const text = status ? MESSAGES.server.replace(':', ` (errore ${status}):`) : MESSAGES.server;
      return new AiError(text, { ...base, code: 'server', retryable: true });
    }
    if (status === 400 || type === 'invalid_request_error') {
      return new AiError(`Claude ha rifiutato la richiesta come non valida: «${msg}». Se il problema si ripete, segnalalo insieme al file log.txt del lavoro.`, { ...base, code: 'bad_request' });
    }
    return new AiError(`Errore imprevisto da Claude${status ? ` (${status})` : ''}: ${msg}`, { ...base, code: 'api_error', retryable: !status });
  }

  // Errori non HTTP durante lo stream (connessione chiusa a metà, stream terminato senza messaggio, …).
  if (err instanceof AnthropicError) return new AiError(MESSAGES.interrupted, { code: 'interrupted', retryable: true, cause: err, details: { message: String(err.message).slice(0, 300) } });
  const m = String(err?.message || err);
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket|terminated|network/i.test(m)) {
    return new AiError(MESSAGES.network, { code: 'network', retryable: true, cause: err });
  }
  return new AiError(`Errore imprevisto durante la chiamata a Claude: ${m.slice(0, 300)}`, { code: 'unknown', cause: err });
}

// ------------------------------------------------------------------------------------- costi

export function priceFor(model) {
  const id = String(model || '');
  // Il prefisso più lungo vince (claude-opus-5-5 prima di claude-opus-5).
  const key = Object.keys(PRICES).sort((a, b) => b.length - a.length).find((k) => id === k || id.startsWith(k + '-') || id.startsWith(k + '@'));
  return key ? { price: PRICES[key], known: true, key } : { price: PRICES[DEFAULT_MODEL], known: false, key: DEFAULT_MODEL };
}

const fmtUsd = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' });
const fmtUsdSmall = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

export function formatUsd(usd) {
  const v = Number(usd) || 0;
  return `${v > 0 && v < 0.1 ? fmtUsdSmall.format(v) : fmtUsd.format(v)} $`;
}

/**
 * Costo stimato di una risposta. Con il fallback lato server `usage.iterations` riporta ogni tentativo (ognuno al
 * prezzo del proprio modello) ed è la fonte da usare; altrimenti si usano i totali.
 */
export function estimateCost(usage, model = DEFAULT_MODEL) {
  const u = usage || {};
  const rows = Array.isArray(u.iterations) && u.iterations.length ? u.iterations : [u];
  let usd = 0;
  let approx = false;
  const tot = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  for (const r of rows) {
    const { price, known } = priceFor(r.model || model);
    if (!known) approx = true;
    const inp = Number(r.input_tokens) || 0;
    const out = Number(r.output_tokens) || 0;
    const cr = Number(r.cache_read_input_tokens) || 0;
    const cw = Number(r.cache_creation_input_tokens) || 0;
    tot.input_tokens += inp; tot.output_tokens += out; tot.cache_read_input_tokens += cr; tot.cache_creation_input_tokens += cw;
    usd += (inp * price.input + out * price.output + cr * price.cacheRead + cw * price.cacheWrite) / 1e6;
  }
  usd = Math.round(usd * 1e6) / 1e6;
  const tokensText = `${formatInt(tot.input_tokens + tot.cache_read_input_tokens + tot.cache_creation_input_tokens)} token in ingresso, ${formatInt(tot.output_tokens)} in uscita`;
  const text = `${formatUsd(usd)}${approx ? ' (stima con i prezzi di ' + DEFAULT_MODEL + ')' : ''} — ${tokensText}`;
  return { usd, ...tot, approx, text, tokensText };
}

// ------------------------------------------------------------------------------------- schema

const formatCache = new WeakMap();
const INT_RANGE_NOTE = /\s*\{minimum: -?9007199254740991, maximum: 9007199254740991\}/g;

function cleanSchema(node) {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'description' && typeof v === 'string') {
      const d = v.replace(INT_RANGE_NOTE, '').trim();
      if (d) out[k] = d;
    } else out[k] = cleanSchema(v);
  }
  return out;
}

/** { type:'json_schema', schema } per output_config.format (senza parse automatico: lo facciamo noi). */
export function outputFormatFor(schema) {
  let f = formatCache.get(schema);
  if (!f) {
    const auto = betaZodOutputFormat(schema);
    f = { type: auto.type, schema: cleanSchema(auto.schema) };
    formatCache.set(schema, f);
  }
  return f;
}

/** Testo JSON della risposta → oggetto validato dallo schema zod. Prova più letture se c'è stato un fallback. */
export function parseStructured(message, schema) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text || '');
  let lastFallback = -1;
  blocks.forEach((b, i) => { if (b.type === 'fallback') lastFallback = i; });
  const afterFallback = lastFallback >= 0 ? blocks.slice(lastFallback + 1).filter((b) => b.type === 'text').map((b) => b.text || '').join('') : null;
  const candidates = [texts.join(''), afterFallback, ...texts.slice().reverse()].filter((t, i, a) => t && t.trim() && a.indexOf(t) === i);
  const errors = [];
  for (const c of candidates) {
    let json;
    try {
      json = JSON.parse(c.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    } catch (err) {
      errors.push(`JSON non leggibile: ${String(err.message).slice(0, 120)}`);
      continue;
    }
    const r = schema.safeParse(json);
    if (r.success) return { ok: true, data: r.data };
    errors.push('schema: ' + r.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || '(radice)'}: ${i.message}`).join('; '));
  }
  if (!candidates.length) errors.push('nessun testo nella risposta');
  return { ok: false, errors };
}

// ------------------------------------------------------------------------------------- progresso

function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return;
  try {
    const r = fn(...args);
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch { /* il callback non deve interrompere la chiamata */ }
}

function makeTracker(onProgress, attempt) {
  const t0 = Date.now();
  let phase = 'connecting';
  let chars = 0;
  let lastWrite = 0;
  const secs = () => Math.round((Date.now() - t0) / 1000);
  const estTokens = () => Math.round(chars / 3.4);
  const info = () => ({ phase, outputTokens: estTokens(), elapsedMs: Date.now() - t0, attempt });
  const emit = (msg) => safeCall(onProgress, null, msg, info());
  const tick = setInterval(() => {
    if (phase === 'connecting') emit(`Invio del documento a Claude… ${secs()} s`);
    else if (phase === 'reading') emit(`Claude sta leggendo il documento… ${secs()} s`);
    else if (phase === 'thinking') emit(`Claude sta ragionando… ${secs()} s`);
  }, 2500);
  tick.unref?.();
  emit('Invio del documento a Claude…');
  return {
    event(ev, onFallback) {
      switch (ev?.type) {
        case 'message_start':
          phase = 'reading';
          emit('Claude sta leggendo il documento…');
          break;
        case 'content_block_start': {
          const t = ev.content_block?.type;
          if (t === 'thinking' || t === 'redacted_thinking') { if (phase !== 'writing') { phase = 'thinking'; emit(`Claude sta ragionando… ${secs()} s`); } }
          else if (t === 'text') { phase = 'writing'; emit(`Claude sta scrivendo… circa ${formatInt(estTokens())} token`); }
          else if (t === 'fallback') safeCall(onFallback, ev.content_block);
          break;
        }
        case 'content_block_delta':
          if (ev.delta?.type === 'text_delta') {
            phase = 'writing';
            chars += (ev.delta.text || '').length;
            const now = Date.now();
            if (now - lastWrite > 700) { lastWrite = now; emit(`Claude sta scrivendo… circa ${formatInt(estTokens())} token`); }
          }
          break;
        default:
          break;
      }
    },
    stop() { clearInterval(tick); },
    info,
  };
}

// ------------------------------------------------------------------------------------- utilità

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new APIUserAbortError());
    const onAbort = () => { clearTimeout(t); reject(new APIUserAbortError()); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryAfterMs(err) {
  const h = err?.headers;
  const v = h && typeof h.get === 'function' ? h.get('retry-after') : null;
  if (v == null || v === '') return null;
  const s = Number.parseFloat(v);
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 60000);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.min(Math.max(0, d - Date.now()), 60000) : null;
}

function envDelay() {
  const v = Number(process.env.MANUALI_AI_RETRY_DELAY_MS);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

const secondsText = (ms) => (ms < 1000 ? `${(ms / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} s` : `${Math.round(ms / 1000)} s`);

async function streamOnce(client, params, signal, tracker, onFallback) {
  const stream = client.beta.messages.stream(params, { signal });
  stream.on('streamEvent', (ev) => tracker.event(ev, onFallback));
  const message = await stream.finalMessage();
  return { message, requestId: stream.request_id ?? null };
}

// ------------------------------------------------------------------------------------- chiamata

/**
 * @param {object} o
 * @param {string} o.system                 prompt di sistema
 * @param {string|object[]} o.content       contenuto del messaggio utente (blocchi document/image/text)
 * @param {import('zod').ZodType} o.schema  schema zod della risposta
 * @param {number} [o.maxTokens=64000]
 * @param {'low'|'medium'|'high'|'xhigh'|'max'} [o.effort='high']
 * @param {(pct:null, message:string, info:object)=>void} [o.onProgress]
 * @param {string|null} [o.jobDir]          se c'è: consumi e eventi in log.txt / ai-usage.json
 * @param {string} [o.label]                nome della chiamata nel registro (es. "estrazione scheda")
 * @param {string} [o.model]                predefinito: impostazioni → claude-opus-5-5
 * @param {string} [o.apiKey]               predefinito: getApiKey()
 * @param {string} [o.baseURL]              predefinito: ANTHROPIC_BASE_URL o api.anthropic.com
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.retries=2]            nuovi tentativi per 429/529/5xx/rete
 * @param {number} [o.retryDelayMs=5000]    attesa base (raddoppia), se l'API non indica retry-after
 * @param {number} [o.totalTimeoutMs]       tempo massimo complessivo (predefinito 45 minuti)
 * @param {boolean} [o.fallbacks=true]      fallback lato server in caso di rifiuto
 */
export async function callStructuredDetailed(o = {}) {
  const {
    system, content, schema, maxTokens = 64000, effort = 'high', onProgress, jobDir = null, label = 'richiesta',
    model: modelOpt, apiKey: keyOpt, baseURL, signal, retries = 2, retryDelayMs, totalTimeoutMs = 45 * 60 * 1000, fallbacks = true,
  } = o;
  if (!schema || typeof schema.safeParse !== 'function') throw new TypeError('callStructured: serve uno schema zod (schema).');
  if (typeof content !== 'string' && !Array.isArray(content)) throw new TypeError('callStructured: content deve essere una stringa o un array di blocchi.');
  if (Array.isArray(content) && !content.length) throw new TypeError('callStructured: content è vuoto.');

  const apiKey = keyOpt ?? (await getApiKey());
  if (!apiKey) throw new AiError(MESSAGES.missing_key, { code: 'missing_key' });
  if (!/^[\x21-\x7e]+$/.test(apiKey)) throw new AiError(MESSAGES.invalid_key, { code: 'invalid_key' });
  const model = modelOpt || (await getModel());
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}), maxRetries: 0, timeout: 15 * 60 * 1000 });
  const format = outputFormatFor(schema);
  const baseDelay = retryDelayMs ?? envDelay() ?? 5000;
  const log = (m) => appendJobLog(jobDir, `Claude (${label}): ${m}`);
  const progress = (m) => safeCall(onProgress, null, m, null);

  // Annullamento: segnale del chiamante + tempo massimo complessivo.
  const ctrl = new AbortController();
  let timedOut = false;
  const onOuterAbort = () => ctrl.abort();
  if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onOuterAbort, { once: true }); }
  const killer = setTimeout(() => { timedOut = true; ctrl.abort(); }, totalTimeoutMs);
  killer.unref?.();

  let useFallbacks = !!fallbacks && !process.env.MANUALI_AI_NO_FALLBACK;
  let tokens = Math.max(1024, Math.min(Number(maxTokens) || 64000, MAX_OUTPUT_TOKENS));
  let transient = 0;
  let invalidRetries = 0;
  let escalated = false;
  let attempts = 0;
  const totals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let totalUsd = 0;
  let sizeChecked = false;
  const tStart = Date.now();

  try {
    for (;;) {
      attempts++;
      const params = {
        model,
        max_tokens: tokens,
        system,
        messages: [{ role: 'user', content }],
        output_config: { effort, format },
        ...(useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
      };
      if (!sizeChecked) {
        sizeChecked = true;
        const bytes = Buffer.byteLength(JSON.stringify(params), 'utf8');
        const nDocs = Array.isArray(content) ? content.filter((b) => b?.type === 'document').length : 0;
        const nImgs = Array.isArray(content) ? content.filter((b) => b?.type === 'image').length : 0;
        await log(`invio — modello ${model}, effort ${effort}, max_tokens ${formatInt(tokens)}, fallback lato server ${useFallbacks ? 'sì' : 'no'}, ` +
          `${nDocs} documento/i, ${nImgs} immagini, richiesta di ${(bytes / 1048576).toLocaleString('it-IT', { maximumFractionDigits: 1 })} MB`);
        if (bytes > MAX_REQUEST_BYTES) {
          await log(`richiesta troppo grande (${bytes} byte > ${MAX_REQUEST_BYTES})`);
          throw new AiError(MESSAGES.too_large, { code: 'too_large' });
        }
      }

      const tracker = makeTracker(onProgress, attempts);
      const tA = Date.now();
      let result;
      try {
        result = await streamOnce(client, params, ctrl.signal, tracker, (fb) => {
          const from = fb?.from?.model || model;
          const to = fb?.to?.model || 'modello di riserva';
          log(`${from} ha declinato la richiesta: continua ${to} (fallback lato server)`);
          progress(`Il modello principale ha declinato: continua il modello di riserva (${to})…`);
        });
      } catch (err) {
        let ai = classifyError(err, { model, timedOut });
        if (ai.code === 'beta_unsupported') {
          if (useFallbacks) {
            useFallbacks = false;
            await log('l’organizzazione non accetta il fallback lato server (400 su anthropic-beta/fallbacks): ripeto senza');
            continue;
          }
          const msg = ai.details?.api_message || '';
          ai = new AiError(`Claude ha rifiutato la richiesta come non valida: «${msg}».`, { code: 'bad_request', status: ai.status, requestId: ai.requestId, details: ai.details, cause: err });
        }
        if (ai.retryable && transient < retries && !ctrl.signal.aborted) {
          transient++;
          const wait = retryAfterMs(err) ?? baseDelay * 2 ** (transient - 1);
          await log(`${ai.code}${ai.status ? ' ' + ai.status : ''} — nuovo tentativo ${transient} di ${retries} tra ${secondsText(wait)}`);
          progress(`${ai.message.split(':')[0]}: nuovo tentativo tra ${secondsText(wait)} (${transient} di ${retries})…`);
          try {
            await sleep(wait, ctrl.signal);
          } catch (e) {
            throw classifyError(e, { model, timedOut });
          }
          continue;
        }
        await log(`errore ${ai.code}${ai.status ? ' ' + ai.status : ''}${ai.requestId ? ' (richiesta ' + ai.requestId + ')' : ''}: ${ai.details?.api_message || ai.message}`);
        throw ai;
      } finally {
        tracker.stop();
      }

      const { message, requestId } = result;
      const servedBy = message.model || model;
      const cost = estimateCost(message.usage, servedBy);
      for (const k of Object.keys(totals)) totals[k] += cost[k];
      totalUsd += cost.usd;
      const fallbackUsed = (Array.isArray(message.usage?.iterations) && message.usage.iterations.some((it) => it?.type === 'fallback_message'))
        || (message.content || []).some((b) => b?.type === 'fallback');
      const stop = message.stop_reason;
      await log(`risposta — stop ${stop}, modello ${servedBy}${fallbackUsed ? ' (fallback)' : ''}, ${cost.tokensText}, ` +
        `costo stimato ${formatUsd(cost.usd)}${cost.approx ? ' (prezzi del modello sconosciuti: stima)' : ''}, ${Math.round((Date.now() - tA) / 1000)} s${requestId ? ', richiesta ' + requestId : ''}`);
      await recordUsage(jobDir, {
        label, model: servedBy, requested_model: model, stop_reason: stop, fallback: fallbackUsed, request_id: requestId,
        input_tokens: cost.input_tokens, output_tokens: cost.output_tokens, cache_read_input_tokens: cost.cache_read_input_tokens,
        cache_creation_input_tokens: cost.cache_creation_input_tokens, cost_usd: cost.usd, approx: cost.approx,
      });

      if (stop === 'refusal') {
        const cat = message.stop_details?.category ?? null;
        const why = cat ? REFUSAL_CATEGORY[cat] || cat : 'motivo non specificato';
        await log(`rifiuto (categoria ${cat ?? 'null'})${message.stop_details?.explanation ? ': ' + String(message.stop_details.explanation).slice(0, 300) : ''}`);
        throw new AiError(
          `Claude ha rifiutato di elaborare questo documento (${why})${useFallbacks ? ', anche con il modello di riserva' : ''}. ` +
          'Se è davvero un manuale di montaggio, riprova; se succede ancora, esporta di nuovo il file in PDF e ricaricalo.',
          { code: 'refusal', requestId, details: { category: cat, explanation: message.stop_details?.explanation ?? null } },
        );
      }
      if (stop === 'max_tokens') {
        if (!escalated && tokens < MAX_OUTPUT_TOKENS) {
          escalated = true;
          await log(`risposta troncata a ${formatInt(tokens)} token: ripeto con il limite massimo di ${formatInt(MAX_OUTPUT_TOKENS)}`);
          progress('La risposta era troppo lunga: nuovo tentativo con un limite più alto…');
          tokens = MAX_OUTPUT_TOKENS;
          continue;
        }
        throw new AiError(
          `La risposta di Claude è stata interrotta perché ha superato il limite di lunghezza (${formatInt(tokens)} token). ` +
          'Il documento è probabilmente troppo lungo per una sola analisi: dividilo in parti più piccole e riprova.',
          { code: 'truncated', requestId },
        );
      }

      const parsed = parseStructured(message, schema);
      if (!parsed.ok) {
        await log(`risposta non valida: ${parsed.errors.join(' | ').slice(0, 800)}`);
        if (invalidRetries < 1) {
          invalidRetries++;
          progress('La risposta di Claude non era valida: nuovo tentativo…');
          continue;
        }
        throw new AiError(MESSAGES.invalid_output, { code: 'invalid_output', requestId, details: { errors: parsed.errors } });
      }

      if (attempts > 1) await log(`totale ${attempts} tentativi, costo stimato complessivo ${formatUsd(totalUsd)}, ${Math.round((Date.now() - tStart) / 1000)} s`);
      return {
        data: parsed.data,
        model: servedBy,
        usage: { ...totals },
        costUsd: Math.round(totalUsd * 1e6) / 1e6,
        costText: formatUsd(totalUsd),
        stopReason: stop,
        fallbackUsed,
        requestId,
        attempts,
      };
    }
  } finally {
    clearTimeout(killer);
    signal?.removeEventListener?.('abort', onOuterAbort);
  }
}

export async function callStructured(o) {
  return (await callStructuredDetailed(o)).data;
}
