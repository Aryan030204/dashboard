const { ensureLogger, stopwatch } = require("../logger");

// Removes a deleted or cancelled report's files from S3 and records that it is done.
// Used in two places: the API tries immediately, and the worker's sweep retries anything left over
// (S3 down, a worker still using the files, a crash), so files never stay behind for good.
function buildPurger({ repo, storage, logger }) {
  const log = ensureLogger(logger, "purger");

  async function purge({ id, brandKey }) {
    const elapsed = stopwatch();
    try {
      const prefix = storage.reportPrefix(brandKey, id);
      log.info("removing the files of a deleted report", { report: id, brand: brandKey, prefix });
      await storage.removePrefix(prefix);
      await repo.markPurged(id);
      log.info("files removed", { report: id, brand: brandKey, ms: elapsed() });
      return true;
    } catch (err) {
      log.error("could not remove the files of a report (the cleanup sweep will retry)", { report: id, brand: brandKey, ms: elapsed(), error: err });
      return false;
    }
  }

  async function sweep(limit = 5) {
    const rows = await repo.claimPurgeBatch(limit);
    if (rows.length) log.info("cleanup sweep found reports to purge", { found: rows.length, ids: rows.map((r) => r.id) });
    let purged = 0;
    for (const row of rows) {
      if (await purge({ id: row.id, brandKey: row.brandKey })) purged += 1;
    }
    return { found: rows.length, purged };
  }

  return { purge, sweep };
}

module.exports = { buildPurger };
