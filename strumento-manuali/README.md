# Strumento manuali

Da un manuale di montaggio che hai già (PDF o Word) a un **manuale PDF impaginato in modo professionale** e a un **video di montaggio**, con l’aiuto di Claude.

Lo strumento funziona sul tuo computer, nel browser. I tuoi file restano sul computer: solo il documento viene inviato a Claude per l’analisi.

---

## Cosa fa

1. **Analisi** – Claude legge il manuale (testi e figure) e prepara una scheda: componenti, ferramenta, passi di montaggio, avvertenze.
2. **Revisione** – controlli la scheda e correggi quello che serve, con il documento originale a fianco.
3. **PDF** – lo strumento impagina il manuale: copertina, componenti, ferramenta, passi illustrati, note.
4. **Video** – crea il video di montaggio: **3D** se hai il modello 3D del prodotto, altrimenti **con le immagini** del manuale.

## Cosa serve

- Un computer con **Windows 10/11**, **macOS** o **Linux** (consigliati 8 GB di memoria e 2 GB liberi sul disco).
- **Node.js 22.13 o successivo**: scarica la versione **LTS** da [nodejs.org](https://nodejs.org/) e installala lasciando le opzioni proposte.
- La connessione a **Internet** (per Claude e per la prima installazione).
- Una **chiave API di Claude** (vedi sotto).

## Primo avvio

| Sistema | Cosa fare |
|---|---|
| **Windows** | Doppio clic su **`avvia-windows.bat`** |
| **Mac** | Doppio clic su **`avvia-mac.command`** (la prima volta: tasto destro sul file › **Apri** › **Apri**) |
| **Linux** | Da terminale, nella cartella: **`./avvia-linux.sh`** |

Se hai ricevuto lo strumento come file **ZIP**, prima **estrai tutto** (su Windows: tasto destro sullo ZIP › *Estrai tutto…*) e avvia lo script dalla cartella estratta: aperto dall’interno dello ZIP non funziona.

La prima volta lo script scarica i componenti necessari (serve qualche minuto). Poi si apre il browser con lo strumento all’indirizzo **http://localhost:3210**.

**Lascia aperta la finestra nera** mentre lavori: chiudendola si chiude lo strumento. Per riaprirlo, rifai doppio clic sullo script.

## La chiave API di Claude e i costi

1. Apri [console.anthropic.com](https://console.anthropic.com/) e accedi (o crea un account).
2. In **Plans & Billing** aggiungi un po’ di credito.
3. In **API Keys** premi **Create Key** e copia la chiave (inizia con `sk-ant-`).
4. Nello strumento apri **Impostazioni**, incolla la chiave e premi **Salva la chiave**.

La chiave resta solo su questo computer (nel file `config/settings.json`) e non viene mai mostrata per intero.

**Costi:** ogni analisi viene addebitata sull’account Anthropic della chiave. Indicativamente costa **qualche euro per manuale** (di più per manuali lunghi con molte immagini). Il video 3D richiede una seconda chiamata a Claude, più piccola. Nella pagina di ogni lavoro trovi il **costo stimato**.

## I 4 passi

### 1. Analisi
Nella pagina iniziale trascina il manuale (PDF o Word .docx) nel riquadro grande e, se ce l’hai, il modello 3D in quello piccolo. Premi **Avvia l’analisi**: di solito servono 2–5 minuti. Puoi chiudere il browser e tornare dopo: il lavoro continua finché la finestra nera è aperta.

### 2. Revisione
- In alto trovi le **Modifiche fatte dall’AI**: quelle evidenziate in arancione vanno controllate sul documento originale; quando le hai controllate spunta **Ho verificato**.
- Correggi testi, quantità, sigle e immagini. Le quantità si possono lasciare vuote se il documento non le indica.
- Per **evidenziare** una parola (grassetto sottolineato nel PDF) selezionala e premi **Evidenzia** (oppure Ctrl+B): nel testo appare tra due asterischi, `**parola**`.
- Clicca su un’immagine per sceglierne un’altra tra quelle estratte dal documento.
- Premi **Salva** (oppure Ctrl+S). Il PDF e il video useranno esattamente questa scheda.

### 3. PDF
Premi **Crea il PDF**: in meno di un minuto vedi l’anteprima. **Scarica il PDF** lo salva come `Istruzioni_Montaggio_<nome>.pdf`. Se modifichi la scheda, ricrea il PDF.

### 4. Video
Scegli il tipo di video e la qualità, poi premi **Crea il video**. Il file si scarica come `Montaggio_<nome>.mp4`.
- **Anteprima veloce**: bassa qualità, pronta in poco tempo, per controllare.
- **1080p Full HD**: la qualità definitiva (richiede alcuni minuti; di più su computer senza scheda grafica).

## Video 3D o video con immagini?

| | Video 3D | Video con immagini |
|---|---|---|
| Serve | il modello 3D del prodotto | niente: usa le figure del manuale |
| Risultato | i pezzi si montano uno dopo l’altro, con viti che si avvitano e primi piani | le figure dei passi, animate, con le didascalie |
| Tempo | più lungo | più breve |

## Consigli per il modello 3D

- Il formato migliore è lo **STEP** (`.step` / `.stp`). Si esporta da quasi tutti i programmi CAD:
  SolidWorks (*File › Salva con nome › STEP*), Fusion 360 (*File › Esporta › STEP*), Inventor (*Salva copia come › STEP*), Solid Edge, FreeCAD (*File › Esporta*)…
  Vanno bene anche IGES, GLB/GLTF, OBJ e STL (fino a 300 MB).
- Esporta l’**assieme completo, già montato**, con i pezzi come **parti separate** (non un unico corpo unito).
- Se ci sono, includi **viti e rondelle**: il video sarà più chiaro.
- Dopo il caricamento lo strumento mostra le **viste delle parti**. Se il prodotto appare **sdraiato o capovolto**, premi **Rileggi con l’asse Z in alto** (o Y).

## Dove sono i file

Ogni lavoro ha una cartella dentro `lavori/` (per esempio `lavori/20261124-153012-tavolo-levante/`):
`out/manuale.pdf`, `out/video.mp4`, `out/poster.jpg` (copertina del video) e `log.txt` (registro, utile in caso di problemi). Per eliminare un lavoro usa il cestino nella pagina iniziale.

## Problemi frequenti

- **«Node.js non risulta installato» o «versione troppo vecchia»** – installa la versione LTS da [nodejs.org](https://nodejs.org/) e riavvia lo script.
- **Windows dice «Windows ha protetto il PC»** – premi *Ulteriori informazioni* › *Esegui comunque*.
- **Il Mac dice che il file non si può aprire** – tasto destro su `avvia-mac.command` › *Apri* › *Apri*. Se dice «permesso negato», apri il Terminale nella cartella e scrivi `chmod +x avvia-mac.command`.
- **Il browser non si apre** – aprilo tu e vai su **http://localhost:3210**.
- **«Strumento manuali è già aperto»** – lo strumento era già in funzione: si apre la scheda del browser con quello, e la nuova finestra si può chiudere.
- **«La porta 3210 è occupata»** – un altro programma usa la porta: chiudilo, oppure avvia lo strumento su un’altra porta (variabile `PORT`, vedi sotto).
- **«Mancano i file dello strumento accanto a questo script»** – lo script è stato aperto dall’interno del file ZIP: estrai tutto (tasto destro › *Estrai tutto…*) e riavvialo dalla cartella estratta.
- **«Manca la chiave API», «chiave non valida», «credito esaurito»** – controlla la chiave in *Impostazioni* e il credito su console.anthropic.com, poi premi **Riprova**.
- **PDF protetto da password** – rimuovi la protezione (per esempio stampandolo in un nuovo PDF) e ricaricalo.
- **Documento Word vecchio (.doc)** – aprilo in Word e salvalo come `.docx`, oppure esportalo in PDF.
- **Manuale scansionato** – funziona lo stesso (Claude legge le pagine come immagini), ma controlla con più attenzione la revisione.
- **Il modello 3D non viene letto** – esportalo di nuovo in STEP, con le parti separate.
- **Il video è lento** – è normale su computer senza scheda grafica: prova prima l’**Anteprima veloce**, poi crea il video definitivo e lascia lavorare il computer.
- **Se un’operazione non riesce** compare un riquadro rosso con il motivo e il pulsante **Riprova**. Se il problema si ripete, il *registro del lavoro* (link nel riquadro) contiene i dettagli tecnici.

---

### Per chi è pratico di computer

- Avvio manuale: `npm install`, `npx playwright install chromium`, poi `npm start`.
- Variabili d’ambiente: `PORT` (3210), `HOST` (127.0.0.1: lo strumento è raggiungibile solo da questo computer), `NO_BROWSER=1`, `ANTHROPIC_API_KEY`, `MANUALI_JOBS_DIR`, `MANUALI_CONFIG_DIR`, `MANUALI_ALLOWED_HOSTS`.
- **Sicurezza:** lo strumento non ha password. Risponde solo agli indirizzi `localhost`, `127.0.0.1` e `[::1]` (protezione dal «DNS rebinding»: le richieste con un altro nome nell’intestazione `Host` ricevono 421). Per usarlo da un altro computer della rete servono `HOST=0.0.0.0` e `MANUALI_ALLOWED_HOSTS=192.168.1.20,pc-ufficio.local` (nomi o indirizzi con cui lo si apre): in quel caso **chiunque nella rete** può vedere i manuali, cancellare i lavori e usare la chiave API. Fallo solo in una rete di cui ti fidi.
- Test automatici (nessuna chiamata a Claude): `npm test`. Modalità di prova dell’interfaccia senza Claude: `MANUALI_AI_FIXTURE=test/fixtures/tavolo-levante/manual.json MANUALI_PLAN_FIXTURE=test/fixtures/tavolo-levante/plan.json npm start`.
- Docker: `docker build -t strumento-manuali .` e `docker run -p 127.0.0.1:3210:3210 -v manuali-lavori:/app/lavori -v manuali-config:/app/config strumento-manuali`, poi http://localhost:3210. Lascia `127.0.0.1:` davanti alla porta: con `-p 3210:3210` Docker la pubblica su tutte le interfacce di rete (vedi *Sicurezza* qui sopra).
- Architettura, cartelle e API: [ARCHITETTURA.md](ARCHITETTURA.md).
