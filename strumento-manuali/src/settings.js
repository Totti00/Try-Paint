// Impostazioni locali dello strumento: config/settings.json (git-ignored).
//
//   getSettings()          → vista pubblica, sicura da mandare al browser:
//                            { hasApiKey, apiKeyHint:"sk-ant-…abcd", apiKeySource:'impostazioni'|'ambiente'|null,
//                              model, theme }   (la chiave vera NON c'è mai)
//   saveSettings(partial)  → { apiKey?, model?, theme? }; apiKey ''/null = cancella, model ''/null = predefinito,
//                            theme null = predefinito. Restituisce la nuova vista pubblica.
//   getApiKey()            → chiave da settings.json, altrimenti variabile d'ambiente ANTHROPIC_API_KEY, altrimenti null
//   getModel()             → modello scelto o DEFAULT_MODEL
//   maskKey(key)           → "sk-ant-…abcd"
//
// La cartella si può spostare con MANUALI_CONFIG_DIR (usato dai test per non toccare le impostazioni vere).
// La chiave non viene mai scritta nei log né restituita da getSettings().

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_MODEL = 'claude-opus-5-5';

export const DEFAULT_THEME = Object.freeze({
  accent: '#FF7E00',
  accentInk: '#B45700',
  beige: '#DBD3CB',
  beigeSoft: '#F2EEE9',
  ink: '#1F1C1A',
  text: '#3B3632',
  muted: '#766D66',
  line: '#E4DED7',
});

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const MODEL_RE = /^[a-z0-9][a-z0-9._:@\-]{1,99}$/i;

export class SettingsError extends Error {
  constructor(message, { code = 'settings', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SettingsError';
    this.code = code;
  }
}

export function configDir() {
  return path.resolve(process.env.MANUALI_CONFIG_DIR || path.join(ROOT, 'config'));
}

export function settingsPath() {
  return path.join(configDir(), 'settings.json');
}

/** "sk-ant-…abcd": abbastanza per riconoscere la chiave, mai abbastanza per usarla. */
export function maskKey(key) {
  if (typeof key !== 'string') return '';
  const k = key.trim();
  if (!k) return '';
  if (k.length < 16) return '…' + k.slice(-2);
  const prefix = k.startsWith('sk-ant-') ? 'sk-ant-' : k.slice(0, 3);
  return `${prefix}…${k.slice(-4)}`;
}

/** Pulisce la chiave incollata dall'utente (spazi, virgolette, "ANTHROPIC_API_KEY=" davanti). */
export function normalizeApiKey(raw) {
  let k = String(raw ?? '').trim();
  k = k.replace(/^ANTHROPIC_API_KEY\s*=\s*/i, '').trim();
  k = k.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').trim();
  return k;
}

/** Errore italiano se la stringa non può essere una chiave API di Claude; altrimenti la chiave pulita. */
export function validateApiKey(raw) {
  const k = normalizeApiKey(raw);
  if (!k) throw new SettingsError('La chiave API è vuota.', { code: 'api_key_empty' });
  if (/\s/.test(k)) throw new SettingsError('La chiave API contiene spazi o a capo: copiala di nuovo dalla Console Anthropic, senza altro testo.', { code: 'api_key_format' });
  if (!/^[\x21-\x7e]+$/.test(k)) throw new SettingsError('La chiave API contiene caratteri non validi: copiala di nuovo dalla Console Anthropic.', { code: 'api_key_format' });
  if (!k.startsWith('sk-ant-')) throw new SettingsError('Questa non sembra una chiave API di Claude: deve iniziare con «sk-ant-». La trovi nella Console Anthropic › API Keys.', { code: 'api_key_format' });
  if (k.length < 24) throw new SettingsError('La chiave API è troppo corta: probabilmente è stata copiata solo in parte.', { code: 'api_key_format' });
  return k;
}

function normalizeColor(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!HEX.test(s)) return null;
  return (s.length === 4 ? '#' + [...s.slice(1)].map((c) => c + c).join('') : s).toUpperCase();
}

/** Tema completo: colori validi salvati sopra i predefiniti. */
function resolveTheme(saved) {
  const out = { ...DEFAULT_THEME };
  if (saved && typeof saved === 'object') {
    for (const key of Object.keys(DEFAULT_THEME)) {
      const c = normalizeColor(saved[key]);
      if (c) out[key] = c;
    }
  }
  return out;
}

// --------------------------------------------------------------------------------- lettura/scrittura

async function readRaw() {
  const file = settingsPath();
  let txt;
  try {
    txt = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    throw new SettingsError(`Impossibile leggere le impostazioni (${file}): ${err?.message || err}`, { code: 'settings_read', cause: err });
  }
  try {
    const obj = JSON.parse(txt.replace(/^﻿/, ''));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    // File rovinato (es. modificato a mano): lo si mette da parte e si riparte dai valori predefiniti.
    const aside = `${file}.rovinato-${Date.now()}`;
    await fs.rename(file, aside).catch(() => {});
    console.warn(`[impostazioni] settings.json non era un JSON valido: spostato in ${path.basename(aside)}, uso i valori predefiniti.`);
    return {};
  }
}

async function writeRaw(obj) {
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw new SettingsError(`Impossibile salvare le impostazioni (${file}): ${err?.message || err}`, { code: 'settings_write', cause: err });
  }
  await fs.chmod(file, 0o600).catch(() => {}); // solo il proprietario può leggere la chiave (dove il sistema lo consente)
}

// Le scritture sono in fila: due salvataggi contemporanei non si sovrascrivono a vicenda.
let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function envKey() {
  const k = normalizeApiKey(process.env.ANTHROPIC_API_KEY || '');
  return k || null;
}

function publicView(raw) {
  const saved = typeof raw.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : null;
  const env = saved ? null : envKey();
  const key = saved || env;
  return {
    hasApiKey: !!key,
    apiKeyHint: key ? maskKey(key) : '',
    apiKeySource: saved ? 'impostazioni' : env ? 'ambiente' : null,
    model: typeof raw.model === 'string' && MODEL_RE.test(raw.model.trim()) ? raw.model.trim() : DEFAULT_MODEL,
    theme: resolveTheme(raw.theme),
  };
}

// --------------------------------------------------------------------------------- API pubblica

export async function getSettings() {
  return publicView(await readRaw());
}

export async function saveSettings(partial = {}) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new SettingsError('Impostazioni non valide.', { code: 'settings_invalid' });
  }
  // Validazione prima di toccare il file.
  let apiKey;
  if (partial.apiKey !== undefined) apiKey = partial.apiKey === null || normalizeApiKey(partial.apiKey) === '' ? null : validateApiKey(partial.apiKey);

  let model;
  if (partial.model !== undefined) {
    const m = partial.model === null ? '' : String(partial.model).trim();
    if (m && !MODEL_RE.test(m)) throw new SettingsError(`Nome del modello non valido: «${m.slice(0, 60)}». Esempio: ${DEFAULT_MODEL}.`, { code: 'model_invalid' });
    model = m || null;
  }

  let theme;
  if (partial.theme !== undefined) {
    if (partial.theme === null) theme = null;
    else if (typeof partial.theme !== 'object' || Array.isArray(partial.theme)) throw new SettingsError('Tema non valido.', { code: 'theme_invalid' });
    else {
      theme = {};
      for (const [k, v] of Object.entries(partial.theme)) {
        if (!(k in DEFAULT_THEME)) continue; // chiavi sconosciute ignorate
        const c = normalizeColor(v);
        if (!c) throw new SettingsError(`Colore non valido per «${k}»: usa il formato #RRGGBB (es. #FF7E00).`, { code: 'theme_invalid' });
        theme[k] = c;
      }
    }
  }

  return serialized(async () => {
    const raw = await readRaw();
    if (apiKey !== undefined) { if (apiKey) raw.apiKey = apiKey; else delete raw.apiKey; }
    if (model !== undefined) { if (model) raw.model = model; else delete raw.model; }
    if (theme !== undefined) {
      if (theme === null) delete raw.theme;
      else raw.theme = { ...(raw.theme && typeof raw.theme === 'object' ? raw.theme : {}), ...theme };
    }
    await writeRaw(raw);
    return publicView(raw);
  });
}

/** Chiave API vera (solo lato server!). Prima quella salvata in Impostazioni, poi ANTHROPIC_API_KEY. */
export async function getApiKey() {
  const raw = await readRaw();
  const saved = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  return saved || envKey();
}

export async function getModel() {
  return (await getSettings()).model;
}
