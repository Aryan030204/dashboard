require("dotenv").config();

const os = require("os");
const { getConfig } = require("./config");
const { createPool } = require("./db/pool");
const { buildReportsRepo } = require("./services/reportsRepo");
const { buildStorage } = require("./services/storage");
const { buildAudit } = require("./services/audit");
const { buildProcessor } = require("./services/processor");

// Separate process from the API so a hung LibreOffice can never block requests.
async function main() {
  const config = getConfig();
  const pool = createPool(config);
  const repo = buildReportsRepo(pool);
  const storage = buildStorage(config);
  const audit = buildAudit(pool);
  const processor = buildProcessor({ config, repo, storage, audit });
  const workerId = `${os.hostname()}:${process.pid}`;

  let stopping = false;
  const stop = () => {
    console.log("[weekly-reports-worker] stopping after the current job");
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  console.log(`[weekly-reports-worker] started as ${workerId}`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // A job locked longer than the conversion timeout (plus grace) belongs to a dead worker or a
  // stuck upload.
  const staleAfterMs = config.convertTimeoutMs + 60 * 1000;

  while (!stopping) {
    try {
      const failed = await repo.failStale(staleAfterMs);
      if (failed) console.warn(`[weekly-reports-worker] marked ${failed} stale report(s) FAILED`);

      const job = await repo.claimNext(workerId);
      if (job) {
        console.log(`[weekly-reports-worker] processing report ${job.id} (${job.brandKey})`);
        const result = await processor.process(job);
        console.log(`[weekly-reports-worker] report ${job.id} done`, JSON.stringify(result));
        continue; // look for the next job immediately
      }
    } catch (err) {
      console.error("[weekly-reports-worker] loop error", err && err.message);
    }
    await sleep(config.workerPollMs);
  }
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("[weekly-reports-worker] fatal", err);
  process.exit(1);
});
