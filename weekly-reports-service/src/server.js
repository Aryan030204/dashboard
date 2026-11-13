require("dotenv").config();

const { getConfig } = require("./config");
const { createPool } = require("./db/pool");
const { buildReportsRepo } = require("./services/reportsRepo");
const { buildStorage } = require("./services/storage");
const { buildAudit } = require("./services/audit");
const { buildUploadSessions } = require("./services/uploadSessions");
const { buildApp } = require("./app");
const { createLogger } = require("./logger");
const { connectMongo } = require("./db/mongo");
const { buildMeetingRepo } = require("./services/meetingRepo");
const { buildMeetingAudit } = require("./services/meetingAudit");
const { buildFirefliesConnectionStore } = require("./services/firefliesConnectionStore");
const { buildFirefliesClient } = require("./services/firefliesClient");
const { buildMeetingImportService } = require("./services/meetingImportService");

const log = createLogger("api");

function start() {
  const config = getConfig();
  process.on("unhandledRejection", (reason) => log.error("unhandled promise rejection", { error: reason }));
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception, exiting", { error: err });
    process.exit(1);
  });

  // Fail closed: this service serves confidential client documents, so a missing gateway secret
  // must never silently disable authentication in production.
  if (!config.gatewaySharedSecret) {
    if (config.nodeEnv === "production" || !config.allowInsecureAuth) {
      log.error("GATEWAY_SHARED_SECRET is not set. Refusing to start.");
      process.exit(1);
    }
    log.warn("WARNING: ALLOW_INSECURE_AUTH=true, gateway identity headers are trusted UNSIGNED. Dev only.");
  }

  // A copied .env.example value would silently override the real secret and make every request 401.
  if (config.gatewaySharedSecret === "replace-with-gateway-shared-secret") {
    log.error("GATEWAY_SHARED_SECRET is still the example placeholder. Remove it from this service's .env (the root .env supplies it) or set the real value. Refusing to start.");
    process.exit(1);
  }

  // Configuration worth knowing when something misbehaves. No secrets: the shared secret and DB password are never logged.
  log.info("starting", {
    node: process.version,
    env: config.nodeEnv,
    logLevel: process.env.WEEKLY_REPORTS_LOG_LEVEL || "info",
    port: config.port,
    db: { host: config.db.host, port: config.db.port, name: config.db.database, pool: config.db.connectionLimit },
    bucket: config.bucket,
    region: config.region,
    maxUploadMB: Math.round(config.maxUploadBytes / (1024 * 1024)),
    chunkMB: Number((config.uploadChunkBytes / (1024 * 1024)).toFixed(2)),
    uploadSessionTtlMin: Math.round(config.uploadSessionTtlMs / 60000),
    maxSlides: config.maxSlides,
    tmpDir: config.uploadTmpDir,
    corsOrigins: config.corsOrigins.length || "any",
  });

  const pool = createPool(config);
  const storage = buildStorage(config, { logger: log.child("storage") });
  const sessions = buildUploadSessions({ config, logger: log.child("sessions") });
  const repo = buildReportsRepo(pool, { logger: log.child("repo") });
  repo.checkSchema();

  // Meeting Pointers (Fireflies). A Mongo or schema problem only affects /meeting-pointers, never Weekly Reports.
  const meetingRepo = buildMeetingRepo(pool, { logger: log.child("meeting-repo") });
  meetingRepo.checkSchema();
  connectMongo(config, log.child("mongo")).catch((err) => log.error("mongo connect failed", { error: err }));
  const meetings = buildMeetingImportService({
    config,
    repo: meetingRepo,
    connections: buildFirefliesConnectionStore({ config }),
    firefliesClient: buildFirefliesClient({ timeoutMs: config.fireflies.timeoutMs, logger: log.child("fireflies") }),
    audit: buildMeetingAudit(pool, log.child("meeting-audit")),
    logger: log.child("meeting-import"),
  });

  const app = buildApp({
    config,
    repo,
    storage,
    audit: buildAudit(pool, log.child("audit")),
    sessions,
    logger: log,
    meetings,
  });

  // Idle uploads are dropped after UPLOAD_SESSION_TTL_MS; folders left by a previous run are removed once.
  sessions.cleanupOrphans().catch((err) => log.error("cleaning up old upload folders failed", { error: err }));
  setInterval(() => sessions.sweep().catch((err) => log.error("sweeping idle upload sessions failed", { error: err })), 60 * 1000).unref();

  app.listen(config.port, () => {
    log.info(`listening on :${config.port}`);
  });
}

start();
