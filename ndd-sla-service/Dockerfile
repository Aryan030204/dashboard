# NDD / SLA Reports. Two containers from one image, like weekly-reports-service:
#   api    HTTP service behind the gateway (/ndd-sla), reads the persisted snapshots only.
#   worker Gmail -> streamed CSV -> EasyCom -> MySQL. Separate container so report processing can never take memory
#          from the API or from analytics; it has its own mem_limit in docker-compose.yml.
# No system packages are needed (no LibreOffice, no native modules), so both targets stay small.

FROM node:20-bookworm-slim AS app
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

FROM node:20-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production PORT=4050
COPY --from=app /app /app
EXPOSE 4050
USER node
CMD ["node", "src/server.js"]

FROM node:20-bookworm-slim AS worker
WORKDIR /app
# The attachment is streamed through a temp file; /tmp/ndd-sla is the only writable path the worker needs.
ENV NODE_ENV=production NDD_SLA_TMP_DIR=/tmp/ndd-sla
COPY --from=app /app /app
RUN mkdir -p /tmp/ndd-sla && chown node:node /tmp/ndd-sla
USER node
CMD ["node", "src/worker.js"]
