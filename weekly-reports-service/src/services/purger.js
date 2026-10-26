// Removes a deleted or cancelled report's files from S3 and records that it is done.
// Used in two places: the API tries immediately, and the worker's sweep retries anything left over
// (S3 down, a worker still using the files, a crash), so files never stay behind for good.
function buildPurger({ repo, storage, logger = console }) {
  async function purge({ id, brandKey }) {
    try {
      await storage.removePrefix(storage.reportPrefix(brandKey, id));
      await repo.markPurged(id);
      return true;
    } catch (err) {
      logger.error("[weekly-reports] could not remove files for report", id, err && err.message);
      return false;
    }
  }

  async function sweep(limit = 5) {
    const rows = await repo.claimPurgeBatch(limit);
    let purged = 0;
    for (const row of rows) {
      if (await purge({ id: row.id, brandKey: row.brandKey })) purged += 1;
    }
    return { found: rows.length, purged };
  }

  return { purge, sweep };
}

module.exports = { buildPurger };
