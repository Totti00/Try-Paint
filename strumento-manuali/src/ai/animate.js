// Piano dell'animazione 3D (AnimationPlan) con Claude.
//
//   planAnimation(jobDir, manual, parts, onProgress, { views, signal, model, baseURL }?) → AnimationPlan (riparato)
//     manual: ManualData (se null si legge manual.json); parts: PartsSummary (se null si legge parts.json);
//     views: [{ key, label, file|path, keys? }] da renderPartViews (PNG allegati come immagini etichettate).
//     Scrive plan.ai.json (risposta di Claude validata) e plan.json (dopo la riparazione).
//   buildAnimateContent(jobDir, manual, parts, views, meta) → { content, stats }
//
// Modalità test: MANUALI_PLAN_FIXTURE=/percorso/plan.json → nessuna chiamata a Claude, si usa quel file.

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { AnimationPlan, ManualData } from '../schema.js';
import { callStructuredDetailed, AiError } from './client.js';
import { repairPlan } from './repair.js';
import { appendJobLog, formatInt } from './log.js';
import { loadPrompt } from './extract.js';
import { writeJsonAtomic } from '../fsutil.js';

const MAX_VIEWS = 40;

function makeProgress(onProgress) {
  let last = 0;
  return (pct, message) => {
    if (typeof onProgress !== 'function') return;
    if (typeof pct === 'number' && Number.isFinite(pct)) last = Math.max(last, Math.min(100, Math.round(pct)));
    try {
      const r = onProgress(last, message);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* il callback non deve fermare il lavoro */ }
  };
}

async function readJsonIf(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

async function writeJson(file, data) {
  await writeJsonAtomic(file, data);
}

const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : v);
const vec = (a) => (Array.isArray(a) ? `[${a.map(r1).join(', ')}]` : 'n/d');

/** Indizi di forma calcolati dalle misure (aiutano Claude a riconoscere aste, lastre e minuteria). */
function shapeHint(size, modelMax) {
  if (!Array.isArray(size) || size.length !== 3 || !size.every(Number.isFinite)) return '';
  const axes = ['X', 'Y', 'Z'];
  const order = [0, 1, 2].sort((a, b) => size[b] - size[a]);
  const [L, M, S] = order.map((i) => size[i]);
  const hints = [];
  if (modelMax > 0 && L < 0.06 * modelMax) hints.push('minuteria');
  if (L > 0 && M > 0 && L / M >= 3.5) hints.push(`asta lungo ${axes[order[0]]}`);
  else if (M > 0 && S / M <= 0.2) hints.push(`lastra sottile in ${axes[order[2]]}`);
  return hints.join(', ');
}

/** Riepilogo leggibile del modello: gruppi di pezzi identici + una riga JSON per parte. */
function partsSummaryText(parts, meta) {
  const all = parts.filter((p) => p && typeof p.key === 'string');
  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  for (const p of all) for (let i = 0; i < 3; i++) {
    if (Array.isArray(p.bbox_min) && Number.isFinite(p.bbox_min[i])) mins[i] = Math.min(mins[i], p.bbox_min[i]);
    if (Array.isArray(p.bbox_max) && Number.isFinite(p.bbox_max[i])) maxs[i] = Math.max(maxs[i], p.bbox_max[i]);
  }
  const total = mins.every(Number.isFinite) ? maxs.map((v, i) => v - mins[i]) : null;
  const modelMax = total ? Math.max(...total) : 0;
  const groups = new Map();
  for (const p of all) {
    const g = p.similar_group ?? p.key;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  const lines = [];
  lines.push('Riepilogo del modello 3D (PartsSummary, coordinate normalizzate: mm, Y in alto, a terra, centrato in X/Z).');
  if (meta?.size_text) lines.push(`Dimensioni complessive: ${meta.size_text}.`);
  else if (total) lines.push(`Dimensioni complessive: ${total.map((v) => formatInt(v)).join(' × ')} mm (X × Y × Z).`);
  const up = meta?.up_axis_in_source === 'z' ? 'z' : 'y';
  lines.push(`Asse verticale nel file originale (deciso dal caricatore): ${up}${meta?.up_axis_reason ? ` — ${meta.up_axis_reason}` : ''}. Usa up_axis_in_source = "${up}".`);
  lines.push(`Parti: ${all.length}; gruppi di pezzi identici: ${groups.size}.`);
  lines.push('');
  lines.push('Gruppi (pezzi identici; misure di un pezzo [x, y, z] mm; indizi automatici):');
  for (const [g, list] of groups) {
    const s = list[0].size;
    const hint = shapeHint(s, modelMax);
    const names = [...new Set(list.map((p) => p.name).filter(Boolean))].slice(0, 3).map((n) => `"${n}"`).join(', ');
    lines.push(`- gruppo ${g}: ${list.length} ${list.length === 1 ? 'pezzo' : 'pezzi'}, misure ${vec(s)}${hint ? `, ${hint}` : ''}${names ? `, nomi ${names}` : ''} — ${list.map((p) => p.key).join(' ')}`);
  }
  lines.push('');
  lines.push('Parti (una per riga):');
  for (const p of all) {
    lines.push(JSON.stringify({
      key: p.key, name: p.name ?? '', group: p.similar_group ?? null,
      size: (p.size || []).map(r1), center: (p.center || []).map(r1),
      bbox_min: (p.bbox_min || []).map(r1), bbox_max: (p.bbox_max || []).map(r1), triangles: p.triangles ?? null,
    }));
  }
  return lines.join('\n');
}

/** Solo ciò che serve a Claude per il piano (testi, passi, sigle, quantità). */
function manualForPlan(m) {
  return {
    language: m.language,
    document_title: m.document_title,
    short_name: m.short_name,
    products: m.products,
    hardware: m.hardware.map(({ id, name, spec, qty }) => ({ id, name, spec, qty })),
    components: m.components.map(({ code, name, qty }) => ({ code, name, qty })),
    phases: m.phases,
    steps: m.steps.map(({ number, title, paragraphs, uses, warning }) => ({ number, title, paragraphs, uses, warning })),
    notes: m.notes.map(({ label, title, text }) => ({ label, title, text })),
  };
}

async function viewBlock(jobDir, v) {
  const file = v.path || (v.file ? path.join(jobDir, ...String(v.file).split('/')) : null);
  if (!file) throw new Error('vista senza file');
  let buf = await fs.readFile(file);
  let media = file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const meta = await sharp(buf).metadata();
  if (buf.length > 900 * 1024 || (meta.width || 0) > 1024 || (meta.height || 0) > 1024) {
    buf = await sharp(buf).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
    media = 'image/jpeg';
  }
  return { type: 'image', source: { type: 'base64', media_type: media, data: buf.toString('base64') } };
}

export async function buildAnimateContent(jobDir, manual, parts, views = [], meta = null) {
  const content = [];
  const stats = { parts: parts.length, views: 0, skippedViews: 0 };
  content.push({ type: 'text', text: `Scheda del manuale (ManualData):\n${JSON.stringify(manualForPlan(manual), null, 1)}` });
  content.push({ type: 'text', text: partsSummaryText(parts, meta) });
  const list = Array.isArray(views) ? views.slice(0, MAX_VIEWS) : [];
  if (list.length) {
    content.push({ type: 'text', text: 'Viste del modello: in ogni vista le parti indicate sono evidenziate in arancio, il resto è grigio chiaro.' });
    for (const v of list) {
      const label = `Vista «${v.label || v.key || 'modello'}»${Array.isArray(v.keys) && v.keys.length ? ` — parti evidenziate: ${v.keys.slice(0, 30).join(' ')}${v.keys.length > 30 ? '…' : ''}` : v.key ? ` — ${v.key}` : ''}`;
      try {
        const block = await viewBlock(jobDir, v);
        content.push({ type: 'text', text: label });
        content.push(block);
        stats.views++;
      } catch (err) {
        stats.skippedViews++;
        await appendJobLog(jobDir, `vista ${v.key || v.label || '?'} non allegata a Claude: ${err?.message || err}`);
      }
    }
  }
  const keys = parts.map((p) => p.key);
  const refs = [...manual.components.map((c) => c.code), ...manual.hardware.map((h) => h.id)].filter(Boolean);
  content.push({
    type: 'text',
    text: 'Scrivi ora il piano dell’animazione (AnimationPlan) seguendo tutte le regole.\n' +
      `Chiavi valide (${keys.length}): ${keys.join(' ')}.\nSigle valide: ${refs.join(', ') || '(nessuna)'}.`,
  });
  return { content, stats };
}

/**
 * @param {string} jobDir
 * @param {object|null} manual   ManualData
 * @param {object[]|null} parts  PartsSummary
 * @param {(pct:number, message:string)=>void} [onProgress]
 * @param {{ views?: object[], signal?: AbortSignal, model?: string, baseURL?: string, apiKey?: string }} [options]
 */
export async function planAnimation(jobDir, manual, parts, onProgress, options = {}) {
  if (!jobDir) throw new TypeError('planAnimation: cartella del lavoro obbligatoria.');
  const { views = [] } = options || {};
  const progress = makeProgress(onProgress);
  const log = (m) => appendJobLog(jobDir, m);

  if (!manual) manual = await readJsonIf(path.join(jobDir, 'manual.json'));
  const mr = ManualData.safeParse(manual);
  if (!mr.success) throw new AiError('La scheda del manuale manca o non è valida: completa prima la revisione.', { code: 'manual_invalid' });
  manual = mr.data;
  if (!Array.isArray(parts) || !parts.length) parts = await readJsonIf(path.join(jobDir, 'parts.json'));
  if (!Array.isArray(parts) || !parts.length) throw new AiError('Mancano le parti del modello 3D (parts.json): carica di nuovo il modello.', { code: 'parts_missing' });
  const meta = await readJsonIf(path.join(jobDir, 'model.meta.json'));
  const upAxis = meta?.up_axis_in_source === 'z' || meta?.up_axis_in_source === 'y' ? meta.up_axis_in_source : null;

  const finish = async (raw) => {
    const { plan, repairs, warnings } = repairPlan(raw, parts, manual, { upAxis });
    for (const r of repairs) await log(`piano — riparazione: ${r}`);
    for (const w of warnings) await log(`piano — avviso: ${w}`);
    await writeJson(path.join(jobDir, 'plan.ai.json'), raw);
    await writeJson(path.join(jobDir, 'plan.json'), plan);
    return plan;
  };

  // --- modalità test
  const fixture = process.env.MANUALI_PLAN_FIXTURE;
  if (fixture) {
    progress(10, 'MODALITÀ TEST: lettura del piano di prova (nessuna chiamata a Claude)…');
    await log(`MODALITÀ TEST: piano dell’animazione letto da ${fixture} — nessuna chiamata a Claude (MANUALI_PLAN_FIXTURE)`);
    let json;
    try {
      json = JSON.parse(await fs.readFile(fixture, 'utf8'));
    } catch (err) {
      throw new AiError(`MODALITÀ TEST: non riesco a leggere il piano di prova ${fixture}: ${err?.message || err}`, { code: 'fixture_invalid', cause: err });
    }
    const r = AnimationPlan.safeParse(json);
    if (!r.success) {
      const why = r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(radice)'}: ${i.message}`).join('; ');
      throw new AiError(`MODALITÀ TEST: il piano di prova ${path.basename(fixture)} non è valido (${why}).`, { code: 'fixture_invalid' });
    }
    const plan = await finish(r.data);
    progress(100, `MODALITÀ TEST: piano pronto (${plan.steps.length} passi).`);
    return plan;
  }

  progress(3, 'Preparazione del modello per Claude…');
  const system = await loadPrompt('animate');
  const { content, stats } = await buildAnimateContent(jobDir, manual, parts, views, meta);
  await log(`piano dell’animazione: ${stats.parts} parti, ${stats.views} viste allegate${stats.skippedViews ? `, ${stats.skippedViews} non allegate` : ''}`);
  const onCall = (_pct, message, info) => {
    let pct = null;
    if (info?.phase === 'writing') pct = 40 + 52 * (1 - Math.exp(-(info.outputTokens || 0) / 4000));
    else if (info?.phase === 'thinking' || info?.phase === 'reading') pct = 10 + 30 * (1 - Math.exp(-(info.elapsedMs || 0) / 120000));
    else if (info) pct = 10;
    progress(pct, message);
  };
  progress(10, 'Invio del modello a Claude…');
  const res = await callStructuredDetailed({
    system,
    content,
    schema: AnimationPlan,
    maxTokens: 64000,
    effort: 'high',
    onProgress: onCall,
    jobDir,
    label: 'piano animazione',
    signal: options.signal,
    model: options.model,
    baseURL: options.baseURL,
    apiKey: options.apiKey,
  });
  progress(95, 'Controllo del piano…');
  const plan = await finish(res.data);
  await log(`piano pronto: ${plan.steps.length} passi, ${plan.parts.length} parti con ruolo — costo ${res.costText}`);
  progress(100, `Piano dell’animazione pronto (${plan.steps.length} passi, costo stimato ${res.costText}).`);
  return plan;
}
