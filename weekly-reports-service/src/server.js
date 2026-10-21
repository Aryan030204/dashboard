require("dotenv").config();

const { getConfig } = require("./config");
const { createPool } = require("./db/pool");
const { buildReportsRepo } = require("./services/reportsRepo");
const { buildStorage } = require("./services/storage");
const { buildAudit } = require("./services/audit");
const { buildApp } = require("./app");

function start() {
  const config = getConfig();

  // Fail closed: this service serves confidential client documents, so a missing gateway secret
  // must never silently disable authentication in production.
  if (!config.gatewaySharedSecret) {
    if (config.nodeEnv === "production" || !config.allowInsecureAuth) {
      console.error("[weekly-reports] GATEWAY_SHARED_SECRET is not set. Refusing to start.");
      process.exit(1);
    }
    console.warn("[weekly-reports] WARNING: ALLOW_INSECURE_AUTH=true, gateway identity headers are trusted UNSIGNED. Dev only.");
  }

  // A copied .env.example value would silently override the real secret and make every request 401.
  if (config.gatewaySharedSecret === "replace-with-gateway-shared-secret") {
    console.error("[weekly-reports] GATEWAY_SHARED_SECRET is still the example placeholder. Remove it from this service's .env (the root .env supplies it) or set the real value. Refusing to start.");
    process.exit(1);
  }

  const pool = createPool(config);
  const storage = buildStorage(config);
  const app = buildApp({ config, repo: buildReportsRepo(pool), storage, audit: buildAudit(pool) });

  app.listen(config.port, () => {
    console.log(`[weekly-reports] listening on :${config.port}`);
  });
}

start();
