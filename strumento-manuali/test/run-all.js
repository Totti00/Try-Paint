#!/usr/bin/env node
// Esegue in fila tutti i test (test/test-*.js) e stampa un riepilogo. Esce con codice 1 se uno fallisce.
//
//   node test/run-all.js              (oppure: npm test)
//   node test/run-all.js server pdf   (solo test-server.js e test-pdf.js)
//
// Nessun test chiama Claude: le prove dell'API usano un server finto (test/mock-anthropic.js) o le fixture.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2).map((s) => s.replace(/^test-|\.js$/g, ''));
const files = fs.readdirSync(HERE)
  .filter((f) => /^test-.+\.js$/.test(f))
  .filter((f) => !only.length || only.includes(f.replace(/^test-|\.js$/g, '')))
  .sort();

if (!files.length) {
  console.error(only.length ? `Nessun test corrisponde a: ${only.join(', ')}` : 'Nessun test trovato.');
  process.exit(1);
}

const fmt = (ms) => (ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);

function run(file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(HERE, file)], { stdio: 'inherit', env: process.env });
    child.on('error', (err) => resolve({ file, code: 1, ms: Date.now() - t0, error: err.message }));
    child.on('exit', (code, signal) => resolve({ file, code: code ?? 1, signal, ms: Date.now() - t0 }));
  });
}

const results = [];
const t0 = Date.now();
for (const f of files) {
  console.log(`\n${'='.repeat(78)}\n▶ ${f}\n${'='.repeat(78)}`);
  results.push(await run(f));
}

console.log(`\n${'='.repeat(78)}\nRIEPILOGO\n${'='.repeat(78)}`);
for (const r of results) {
  const status = r.code === 0 ? 'OK     ' : 'FALLITO';
  console.log(`  ${status}  ${r.file.padEnd(22)} ${fmt(r.ms).padStart(12)}${r.signal ? `  (interrotto: ${r.signal})` : ''}${r.error ? `  (${r.error})` : ''}`);
}
const failed = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - failed.length} di ${results.length} file di test superati in ${fmt(Date.now() - t0)}.`);
process.exit(failed.length ? 1 : 0);
