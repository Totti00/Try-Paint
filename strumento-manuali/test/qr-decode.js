// Lettura di un QR code da un PNG, per i test (pagina 2 del PDF con il QR del video).
//
//   decodeQrPng(file) → testo del QR | null (QR non letto) | undefined (nessun lettore disponibile)
//   renderPdfPage(pdf, n, outPrefix) → PNG a 150 dpi della pagina n (pdftoppm), oppure null se manca poppler
//
// Lettori, nell'ordine: pacchetto npm "jsqr" (devDependency), poi Python con OpenCV (cv2), poi zbarimg.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

const PY = `
import sys, cv2
img = cv2.imread(sys.argv[1])
val = cv2.QRCodeDetector().detectAndDecode(img)[0]
if not val and hasattr(cv2, 'QRCodeDetectorAruco'):
    val = cv2.QRCodeDetectorAruco().detectAndDecode(img)[0]
sys.stdout.write(val or '')
`;

export async function decodeQrPng(file) {
  let jsQR = null;
  try { ({ default: jsQR } = await import('jsqr')); } catch { /* non installato */ }
  if (jsQR) {
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const r = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height);
    return r ? r.data : null;
  }
  const py = spawnSync('python3', ['-c', PY, file], { encoding: 'utf8' });
  if (py.status === 0) return py.stdout || null;
  const zb = spawnSync('zbarimg', ['--quiet', '--raw', file], { encoding: 'utf8' });
  if (!zb.error) return zb.status === 0 ? zb.stdout.trim() || null : null;
  return undefined;
}

export function renderPdfPage(pdf, n, outPrefix) {
  const r = spawnSync('pdftoppm', ['-r', '150', '-f', String(n), '-l', String(n), '-png', '-singlefile', pdf, outPrefix], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const file = `${outPrefix}.png`;
  return fs.existsSync(file) ? file : null;
}
