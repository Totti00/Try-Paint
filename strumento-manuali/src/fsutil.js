// Scritture su disco sicure anche su Windows: file temporanei con nome unico e rename con nuovi tentativi.
//
//   tmpName(file)                       → "<file>.<uuid>.tmp" (mai uguale tra due scritture simultanee)
//   renameWithRetry(src, dest)          rename che riprova per qualche istante su EPERM/EACCES/EBUSY
//                                       (su Windows antivirus e indicizzatore tengono aperti i file per un attimo)
//   writeFileAtomic(file, data, opts?)  scrive su un file temporaneo e poi lo rinomina al posto di quello vero
//   writeJsonAtomic(file, value, opts?) idem per un JSON (indentato, con a capo finale)

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function tmpName(file) {
  return `${file}.${crypto.randomUUID()}.tmp`;
}

/**
 * Rinomina src in dest; su EPERM/EACCES/EBUSY riprova con attese crescenti (circa 3 s in tutto).
 * @param {{ attempts?: number }} [opts]
 */
export async function renameWithRetry(src, dest, { attempts = 8 } = {}) {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      if (i >= attempts - 1 || !RETRY_CODES.has(err?.code)) throw err;
      await sleep(60 * (i + 1));
    }
  }
}

/**
 * Scrittura atomica: file temporaneo + rename (con nuovi tentativi). In caso di errore il temporaneo viene tolto.
 * @param {{ encoding?: string, mode?: number, fallbackCopy?: boolean, mkdir?: boolean }} [opts]
 *   fallbackCopy: se il rename continua a fallire, scrive direttamente sul file (meglio che perdere i dati)
 *   mkdir: crea la cartella se manca (predefinito); false = errore ENOENT se la cartella non c'è più
 */
export async function writeFileAtomic(file, data, { encoding = 'utf8', mode, fallbackCopy = false, mkdir = true } = {}) {
  if (mkdir) await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  await fs.writeFile(tmp, data, mode !== undefined ? { encoding, mode } : { encoding });
  try {
    await renameWithRetry(tmp, file);
  } catch (err) {
    if (fallbackCopy && RETRY_CODES.has(err?.code)) {
      try {
        await fs.writeFile(file, data, mode !== undefined ? { encoding, mode } : { encoding });
        await fs.rm(tmp, { force: true }).catch(() => {});
        return;
      } catch { /* si segnala l'errore originale */ }
    }
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export function writeJsonAtomic(file, value, opts = {}) {
  return writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', opts);
}
