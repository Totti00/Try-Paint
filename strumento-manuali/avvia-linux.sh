#!/usr/bin/env bash
# Strumento manuali — avvio su Linux:  ./avvia-linux.sh   (oppure: bash avvia-linux.sh)
# Controlla Node.js, installa i componenti la prima volta e apre lo strumento nel browser.

cd "$(dirname "$0")" || exit 1

# Aperto dall'interno di uno ZIP (o copiato da solo)? Senza i file dello strumento accanto non può funzionare.
if [ ! -f server.js ] || [ ! -f package.json ]; then
  echo
  echo "  Mancano i file dello strumento accanto a questo script."
  echo "  Probabilmente lo hai aperto dall’interno del file ZIP: estrai prima tutto lo ZIP"
  echo "  (doppio clic sullo ZIP, oppure tasto destro › Estrai) e avvia lo script dalla cartella estratta."
  exit 1
fi
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

echo
echo "  =================================================="
echo "    STRUMENTO MANUALI"
echo "  =================================================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js non risulta installato."
  echo "  Installa la versione «LTS» (22.13 o successiva) da https://nodejs.org/"
  echo "  oppure con il gestore di pacchetti della tua distribuzione, poi rilancia questo script."
  command -v xdg-open >/dev/null 2>&1 && xdg-open "https://nodejs.org/" >/dev/null 2>&1 &
  exit 1
fi

if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  echo "  La versione di Node.js installata è troppo vecchia: $(node -v)."
  echo "  Serve la 22.13 o successiva: installa la versione «LTS» da https://nodejs.org/ e rilancia questo script."
  exit 1
fi

# componenti mancanti (prima volta, o dopo un aggiornamento che ne ha aggiunti di nuovi)
if ! node -e "const fs=require('fs');process.exit(Object.keys(require('./package.json').dependencies||{}).every((d)=>fs.existsSync('node_modules/'+d+'/package.json'))?0:1)" >/dev/null 2>&1; then
  echo "  Installazione dei componenti (serve Internet, qualche minuto: la prima volta o dopo un aggiornamento)…"
  echo
  npm install --no-fund --no-audit || { echo; echo "  L’installazione dei componenti non è riuscita: controlla la connessione a Internet e riprova."; exit 1; }
fi

check_browser() {
  node -e "require('playwright').chromium.launch().then(b=>b.close()).then(()=>process.exit(0),()=>process.exit(1))" >/dev/null 2>&1
}
if ! check_browser; then
  echo
  echo "  Installazione del browser usato per creare PDF e video (solo la prima volta)…"
  echo
  npx playwright install chromium || { echo; echo "  L’installazione del browser non è riuscita: controlla la connessione a Internet e riprova."; exit 1; }
  if ! check_browser; then
    echo
    echo "  Il browser è installato ma non parte: probabilmente mancano alcune librerie di sistema."
    echo "  Installale una volta con:   sudo npx playwright install-deps chromium"
    echo "  e poi rilancia questo script."
    exit 1
  fi
fi

echo
echo "  Avvio in corso: tra poco si apre il browser con lo strumento."
echo "  Per chiudere lo strumento premi Ctrl+C in questa finestra."
echo
exec node server.js
