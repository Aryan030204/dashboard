# Layer order matters for build speed: things that rarely change (system packages, fonts) come
# FIRST and the app code comes LAST, so a code change rebuilds in seconds instead of re-downloading
# LibreOffice. Targets: `api` (HTTP service, no extra packages) and `worker` (adds LibreOffice + poppler).

# --- App code + node_modules (changes often; built once and copied into both targets) ----------
FROM node:20-bookworm-slim AS app
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY migrations ./migrations
COPY scripts/convert-local.js ./scripts/convert-local.js

# --- Worker system layer (large; only rebuilt if this block or the fonts folder changes) -------
# Fonts: metric-compatible substitutes for the Office defaults (Calibri->Carlito, Cambria->Caladea,
# Arial->Liberation) so layouts survive conversion, plus Noto for Indic scripts. Brand fonts used
# in decks go in ./fonts and are installed below.
FROM node:20-bookworm-slim AS worker-system
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-impress poppler-utils fontconfig \
      fonts-dejavu-core fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*
COPY fonts/ /usr/local/share/fonts/datum/
RUN fc-cache -f

# --- Final images -------------------------------------------------------------------------------
FROM node:20-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production PORT=4040
COPY --from=app /app /app
EXPOSE 4040
USER node
CMD ["node", "src/server.js"]

FROM worker-system AS worker
WORKDIR /app
ENV NODE_ENV=production HOME=/tmp UPLOAD_TMP_DIR=/tmp/weekly-reports
COPY --from=app /app /app
RUN mkdir -p /tmp/weekly-reports && chown node:node /tmp/weekly-reports
USER node
CMD ["node", "src/worker.js"]
