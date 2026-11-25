# Strumento manuali in un container (facoltativo: di solito basta lo script avvia-* del proprio sistema).
#
#   docker build -t strumento-manuali .
#   docker run --rm -p 3210:3210 \
#     -v manuali-lavori:/app/lavori -v manuali-config:/app/config \
#     strumento-manuali
#   poi apri http://localhost:3210
#
# La chiave API si inserisce dall'interfaccia (Impostazioni) oppure con -e ANTHROPIC_API_KEY=sk-ant-...
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3210 \
    NO_BROWSER=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Dipendenze prima del codice, per riusare la cache di Docker. ffmpeg-static scarica il suo eseguibile;
# Playwright installa Chromium con le librerie di sistema che gli servono.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npx playwright install --with-deps chromium \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/* /tmp/*

COPY . .
RUN mkdir -p lavori config && chown -R node:node /app/lavori /app/config /ms-playwright

USER node
VOLUME ["/app/lavori", "/app/config"]
EXPOSE 3210
CMD ["node", "server.js"]
