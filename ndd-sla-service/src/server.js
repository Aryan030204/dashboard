require("dotenv").config();

const { getConfig } = require("./config");
const { createPool } = require("./db/pool");
const { buildRepo } = require("./services/repo");
const { buildApp } = require("./app");
const { buildPipeline } = require("./services/pipeline");
const { createLogger } = require("./logger");

const log = createLogger("api");

function start() {
  const config = getConfig();
  process.on("unhandledRejection", (reason) => log.error("unhandled promise rejection", { error: reason }));
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception, exiting", { error: err });
    process.exit(1);
  });

  // Fail closed, same rule as weekly-reports-service.
  if (!config.gatewaySharedSecret) {
    if (config.nodeEnv === "production" || !config.allowInsecureAuth) {
      log.error("GATEWAY_SHARED_SECRET is not set. Refusing to start.");
      process.exit(1);
    }
    log.warn("ALLOW_INSECURE_AUTH=true: gateway identity headers are trusted UNSIGNED. Dev only.");
  }

  // A copied .env.example value would silently override the real secret and make every request 401.
  if (config.gatewaySharedSecret === "replace-with-gateway-shared-secret") {
    log.error("GATEWAY_SHARED_SECRET is still the example placeholder. Remove it from this service's .env (the root .env supplies it). Refusing to start.");
    process.exit(1);
  }

  log.info("starting", { node: process.version, env: config.nodeEnv, port: config.port, brand: config.brandKey, db: { host: config.db.host, name: config.db.database } });
  const repo = buildRepo(createPool(config), { logger: log.child("repo") });
  repo.checkSchema();
  // The pipeline is built here only for manual upload; the API never uses Gmail or EasyCom (no clients are created).
  const pipeline = buildPipeline({ config, repo, logger: log.child("pipeline"), workerId: `api:${process.pid}` });
  // Frees locks of uploads whose process died (the worker does this too, but it may be switched off in manual-only mode).
  setInterval(() => repo.releaseStaleLocks(config.worker.lockStaleMs).catch((err) => log.error("releasing stale locks failed", { error: err })), 60 * 1000).unref();
  buildApp({ config, repo, logger: log, pipeline }).listen(config.port, () => log.info(`listening on :${config.port}`));
}

start();
