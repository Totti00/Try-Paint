// Ingest del documento caricato: PDF (pdf.js) o Word .docx (mammoth).
// ingestDocument(jobDir, inputPath, onProgress, { signal }?) → { kind, catalog, pages, html, pdfPath, warnings, scanned }
// signal (AbortSignal, facoltativo): annullando, la lettura si ferma alla pagina/immagine successiva (errore AbortError).
// Scrive estratte/img_XX.png, estratte/catalog.json (ImageCatalog), estratte/text.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { IngestError, sniffFile, throwIfAborted } from './common.js';
import { ingestPdf } from './pdf.js';
import { ingestDocx } from './docx.js';

export { IngestError } from './common.js';
export { prepareImages } from './images.js';

export async function ingestDocument(jobDir, inputPath, onProgress, { signal } = {}) {
  throwIfAborted(signal);
  if (!jobDir || !inputPath) throw new IngestError('ingestDocument: cartella del lavoro e file sono obbligatori.', { code: 'bad_args' });
  let stat;
  try {
    stat = await fs.stat(inputPath);
  } catch (err) {
    throw new IngestError(`File non trovato: ${path.basename(inputPath)}.`, { code: 'not_found', cause: err });
  }
  if (!stat.isFile() || stat.size === 0) throw new IngestError('Il file caricato è vuoto.', { code: 'empty_file' });

  const ext = path.extname(inputPath).toLowerCase();
  const sniff = await sniffFile(inputPath);

  if (sniff === 'pdf') return ingestPdf(jobDir, inputPath, onProgress, { signal });
  if (sniff === 'zip') {
    if (ext === '.odt') throw new IngestError('I documenti OpenDocument (.odt) non sono supportati: salvalo come Word (.docx) o esportalo in PDF.', { code: 'unsupported_odt' });
    if (ext === '.pages') throw new IngestError('I documenti Pages non sono supportati: esportalo in Word (.docx) o in PDF.', { code: 'unsupported_pages' });
    if (ext === '.docm' || ext === '.dotx' || ext === '.docx' || ext === '') return ingestDocx(jobDir, inputPath, onProgress, { signal });
    throw new IngestError(`Tipo di file non supportato (${ext || 'senza estensione'}): carica un PDF o un documento Word (.docx).`, { code: 'unsupported' });
  }
  if (sniff === 'cfb') {
    if (ext === '.docx') {
      throw new IngestError('Il documento Word è protetto da password: rimuovi la protezione in Word (File › Informazioni › Proteggi documento) e caricalo di nuovo.', { code: 'docx_password' });
    }
    throw new IngestError('Il formato Word 97-2003 (.doc) non è supportato: aprilo in Word e salvalo come .docx, oppure esportalo in PDF.', { code: 'unsupported_doc' });
  }
  if (sniff === 'rtf') throw new IngestError('I file RTF non sono supportati: salvalo come Word (.docx) o esportalo in PDF.', { code: 'unsupported_rtf' });
  if (ext === '.pdf') throw new IngestError('Il file ha estensione .pdf ma non è un PDF valido (forse è danneggiato o scaricato in modo incompleto).', { code: 'pdf_corrupt' });
  if (ext === '.docx') throw new IngestError('Il file ha estensione .docx ma non è un documento Word valido.', { code: 'docx_invalid' });
  throw new IngestError(`Tipo di file non supportato (${ext || 'senza estensione'}): carica un PDF o un documento Word (.docx).`, { code: 'unsupported' });
}
