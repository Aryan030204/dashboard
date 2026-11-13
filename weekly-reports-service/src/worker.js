require("dotenv").config();

const os = require("os");
const { getConfig } = require("./config");
const { createPool } = require("./db/pool");
const { buildReportsRepo } = require("./services/reportsRepo");
const { buildStorage } = require("./services/storage");
const { buildAudit } = require("./services/audit");
const { buildProcessor } = require("./services/processor");
const { buildPurger } = require("./services/purger");
const { run } = require("./services/converter");
const { createLogger } = require("./logger");
const { connectMongo } = require("./db/mongo");
const { buildMeetingRepo } = require("./services/meetingRepo");
const { buildMeetingAudit } = require("./services/meetingAudit");
const { buildFirefliesConnectionStore } = require("./services/firefliesConnectionStore");
const { buildFirefliesClient } = require("./services/firefliesClient");
const { buildMeetingImportService } = require("./services/meetingImportService");

const log = createLogger("worker");

// What the converter depends on, written once at start-up so a missing tool or font is obvious in the log
// instead of showing up later as a bad slide.
async function logToolchain(config) {
  const probes = [
    ["soffice", process.env.SOFFICE_BIN || "soffice", ["--version"]],
    ["pdftoppm", process.env.PDFTOPPM_BIN || "pdftoppm", ["-v"]],
    ["pdfinfo", process.env.PDFINFO_BIN || "pdfinfo", ["-v"]],
  ];
  for (const [name, cmd, args] of probes) {
    try {
      const out = await run(cmd, args, { timeoutMs: 60000, env: { HOME: config.uploadTmpDir } });
      const text = `${out.stdout}\n${out.stderr}`.trim().split("\n")[0];
      if (out.code === 0 || text) log.info(`${name} available`, { version: text, exit: out.code });
      else log.warn(`${name} did not answer`, { exit: out.code });
    } catch (err) {
      log.error(`${name} is NOT available: conversions will fail`, { cmd, error: err });
    }
  }
  try {
    const fonts = await run("fc-list", [":", "family"], { timeoutMs: 30000 });
    const families = new Set(
      fonts.stdout.split("\n").map((line) => line.split(",")[0].trim()).filter(Boolean),
    );
    log.info("fonts installed for rendering", { families: families.size, sample: [...families].sort().slice(0, 40) });
    log.info("deck fonts installed?", {
      "Bebas Neue": [...families].some((f) => /bebas/i.test(f)),
      Poppins: [...families].some((f) => /poppins/i.test(f)),
      Alexandria: [...families].some((f) => /alexandria/i.test(f)),
      Inter: [...families].some((f) => f === "Inter"),
    });
  } catch (err) {
    log.warn("could not list installed fonts (fc-list)", { error: err });
  }
}

// Separate process from the API so a hung LibreOffice can never block requests.
async function main() {
  const config = getConfig();
  log.info("starting", {
    node: process.version,
    env: config.nodeEnv,
    logLevel: process.env.WEEKLY_REPORTS_LOG_LEVEL || "info",
    db: { host: config.db.host, port: config.db.port, name: config.db.database, pool: config.db.connectionLimit },
    bucket: config.bucket,
    region: config.region,
    tmpDir: config.uploadTmpDir,
    pollMs: config.workerPollMs,
    cancelPollMs: config.cancelPollMs,
    convertTimeoutMs: config.convertTimeoutMs,
    maxSlides: config.maxSlides,
    slideWidth: config.slideWidth,
    thumbWidth: config.thumbWidth,
  });

  const pool = createPool(config);
  const repo = buildReportsRepo(pool, { logger: log.child("repo") });
  const storage = buildStorage(config, { logger: log.child("storage") });
  const audit = buildAudit(pool, log.child("audit"));
  const processor = buildProcessor({ config, repo, storage, audit, logger: log.child("process") });
  const purger = buildPurger({ repo, storage, logger: log.child("purger") });
  const workerId = `${os.hostname()}:${process.pid}`;

  // Meeting Pointers: Fireflies imports are claimed from MySQL like conversions. They are handled in their own
  // try/catch below, so a Fireflies, Mongo or schema problem can never stop report conversions.
  const meetingRepo = buildMeetingRepo(pool, { logger: log.child("meeting-repo") });
  const meetings = buildMeetingImportService({
    config,
    repo: meetingRepo,
    connections: buildFirefliesConnectionStore({ config }),
    firefliesClient: buildFirefliesClient({ timeoutMs: config.fireflies.timeoutMs, logger: log.child("fireflies") }),
    audit: buildMeetingAudit(pool, log.child("meeting-audit")),
    logger: log.child("meeting-import"),
  });
  let meetingsPausedUntil = 0;

  let stopping = false;
  const stop = (signal) => {
    log.warn("stop requested, finishing the current job first", { signal });
    stopping = true;
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("unhandledRejection", (reason) => log.error("unhandled promise rejection", { error: reason }));
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception, exiting", { error: err });
    process.exit(1);
  });

  await repo.checkSchema();
  await meetingRepo.checkSchema();
  connectMongo(config, log.child("mongo")).catch((err) => log.error("mongo connect failed", { error: err }));
  await logToolchain(config);
  log.info(`started as ${workerId}`, { workerId });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // A job locked longer than the conversion timeout (plus grace) belongs to a dead worker or a
  // stuck upload.
  const staleAfterMs = config.convertTimeoutMs + 60 * 1000;
  const IDLE_LOG_EVERY_MS = 10 * 60 * 1000;
  let lastIdleLog = Date.now();
  let jobsDone = 0;

  while (!stopping) {
    try {
      const failed = await repo.failStale(staleAfterMs);
      if (failed) log.warn("marked stuck report(s) FAILED", { count: failed, staleAfterMs });

      // Remove the S3 files of deleted/cancelled reports (retries anything the API could not finish).
      const swept = await purger.sweep(5);
      if (swept.purged) log.info("removed the files of deleted report(s)", swept);

      // Fireflies imports first: they are short. A failure here (for example the migration is not applied yet) is
      // logged once and the imports are paused for a minute; report conversions carry on regardless.
      if (Date.now() >= meetingsPausedUntil) {
        try {
          await meetingRepo.recoverStale(config.fireflies.staleMs, config.fireflies.maxAttempts);
          const importJob = await meetingRepo.claimNextImport(workerId);
          if (importJob) {
            const outcome = await meetings.processImport(importJob);
            log.info("import processed", { import: importJob.id, brand: importJob.brandKey, status: outcome.status });
            // No `continue`: one import per pass, then conversions get their turn, so neither starves the other.
          }
        } catch (err) {
          meetingsPausedUntil = Date.now() + 60 * 1000;
          log.error("meeting import polling failed (paused for 1 minute, conversions are not affected)", { error: err });
        }
      }

      const job = await repo.claimNext(workerId);
      if (job) {
        log.info("claimed a report", { report: job.id, brand: job.brandKey, sourceType: job.sourceType, workerId });
        const result = await processor.process(job);
        jobsDone += 1;
        log.info("report processed", { report: job.id, brand: job.brandKey, result, jobsDone });
        continue; // look for the next job immediately
      }
      if (Date.now() - lastIdleLog >= IDLE_LOG_EVERY_MS) {
        log.info("idle, no reports waiting", { jobsDone, uptimeMin: Math.round(process.uptime() / 60) });
        lastIdleLog = Date.now();
      }
    } catch (err) {
      log.error("worker loop error (will retry)", { error: err });
    }
    await sleep(config.workerPollMs);
  }
  log.info("stopped", { jobsDone });
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  log.error("fatal, the worker could not start", { error: err });
  process.exit(1);
});
