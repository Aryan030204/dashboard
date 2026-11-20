// Manual mode: an author uploads the GoKwik CSV and the EasyCom export for a report date. The files are streamed from
// disk through the same pipeline core as the automated path (pipeline.processUpload) and deleted afterwards; they are
// never stored. Processing runs in the background so the request returns at once (202); the UI follows the run status.
const crypto = require("crypto");
const fs = require("fs");
const { httpError } = require("../errors");
const { ensureLogger } = require("../logger");
const { toWall } = require("../lib/wall");
const { computeWindows } = require("./processor");

// The API container is small: process one upload at a time and refuse (429) rather than queue unbounded work.
const MAX_CONCURRENT = 1;

function buildUploadService({ config, repo, pipeline, logger, now = () => Date.now() }) {
  const log = ensureLogger(logger, "upload");
  let active = 0;

  const remove = (files) => Promise.all(files.map((f) => fs.promises.unlink(f.path).catch(() => {})));

  // Returns { runId, status, done } where `done` resolves with the pipeline outcome (tests await it; the route does not).
  // The caller still owns the files if this throws; once it returns, the service deletes them when processing ends.
  async function submit({ brandKey, reportDate, userId, gokwik, easycom }) {
    const windows = computeWindows(reportDate, config.window);
    const closes = windows.ndd.end > windows.other.end ? windows.ndd.end : windows.other.end;
    if (toWall(now(), config.timezone) < closes) {
      throw httpError(400, "WINDOW_OPEN", `The reporting window for ${reportDate} has not closed yet (it closes ${closes} ${config.timezone}).`);
    }
    if (active >= MAX_CONCURRENT) throw httpError(429, "BUSY", "Another upload is being processed. Try again in a minute.");

    const lockedBy = `manual:${String(userId).slice(0, 36)}:${crypto.randomBytes(3).toString("hex")}`;
    active += 1;
    let claim;
    try {
      claim = await repo.claimForUpload({ brandKey, reportDate, windows, lockedBy, uploadedBy: userId });
    } catch (err) {
      active -= 1;
      throw err;
    }
    if (!claim.claimed) {
      active -= 1;
      throw httpError(409, "RUN_IN_PROGRESS", "That report is being processed right now. Try again when it finishes.");
    }

    const done = pipeline.processUpload(claim.run, { gokwik, easycom })
      .catch((err) => {
        log.error("manual upload processing crashed", { run: claim.run.id, error: err });
        return { outcome: "failed", runId: claim.run.id };
      })
      .finally(async () => {
        active -= 1;
        await remove([gokwik, easycom]);
      });
    log.info("manual upload accepted", { run: claim.run.id, brand: brandKey, reportDate, user: userId });
    return { runId: claim.run.id, status: "GOKWIK_RECEIVED", done };
  }

  return { submit, activeCount: () => active };
}

module.exports = { buildUploadService };
