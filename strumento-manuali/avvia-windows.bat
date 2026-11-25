@echo off
rem Strumento manuali - avvio su Windows (doppio clic su questo file).
rem Controlla Node.js, installa i componenti la prima volta e apre lo strumento nel browser.
rem (Testi senza lettere accentate: la console di Windows potrebbe non mostrarle bene.)
setlocal EnableExtensions
title Strumento manuali
cd /d "%~dp0"

rem Aperto dall'interno dello ZIP (Esplora risorse estrae solo questo file in una cartella temporanea)?
if not exist "server.js" goto notextracted
if not exist "package.json" goto notextracted

echo.
echo   ==================================================
echo     STRUMENTO MANUALI
echo   ==================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto oldnode

if exist "node_modules\express\" goto deps_ok
echo   Prima installazione dei componenti.
echo   Serve la connessione a Internet: ci vuole qualche minuto, solo la prima volta.
echo.
call npm install --no-fund --no-audit
if errorlevel 1 goto npmfail
:deps_ok

node -e "require('playwright').chromium.launch().then(b=>b.close()).then(()=>process.exit(0),()=>process.exit(1))" >nul 2>nul
if not errorlevel 1 goto browser_ok
echo.
echo   Installazione del browser usato per creare PDF e video - solo la prima volta...
echo.
call npx playwright install chromium
if errorlevel 1 goto pwfail
:browser_ok

echo.
echo   Avvio in corso: tra poco si apre il browser con lo strumento.
echo   Lascia aperta questa finestra mentre lavori. Per chiudere lo strumento, chiudila.
echo.
node server.js
if errorlevel 1 goto crashed
exit /b 0

:notextracted
echo.
echo   Mancano i file dello strumento accanto a questo script.
echo.
echo   Probabilmente lo hai aperto dall'interno del file ZIP, senza estrarlo.
echo   1. Chiudi questa finestra.
echo   2. Tasto destro sul file ZIP, poi "Estrai tutto..." e conferma.
echo   3. Apri la cartella estratta e fai doppio clic su avvia-windows.bat da li'.
echo.
pause
exit /b 1

:nonode
echo   Node.js non risulta installato su questo computer.
echo.
echo   1. Si apre ora il sito nodejs.org: scarica la versione "LTS" per Windows.
echo   2. Installala lasciando le opzioni proposte.
echo   3. Poi fai di nuovo doppio clic su avvia-windows.bat.
echo.
start "" "https://nodejs.org/"
pause
exit /b 1

:oldnode
for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo   La versione di Node.js installata e' troppo vecchia: %NODEVER%.
echo   Serve la versione 22.13 o successiva.
echo.
echo   Scarica e installa la versione "LTS" da nodejs.org (si apre ora),
echo   poi fai di nuovo doppio clic su avvia-windows.bat.
echo.
start "" "https://nodejs.org/"
pause
exit /b 1

:npmfail
echo.
echo   L'installazione dei componenti non e' riuscita.
echo   Controlla la connessione a Internet e riprova. Se usi una rete aziendale,
echo   potrebbe servire l'aiuto del tecnico informatico - proxy o firewall.
echo.
pause
exit /b 1

:pwfail
echo.
echo   L'installazione del browser per PDF e video non e' riuscita.
echo   Controlla la connessione a Internet e riprova.
echo.
pause
exit /b 1

:crashed
echo.
echo   Lo strumento si e' fermato a causa di un errore: leggi il messaggio qui sopra.
echo.
pause
exit /b 1
