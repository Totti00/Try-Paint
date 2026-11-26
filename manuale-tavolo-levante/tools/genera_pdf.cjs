// Genera il PDF del manuale da manuale.html con Chromium (Playwright).
// Uso (dalla cartella manuale-tavolo-levante):  node tools/genera_pdf.cjs [--anteprima] [output.pdf]
//
// QR code del video (pagina 2): il link sta in tools/video_url.txt (lo scrive tools/genera_qr.cjs).
// Finché il link è quello segnaposto (o manca) il riquadro del QR viene tolto e la pagina 2 resta com’era;
// con --anteprima il riquadro si stampa anche con il link segnaposto (solo per vedere l’impaginazione).
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const PLACEHOLDER = "https://esempio.it/video-montaggio-tavolo-levante";

/** Link da stampare sotto il QR: senza https:// e www. */
const shortUrl = (u) => u.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
const unescXml = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

(async () => {
  const root = path.resolve(__dirname, "..");
  const args = process.argv.slice(2);
  const preview = args.includes("--anteprima");
  const outArg = args.find((a) => !a.startsWith("--"));
  const out = path.resolve(root, outArg || "Istruzioni_Montaggio_Tavolo_Levante.pdf");

  const urlFile = path.join(__dirname, "video_url.txt");
  const videoUrl = fs.existsSync(urlFile) ? fs.readFileSync(urlFile, "utf8").trim() : "";
  const placeholder = !videoUrl || videoUrl === PLACEHOLDER;
  const withQr = !!videoUrl && (!placeholder || preview);
  if (withQr) {
    const svgFile = path.join(root, "assets", "final", "qr_video.svg");
    const svg = fs.existsSync(svgFile) ? fs.readFileSync(svgFile, "utf8") : "";
    const inSvg = unescXml((/<desc>([^<]*)<\/desc>/.exec(svg) || [])[1] || "");
    if (inSvg !== videoUrl) throw new Error("Il QR code non corrisponde al link in tools/video_url.txt: esegui prima  node tools/genera_qr.cjs <link>");
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("file://" + path.join(root, "manuale.html"), { waitUntil: "load" });
  await page.evaluate(({ withQr, text }) => {
    for (const box of document.querySelectorAll(".qr-box")) {
      const pg = box.closest(".page");
      if (withQr) box.querySelectorAll("[data-video-url]").forEach((el) => (el.textContent = text));
      else { box.remove(); pg.classList.remove("has-qr"); }
    }
  }, { withQr, text: shortUrl(videoUrl) });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((im) => (im.complete ? 0 : new Promise((r) => (im.onload = im.onerror = r)))));
  });
  const missing = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute("src")));
  if (missing.length) throw new Error("Immagini mancanti: " + missing.join(", "));
  await page.emulateMedia({ media: "print" });
  // niente deve uscire dall’area utile delle pagine interne
  const overflow = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".page").forEach((p, i) => {
      const c = p.querySelector(".content");
      if (!c) return;
      const cr = c.getBoundingClientRect();
      for (const el of c.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.bottom > cr.bottom + 0.5 || r.right > cr.right + 0.5 || r.left < cr.left - 0.5 || r.top < cr.top - 0.5) {
          out.push(`pagina ${i + 1}: <${el.tagName.toLowerCase()} class="${el.getAttribute("class") || ""}">`);
          break;
        }
      }
    });
    return out;
  });
  if (overflow.length) throw new Error("Contenuto fuori dall’area utile:\n  " + overflow.join("\n  "));
  await page.pdf({ path: out, preferCSSPageSize: true, printBackground: true });
  await browser.close();
  console.log("PDF creato:", out);
  if (withQr && placeholder) console.log("ANTEPRIMA: il QR code a pagina 2 punta al link SEGNAPOSTO " + videoUrl);
  else if (withQr) console.log("QR code del video a pagina 2: " + videoUrl);
  else console.log("QR code del video non incluso (manca il link vero): node tools/genera_qr.cjs <link> && node tools/genera_pdf.cjs");
})().catch((e) => { console.error(e?.message || e); process.exit(1); });
