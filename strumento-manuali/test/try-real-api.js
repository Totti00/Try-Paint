#!/usr/bin/env node
// Prova VERA con Claude (serve la chiave API; costa qualche decina di centesimi di dollaro a documento).
// Non fa parte dei test automatici: va lanciata a mano.
//
//   node test/try-real-api.js                                  → manuale di riferimento (Tavolo Levante) + confronto con la scheda scritta a mano
//   node test/try-real-api.js mio-manuale.pdf                  → un altro PDF o .docx
//   node test/try-real-api.js mio-manuale.pdf --pdf            → genera anche il PDF impaginato (out/manuale.pdf)
//   node test/try-real-api.js mio-manuale.pdf --modello tavolo.step   → anche import 3D + piano dell'animazione
//   opzioni: --modello-claude claude-opus-5-5   --cartella /percorso/lavoro
//
// Chiave: quella salvata in Impostazioni dell'app (config/settings.json) oppure la variabile ANTHROPIC_API_KEY.
// Risultati in <tmp>/strumento-manuali-prova-reale/<data-ora>/ (o --cartella): manual.ai.json, manual.json, log.txt,
// ai-usage.json (consumi e costo), eventuali out/manuale.pdf e plan.json.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'tavolo-levante');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && !['--modello', '--modello-claude', '--cartella'].includes(args[i - 1]));
const input = path.resolve(positional[0] || path.join(FIX, 'TAVOLO_LEVANTE_originale.pdf'));
const isReference = path.resolve(input) === path.resolve(path.join(FIX, 'TAVOLO_LEVANTE_originale.pdf'));

function line(msg) {
  if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K${msg}`);
  else console.log(msg);
}

async function main() {
  const { getApiKey, getSettings, maskKey } = await import('../src/settings.js');
  if (process.env.MANUALI_AI_FIXTURE) {
    console.error('MANUALI_AI_FIXTURE è impostata: questa prova deve chiamare Claude davvero. Toglila e riprova.');
    process.exitCode = 2;
    return;
  }
  const key = await getApiKey();
  if (!key) {
    console.error('Manca la chiave API di Claude: inseriscila in Impostazioni nell’app oppure imposta ANTHROPIC_API_KEY.');
    process.exitCode = 2;
    return;
  }
  const settings = await getSettings();
  const model = opt('--modello-claude') || settings.model;
  console.log(`Prova REALE con Claude — modello ${model}, chiave ${maskKey(key)} (${settings.apiKeySource}).`);
  if (process.env.ANTHROPIC_BASE_URL) console.log(`ATTENZIONE: ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL} (non è l’API ufficiale?)`);

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const jobDir = path.resolve(opt('--cartella') || path.join(os.tmpdir(), 'strumento-manuali-prova-reale', stamp));
  await fs.mkdir(path.join(jobDir, 'input'), { recursive: true });
  const local = path.join(jobDir, 'input', path.basename(input));
  await fs.copyFile(input, local);
  console.log(`Documento: ${input}\nCartella del lavoro: ${jobDir}\n`);

  const { ingestDocument, prepareImages } = await import('../src/ingest/index.js');
  const { extractManual } = await import('../src/ai/extract.js');
  const { ManualData } = await import('../src/schema.js');

  const t0 = Date.now();
  const ingest = await ingestDocument(jobDir, local, (p, m) => line(`[lettura ${p}%] ${m || ''}`));
  await prepareImages(jobDir, ingest.catalog, (p, m) => line(`[immagini ${p}%] ${m || ''}`));
  line(`Documento letto: ${ingest.kind.toUpperCase()}, ${ingest.pages.length || '—'} pagine, ${ingest.catalog.length} immagini.\n`);

  const manual = await extractManual(jobDir, ingest, (p, m) => line(`[Claude ${p}%] ${m || ''}`), { model });
  line(`Estrazione completata in ${Math.round((Date.now() - t0) / 1000)} s.\n\n`);

  // --- riepilogo
  console.log(`Titolo: ${manual.document_title} — ${manual.short_name} (${manual.language})`);
  console.log(`Prodotti: ${manual.products.map((p) => `${p.category || '—'}: ${p.names.join(', ')}`).join(' | ')}`);
  console.log(`Ferramenta: ${manual.hardware.map((h) => `${h.id} ${h.name}${h.spec ? ' ' + h.spec : ''} ×${h.qty ?? '?'}`).join('; ')}`);
  console.log(`Componenti: ${manual.components.map((c) => `${c.code} ${c.name} ×${c.qty ?? '?'}`).join('; ')}`);
  console.log(`Copertina: ${manual.cover_image_id ?? '—'}, logo: ${manual.brand_logo_image_id ?? '—'}, immagini non usate: ${manual.unused_image_ids.join(' ') || '—'}`);
  console.log('Passi:');
  for (const s of manual.steps) {
    console.log(`  ${s.number}. ${s.title}  [${s.image_ids.join(' ') || 'nessuna immagine'}]  usa: ${s.uses.map((u) => `${u.ref}×${u.qty ?? '?'}`).join(' ') || '—'}`);
    for (const p of s.paragraphs) console.log(`       ${p}`);
    if (s.warning) console.log(`       ⚠ ${s.warning}`);
  }
  if (manual.notes.length) console.log(`Note: ${manual.notes.map((n) => `${n.label} ${n.title}: ${n.text}`).join(' | ')}`);
  console.log(`Modifiche dichiarate (${manual.changes.length}):`);
  for (const c of manual.changes) console.log(`  - [${c.kind}${c.needs_confirmation ? ', da confermare' : ''}] ${c.description}`);

  const usage = JSON.parse(await fs.readFile(path.join(jobDir, 'ai-usage.json'), 'utf8'));
  const cost = usage.reduce((s, u) => s + (u.cost_usd || 0), 0);
  console.log(`\nConsumi: ${usage.map((u) => `${u.label}: ${u.input_tokens} token in, ${u.output_tokens} out, ${u.model}${u.fallback ? ' (fallback)' : ''}`).join(' | ')}`);
  console.log(`Costo stimato: ${cost.toLocaleString('it-IT', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} $`);

  // --- confronto indicativo con la scheda scritta a mano (solo per il manuale di riferimento)
  if (isReference) {
    const gold = ManualData.parse(JSON.parse(await fs.readFile(path.join(FIX, 'manual.json'), 'utf8')));
    const checks = [
      ['numero di passi', manual.steps.length === gold.steps.length, `${manual.steps.length} vs ${gold.steps.length}`],
      ['copertina', manual.cover_image_id === gold.cover_image_id, `${manual.cover_image_id} vs ${gold.cover_image_id}`],
      ['logo', manual.brand_logo_image_id === gold.brand_logo_image_id, `${manual.brand_logo_image_id} vs ${gold.brand_logo_image_id}`],
      ['quantità ferramenta', JSON.stringify(manual.hardware.map((h) => h.qty)) === JSON.stringify(gold.hardware.map((h) => h.qty)), manual.hardware.map((h) => h.qty).join(',')],
      ['sigle componenti', JSON.stringify(manual.components.map((c) => c.code)) === JSON.stringify(gold.components.map((c) => c.code)), manual.components.map((c) => c.code).join(',')],
      ['incongruenza T1/T2/T3 segnalata', manual.changes.some((c) => c.kind === 'incongruenza' && /T3/.test(c.description)), ''],
      ['prodotti', JSON.stringify(manual.products) === JSON.stringify(gold.products), JSON.stringify(manual.products)],
      ['enfasi «senza serrarle»', manual.steps.some((s) => s.paragraphs.some((p) => /\*\*senza serrarl/i.test(p))), ''],
    ];
    const n = Math.min(manual.steps.length, gold.steps.length);
    let sameImg = 0;
    for (let i = 0; i < n; i++) {
      const a = manual.steps[i].image_ids.map((x) => (x === 'img_08' ? 'img_04' : x));
      const b = gold.steps[i].image_ids.map((x) => (x === 'img_08' ? 'img_04' : x));
      if (JSON.stringify(a) === JSON.stringify(b)) sameImg++;
    }
    checks.push(['immagini dei passi', sameImg === gold.steps.length, `${sameImg}/${gold.steps.length} passi uguali`]);
    console.log('\nConfronto INDICATIVO con la scheda scritta a mano (test/fixtures/tavolo-levante/manual.json):');
    for (const [name, ok, detail] of checks) console.log(`  ${ok ? 'OK  ' : 'DIFF'} ${name}${detail ? ` — ${detail}` : ''}`);
  }

  // --- facoltativo: PDF impaginato
  if (flag('--pdf')) {
    try {
      const { generatePdf } = await import('../src/pdf/generate.js');
      const out = path.join(jobDir, 'out', 'manuale.pdf');
      await fs.mkdir(path.dirname(out), { recursive: true });
      await generatePdf(jobDir, manual, { outPath: out, theme: settings.theme });
      console.log(`\nPDF impaginato: ${out}`);
    } catch (err) {
      console.error(`\nPDF non generato: ${err?.message || err}`);
    }
  }

  // --- facoltativo: modello 3D e piano dell'animazione
  const modelFile = opt('--modello');
  if (modelFile) {
    const { importModel, renderPartViews } = await import('../src/video/model3d.js');
    const { planAnimation } = await import('../src/ai/animate.js');
    const dst = path.join(jobDir, 'modello', path.basename(modelFile));
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(path.resolve(modelFile), dst);
    const { parts } = await importModel(jobDir, dst, (p, m) => line(`[modello 3D ${p}%] ${m || ''}`));
    const views = await renderPartViews(jobDir, parts, { max: 24, onProgress: (p, m) => line(`[viste ${p}%] ${m || ''}`) });
    const plan = await planAnimation(jobDir, manual, parts, (p, m) => line(`[piano ${p}%] ${m || ''}`), { views, model });
    line(`Piano dell’animazione: ${plan.steps.length} passi, ${plan.parts.length} parti con ruolo (plan.json).\n`);
    for (const s of plan.steps) console.log(`  ${s.number}. ${s.caption_title} — ${s.actions.map((a) => `${a.type}(${a.keys.length})`).join(' ')}`);
  }
  console.log(`\nFile del lavoro: ${jobDir}`);
}

process.on('unhandledRejection', (err) => { console.error('\nErrore non gestito:', err); process.exitCode = 1; });
main().catch((err) => {
  console.error(`\n\nERRORE: ${err?.message || err}${err?.code ? ` [${err.code}]` : ''}`);
  process.exitCode = 1;
});
