#!/bin/bash
# Strumento manuali — avvio su Mac (doppio clic su questo file).
# Controlla Node.js, installa i componenti la prima volta e apre lo strumento nel browser.
# Se il Mac non lo apre («sviluppatore non identificato»): tasto destro sul file › Apri › Apri.

cd "$(dirname "$0")" || exit 1

# Il Terminale aperto dal Finder può non avere tutti i percorsi: si aggiungono quelli più comuni.
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.volta/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

fine() {
  echo
  read -r -p "Premi Invio per chiudere questa finestra… " _
  exit "${1:-1}"
}

# Aperto dall'interno di uno ZIP (o copiato da solo)? Senza i file dello strumento accanto non può funzionare.
if [ ! -f server.js ] || [ ! -f package.json ]; then
  echo
  echo "  Mancano i file dello strumento accanto a questo script."
  echo "  Probabilmente lo hai aperto dall’interno del file ZIP: estrai prima tutto lo ZIP"
  echo "  (doppio clic sullo ZIP, oppure tasto destro › Estrai) e avvia lo script dalla cartella estratta."
  fine 1
fi

echo
echo "  =================================================="
echo "    STRUMENTO MANUALI"
echo "  =================================================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js non risulta installato su questo Mac."
  echo
  echo "  1. Si apre ora il sito nodejs.org: scarica la versione «LTS» per macOS."
  echo "  2. Installala lasciando le opzioni proposte."
  echo "  3. Poi fai di nuovo doppio clic su avvia-mac.command."
  open "https://nodejs.org/" >/dev/null 2>&1
  fine 1
fi

if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  echo "  La versione di Node.js installata è troppo vecchia: $(node -v)."
  echo "  Serve la versione 22.13 o successiva: scarica la versione «LTS» da nodejs.org (si apre ora)"
  echo "  e poi fai di nuovo doppio clic su avvia-mac.command."
  open "https://nodejs.org/" >/dev/null 2>&1
  fine 1
fi

# componenti mancanti (prima volta, o dopo un aggiornamento che ne ha aggiunti di nuovi)
if ! node -e "const fs=require('fs');process.exit(Object.keys(require('./package.json').dependencies||{}).every((d)=>fs.existsSync('node_modules/'+d+'/package.json'))?0:1)" >/dev/null 2>&1; then
  echo "  Installazione dei componenti (la prima volta o dopo un aggiornamento)."
  echo "  Serve la connessione a Internet: ci vuole qualche minuto."
  echo
  if ! npm install --no-fund --no-audit; then
    echo
    echo "  L’installazione dei componenti non è riuscita: controlla la connessione a Internet e riprova."
    fine 1
  fi
fi

if ! node -e "require('playwright').chromium.launch().then(b=>b.close()).then(()=>process.exit(0),()=>process.exit(1))" >/dev/null 2>&1; then
  echo
  echo "  Installazione del browser usato per creare PDF e video (solo la prima volta)…"
  echo
  if ! npx playwright install chromium; then
    echo
    echo "  L’installazione del browser non è riuscita: controlla la connessione a Internet e riprova."
    fine 1
  fi
fi

echo
echo "  Avvio in corso: tra poco si apre il browser con lo strumento."
echo "  Lascia aperta questa finestra mentre lavori. Per chiudere lo strumento, chiudila."
echo
node server.js
code=$?
if [ "$code" -ne 0 ] && [ "$code" -ne 130 ]; then
  echo
  echo "  Lo strumento si è fermato a causa di un errore: leggi il messaggio qui sopra."
  fine "$code"
fi
