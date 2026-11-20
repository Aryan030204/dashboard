require("dotenv").config();

const os = require("os");
const { getConfig, validateIntegrationConfig } = require("./config");
const { createPool } = require("./db/pool");
const { buildRepo } = require("./services/repo");
const { buildCredentials } = require("./services/credentials");
const { buildGmailClient, buildRefreshTokenProvider } = require("./integrations/gmailClient");
const { buildEasycomClient } = require("./integrations/easycomClient");
const { buildPipeline } = require("./services/pipeline");
const { createLogger } = require("./logger");

const log = createLogger("worker");

async function main() {
  const config = getConfig();

  // Manual-upload-only deployments: nothing to do, and no Gmail/EasyCom configuration is required.
  if (!config.autoEnabled) {
    log.warn("NDD_SLA_AUTO_ENABLED=false: automatic ingestion is off. This worker stays idle; reports come from manual upload.");
    setInterval(() => {}, 60 * 60 * 1000);
    return;
  }

  // Production values this repo cannot know. Refuse to start rather than run a pipeline that cannot succeed.
  const missing = validateIntegrationConfig(config);
  if (missing.length) {
    log.error("missing required configuration, refusing to start", { missing });
    process.exit(1);
  }

  const pool = createPool(config);
  const repo = buildRepo(pool, { logger: log.child("repo") });
  const credentials = buildCredentials(pool, { aesKey: config.passwordAesKey });
  const gmail = buildGmailClient({
    getAccessToken: buildRefreshTokenProvider({
      getRefreshToken: () => credentials.getToken(config.brandKey, "GMAIL"),
      clientId: config.gmail.clientId,
      clientSecret: config.gmail.clientSecret,
    }),
    logger: log.child("gmail"),
  });
  const easycom = buildEasycomClient({
    config: config.easycom,
    getToken: () => credentials.getToken(config.brandKey, "EASYCOM"),
    logger: log.child("easycom"),
  });
  const workerId = `${os.hostname()}:${process.pid}`;
  const pipeline = buildPipeline({ config, repo, gmail, easycom, logger: log.child("pipeline"), workerId });

  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      log.warn("stop requested, finishing the current run first", { signal });
      stopping = true;
    });
  }
  process.on("unhandledRejection", (reason) => log.error("unhandled promise rejection", { error: reason }));
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception, exiting", { error: err });
    process.exit(1);
  });

  await repo.checkSchema();
  log.info(`started as ${workerId}`, { brand: config.brandKey, pollMs: config.pollMs });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  while (!stopping) {
    let result = { outcome: "idle" };
    try {
      result = await pipeline.tick();
    } catch (err) {
      log.error("worker loop error (will retry)", { error: err });
    }
    // After real work, look again immediately; otherwise wait for the next poll.
    if (result.outcome === "idle" || result.outcome === "waiting") await sleep(config.pollMs);
  }
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  log.error("fatal, the worker could not start", { error: err });
  process.exit(1);
});
