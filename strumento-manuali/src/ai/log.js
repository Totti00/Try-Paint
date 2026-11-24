// Registro del lavoro per i moduli AI: righe in <jobDir>/log.txt e consumi in <jobDir>/ai-usage.json.
// Mai segreti nel registro: qui arrivano solo messaggi già puliti (nessuna chiave API).
import fs from 'node:fs/promises';
import path from 'node:path';

// useGrouping 'always': "3.200" (l'italiano di ICU di suo non raggruppa i numeri di 4 cifre).
const fmtInt = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0, useGrouping: 'always' });

export const formatInt = (n) => fmtInt.format(Math.round(Number(n) || 0));

/** Aggiunge una riga a log.txt (best effort: un errore di scrittura non deve fermare il lavoro). */
export async function appendJobLog(jobDir, message) {
  if (!jobDir) return;
  const lines = String(message).split(/\r?\n/).map((l) => `[${new Date().toISOString()}] [ai] ${l}`);
  try {
    await fs.mkdir(jobDir, { recursive: true });
    await fs.appendFile(path.join(jobDir, 'log.txt'), lines.join('\n') + '\n', 'utf8');
  } catch {
    /* il registro è facoltativo */
  }
}

// Scritture di ai-usage.json in fila, per non perdere righe con chiamate ravvicinate.
let usageQueue = Promise.resolve();

/** Aggiunge un record di consumo ad ai-usage.json (array). */
export function recordUsage(jobDir, record) {
  if (!jobDir) return Promise.resolve();
  const run = usageQueue.then(async () => {
    const file = path.join(jobDir, 'ai-usage.json');
    let list = [];
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      if (Array.isArray(parsed)) list = parsed;
    } catch { /* file assente o rovinato: si riparte */ }
    list.push({ at: new Date().toISOString(), ...record });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.mkdir(jobDir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, file);
  }).catch(() => {});
  usageQueue = run;
  return run;
}
