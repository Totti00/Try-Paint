// Genera il PDF del manuale da manuale.html con Chromium (Playwright).
// Uso (dalla cartella manuale-tavolo-levante):  node tools/genera_pdf.cjs [output.pdf]
const path = require("path");
const { chromium } = require("playwright");

(async () => {
  const root = path.resolve(__dirname, "..");
  const out = path.resolve(root, process.argv[2] || "Istruzioni_Montaggio_Tavolo_Levante.pdf");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("file://" + path.join(root, "manuale.html"), { waitUntil: "load" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((im) => (im.complete ? 0 : new Promise((r) => (im.onload = im.onerror = r)))));
  });
  const missing = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute("src")));
  if (missing.length) throw new Error("Immagini mancanti: " + missing.join(", "));
  await page.pdf({ path: out, preferCSSPageSize: true, printBackground: true });
  await browser.close();
  console.log("PDF creato:", out);
})().catch((e) => { console.error(e); process.exit(1); });
