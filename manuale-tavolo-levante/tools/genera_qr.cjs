// Crea il QR code del video di montaggio (SVG vettoriale, nitido in stampa) per la pagina 2 del manuale.
//
// Uso (dalla cartella manuale-tavolo-levante):
//   node tools/genera_qr.cjs <link del video>     es. https://youtu.be/abcdefghijk
//   node tools/genera_qr.cjs                      ricrea il QR dal link già salvato in tools/video_url.txt
//
// Scrive assets/final/qr_video.svg e salva il link in tools/video_url.txt (l’unico posto dove sta il link:
// genera_pdf.cjs lo legge da lì anche per il testo stampato sotto il titolo del riquadro).
// Correzione d’errore M (15%), margine bianco di 4 moduli. Usa il pacchetto npm "qrcode" (MIT) installato
// in ../strumento-manuali (npm install) oppure, se c’è, quello del sistema.
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const ROOT = path.resolve(__dirname, "..");
const URL_FILE = path.join(__dirname, "video_url.txt");
const SVG_FILE = path.join(ROOT, "assets", "final", "qr_video.svg");
const PLACEHOLDER = "https://esempio.it/video-montaggio-tavolo-levante";

function loadQrcode() {
  try {
    return require("qrcode");
  } catch {
    try {
      return createRequire(path.resolve(ROOT, "..", "strumento-manuali", "package.json"))("qrcode");
    } catch {
      throw new Error('Manca il pacchetto "qrcode": esegui "npm install" nella cartella strumento-manuali.');
    }
  }
}

/** Link valido: http/https, al massimo 500 caratteri. Restituisce il link pulito o lancia un errore in italiano. */
function checkUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) throw new Error("Manca il link del video.");
  if (s.length > 500) throw new Error("Il link è troppo lungo (massimo 500 caratteri).");
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`«${s}» non è un link valido: deve iniziare con https:// (o http://).`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Il link deve iniziare con https:// (o http://).");
  if (!u.hostname.includes(".") && u.hostname !== "localhost") throw new Error(`«${s}» non sembra un indirizzo web completo.`);
  return s;
}

const escXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

(async () => {
  let url = process.argv[2];
  if (!url) {
    if (!fs.existsSync(URL_FILE)) {
      console.error("Uso: node tools/genera_qr.cjs <link del video>   (es. https://youtu.be/abcdefghijk)");
      process.exit(2);
    }
    url = fs.readFileSync(URL_FILE, "utf8").trim();
  }
  url = checkUrl(url);

  const QRCode = loadQrcode();
  const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
  let svg = await QRCode.toString(url, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 4,
    color: { dark: "#1f1c1aff", light: "#ffffffff" },
  });
  // il link resta scritto nel file (genera_pdf.cjs controlla che QR e link coincidano)
  svg = svg.replace(/^<svg ([^>]*)>/, `<svg $1><title>Video di montaggio</title><desc>${escXml(url)}</desc>`);

  fs.mkdirSync(path.dirname(SVG_FILE), { recursive: true });
  fs.writeFileSync(SVG_FILE, svg);
  fs.writeFileSync(URL_FILE, url + "\n");

  const modules = qr.modules.size + 8;
  console.log(`QR creato: ${path.relative(ROOT, SVG_FILE)}  (versione ${qr.version}, ${modules}×${modules} moduli con il margine)`);
  console.log(`Link: ${url}`);
  if (url === PLACEHOLDER) {
    console.log("ATTENZIONE: è il link SEGNAPOSTO. genera_pdf.cjs non lo stampa nel manuale (solo con --anteprima).");
  } else {
    console.log("Ora: node tools/genera_pdf.cjs");
  }
})().catch((e) => {
  console.error("Errore: " + (e?.message || e));
  process.exit(1);
});
