// QR code del video di montaggio (pagina 2 del PDF): controllo del link e SVG vettoriale.
// Pacchetto npm "qrcode" (MIT), caricato solo quando serve (il server parte anche se manca: il PDF esce senza QR,
// con un avviso). Correzione d'errore M (15%), margine bianco di 4 moduli.

export const VIDEO_URL_MAX = 500;

export class VideoUrlError extends Error {}

/**
 * Link del video come lo scrive l'utente → link pulito, o null se vuoto.
 * Lancia VideoUrlError (messaggio in italiano) se non è un indirizzo http/https valido o supera 500 caratteri.
 */
export function normalizeVideoUrl(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new VideoUrlError('Il link del video deve essere un testo.');
  const s = raw.trim();
  if (!s) return null;
  if (s.length > VIDEO_URL_MAX) throw new VideoUrlError(`Il link del video è troppo lungo: al massimo ${VIDEO_URL_MAX} caratteri.`);
  if (/\s/.test(s)) throw new VideoUrlError('Il link del video non può contenere spazi: copialo di nuovo dalla barra degli indirizzi.');
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new VideoUrlError('Il link del video non è valido: deve iniziare con https:// (es. https://youtu.be/…).');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new VideoUrlError('Il link del video deve iniziare con https:// (o http://).');
  if (!u.hostname || (!u.hostname.includes('.') && u.hostname !== 'localhost')) throw new VideoUrlError('Il link del video non sembra un indirizzo web completo (es. https://youtu.be/…).');
  if (u.username || u.password) throw new VideoUrlError('Il link del video non può contenere nome utente o password.');
  return s;
}

/** Link da stampare sotto il QR: senza https:// e www.; quelli molto lunghi accorciati (il QR contiene sempre il link intero). */
export function shortUrl(url) {
  const s = String(url).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  return s.length > 140 ? `${s.slice(0, 137)}…` : s;
}

/**
 * SVG del QR (una sola <path>, niente immagini raster) + dati per l'impaginazione.
 * sizeMm: lato stampato (32 mm; un po' di più per i link lunghi, così i moduli restano ≥ 0,5 mm).
 * @returns {Promise<{ svg: string, version: number, modules: number, sizeMm: number }>}
 */
export async function buildQrSvg(url, { dark = '#1F1C1A' } = {}) {
  let QRCode;
  try {
    ({ default: QRCode } = await import('qrcode'));
  } catch (err) {
    throw new Error('manca il componente «qrcode»: chiudi lo strumento e avvialo di nuovo con lo script di avvio (oppure esegui "npm install").', { cause: err });
  }
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const modules = qr.modules.size + 8;
  let svg = await QRCode.toString(url, {
    type: 'svg', errorCorrectionLevel: 'M', margin: 4,
    color: { dark: `${dark}ff`, light: '#ffffffff' },
  });
  svg = svg.replace(/^<svg /, '<svg class="qr-svg" role="img" aria-label="QR code del video di montaggio" ');
  const sizeMm = Math.min(42, Math.max(32, Math.round(modules * 0.5)));
  return { svg, version: qr.version, modules, sizeMm };
}
