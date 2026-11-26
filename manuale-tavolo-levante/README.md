# Istruzioni di montaggio: Tavolo Levante

Nuova impaginazione del manuale di montaggio dei **Tavoli Levante, Libeccio e Maestrale** e delle **Panche Gradisca e Volpina**. Il punto di partenza è il PDF originale fatto con Google Documenti.

| File | Cosa contiene |
|---|---|
| `Istruzioni_Montaggio_Tavolo_Levante.pdf` | **Il manuale finito** (A4, 8 pagine, pronto per stampa e invio) |
| `originale/TAVOLO_LEVANTE_originale.pdf` | Il PDF originale, come riferimento |
| `manuale.html` + `manuale.css` | Sorgente del manuale: testi e impaginazione |
| `assets/estratte/` | Immagini estratte così come sono dal PDF originale |
| `assets/img/` → `assets/img2x/` → `assets/final/` | Immagini rifilate → ingrandite 2× (super-resolution EDSR) → versioni finali con sfondo bianco puro |
| `assets/fonts/` | Font Barlow (licenza libera SIL OFL) |
| `tools/` | Script per rigenerare immagini, QR code e PDF |
| `tools/video_url.txt` | Link del video di montaggio usato per il QR code (lo scrive `tools/genera_qr.cjs`) |
| `assets/final/qr_video.svg` | QR code del video (vettoriale), stampato in fondo alla pagina 2 |
| `video/montaggio-tavolo-levante.mp4` | **Video di montaggio** (1920×1080, 30 fps, 96 s, didascalie in italiano) |
| `video/montaggio-tavolo-levante-720p.mp4` | Versione leggera (4 MB) da mandare su WhatsApp/email |
| `video/` | Sorgente dell'animazione 3D (vedi `video/README.md`) |

## Struttura del nuovo manuale

1. **Copertina**: titolo, elenco dei prodotti (tavoli / panche), immagine del prodotto
2. **Contenuto della confezione**: ferramenta con quantità e componenti F1, T1, T2, P1; in fondo il **QR code del video di montaggio** (quando c’è il link, vedi sotto)
3. **Sequenza di montaggio**: panoramica dei 7 passi, divisi in due fasi
4. **Passi 1–2**: fianchi speculari, inserimento dei traversi superiori
5. **Passi 3–4**: viti senza serraggio, traverso inferiore
6. **Passi 5–6**: serraggio delle 10 viti, struttura sul piano
7. **Passo 7 + N.B.**: fissaggio del piano, nota su panche Gradisca e Volpina
8. **Retro**: marchi del gruppo

## Interventi sui contenuti (rispetto all'originale)

I testi sono quelli dell'originale. Sono passati dal tutto maiuscolo al maiuscolo/minuscolo normale e hanno solo piccole correzioni di forma. In più:

- **Sigle dei traversi uniformate.** Nell'originale la pagina dei componenti chiamava T2 i traversi superiori e T3 quello inferiore, mentre le istruzioni usavano T1 e T2. Ora è **T1 = traversi superiori** e **T2 = traverso inferiore** ovunque.
- **Titoli brevi per ogni passo**, ricavati dal testo (es. "Avvitare le viti senza serrarle").
- **Quantità**: ×2 / ×2 / ×1 / ×1 sui componenti, e il materiale che serve in ogni passo. Viti M8: 8 sui traversi superiori (2 per estremità) e 2 sul traverso inferiore, per un totale di 10. Viti da legno: 6, una per angolare.
- **Box di avviso al passo 3** ("Non serrare ancora le viti: il serraggio avviene al passo 5").
- **Pagina "Sequenza di montaggio"**, una panoramica che non c'era.
- "Rondella in plastica" diventa "rondella in nylon", come nella tabella della ferramenta. "Buco di serraggio" diventa "foro di serraggio". "Panchetto Volpina" diventa "panca Volpina", come in copertina.
- **Altre piccole modifiche al testo:**
  - passo 5: "al termine delle *seguenti* procedure" diventa "*precedenti*" (era un refuso dell'originale);
  - passo 2: "fissaggio dei piani" diventa "del piano", e "come in figura" compare una volta sola;
  - passo 3: "sotto testa" diventa "sottotesta";
  - passo 7: "nell'asola presente" diventa "nelle asole presenti" (6 viti in 6 angolari);
  - al passo 5 è evidenziato anche "serraggio delle 10 viti".

## Rigenerare il PDF

Serve Python 3 con Pillow, e Node con Playwright/Chromium.

```bash
cd manuale-tavolo-levante
python3 tools/prepara_immagini.py      # solo se cambiano le immagini
node tools/genera_pdf.cjs              # crea Istruzioni_Montaggio_Tavolo_Levante.pdf
```

Per cambiare un testo basta modificarlo in `manuale.html`, che è un file di testo normale, e rigenerare il PDF.

## QR code del video di montaggio (pagina 2)

In fondo alla pagina 2 c’è un riquadro con il QR code che apre il video di montaggio. Un QR code contiene un
link, quindi prima bisogna **mettere il video online**: su YouTube (va bene anche «non in elenco», così si vede
solo con il link) oppure sul sito. Poi, con il link del video, bastano due comandi:

```bash
cd manuale-tavolo-levante
node tools/genera_qr.cjs <link> && node tools/genera_pdf.cjs
# esempio: node tools/genera_qr.cjs https://youtu.be/abcdefghijk && node tools/genera_pdf.cjs
```

- `genera_qr.cjs` controlla il link (deve iniziare con `https://` o `http://`), crea `assets/final/qr_video.svg`
  (vettoriale, correzione d’errore M, margine bianco di 4 moduli, stampato 32×32 mm) e salva il link in
  `tools/video_url.txt`. È l’**unico posto** dove sta il link: anche il testo stampato sotto il titolo del riquadro
  viene da lì. Usa il pacchetto npm `qrcode` di `../strumento-manuali` (se manca: `npm install` in quella cartella).
- Oggi in `tools/video_url.txt` c’è il link **segnaposto** `https://esempio.it/video-montaggio-tavolo-levante`.
  Finché resta quello, `genera_pdf.cjs` **non stampa il riquadro** e la pagina 2 resta com’era; per vedere
  l’impaginazione con il QR segnaposto: `node tools/genera_pdf.cjs --anteprima /percorso/anteprima.pdf`.
- `genera_pdf.cjs` si ferma con un messaggio se il QR non corrisponde al link salvato o se qualcosa esce
  dall’area utile della pagina.
- Prima di mandare il PDF in stampa conviene inquadrare il QR con il telefono e controllare che si apra il video.
