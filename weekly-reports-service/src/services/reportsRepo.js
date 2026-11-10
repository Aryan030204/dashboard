const { httpError } = require("../errors");
const { uniqueTitle } = require("./uniqueTitle");
const { ensureLogger, stopwatch } = require("../logger");

// Every method that is reachable from a request takes the brand key and puts it in the WHERE
// clause. A report id alone never grants access (PRD section 9 / SEC-3).
const REPORT_COLUMNS = `id, brand_key, title, reporting_week, description, version, source_type, source_size_bytes, status,
  stage, slide_count, slides_total, slides_done, error_code, error_detail, uploaded_by, published_by,
  uploaded_at, published_at, created_at, updated_at`;

async function titleTaken(db, brandKey, title) {
  const [rows] = await db.query(
    "SELECT 1 FROM weekly_reports WHERE brand_key = ? AND deleted_at IS NULL AND title = ? LIMIT 1",
    [brandKey, title],
  );
  return rows.length > 0;
}

function buildReportsRepo(pool, { logger } = {}) {
  const log = ensureLogger(logger, "repo");

  async function inTransaction(fn) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      try {
        await conn.rollback();
      } catch (_) {
        /* ignore */
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  return {
    // Is this exact title (case-insensitive, per the table collation) already used by another
    // presentation of the brand? Deleted and cancelled presentations do not count.
    async isTitleTaken(brandKey, title) {
      return titleTaken(pool, brandKey, title);
    },

    // Duplicate warnings shown BEFORE an upload: the title (with the name it would be saved under)
    // and how many presentations already exist for the same reporting week.
    async findDuplicates(brandKey, { title, reportingWeek }) {
      const taken = await titleTaken(pool, brandKey, title);
      const suggestedTitle = taken ? await uniqueTitle((t) => titleTaken(pool, brandKey, t), title) : title;
      const [rows] = await pool.query(
        "SELECT COUNT(*) AS n FROM weekly_reports WHERE brand_key = ? AND reporting_week = ? AND deleted_at IS NULL",
        [brandKey, reportingWeek],
      );
      return { titleExists: taken, suggestedTitle, weekCount: Number(rows[0].n) };
    },

    // Creates the next version for (brand, week) and de-duplicates the title. The row starts
    // "locked" so the worker does not claim it while the source file is still uploading to S3.
    // A per-brand named lock serialises this so two uploads at once cannot take the same title or
    // version; it is released only AFTER the commit so the next upload sees this one.
    async createReport({ brandKey, title, reportingWeek, description = null, sourceType, uploadedBy }) {
      const elapsed = stopwatch();
      const conn = await pool.getConnection();
      const lockName = `wr:create:${brandKey}`;
      let locked = false;
      try {
        const [lockRows] = await conn.query("SELECT GET_LOCK(?, 10) AS got", [lockName]);
        if (Number(lockRows[0].got) !== 1) {
          log.warn("could not get the per-brand upload lock within 10s", { brand: brandKey, lockName, waitedMs: elapsed() });
          throw httpError(503, "BUSY", "Another upload for this brand is being saved. Try again in a moment.");
        }
        log.debug("per-brand upload lock acquired", { brand: brandKey, waitedMs: elapsed() });
        locked = true;
        await conn.beginTransaction();
        try {
          const finalTitle = await uniqueTitle((t) => titleTaken(conn, brandKey, t), title);
          const [rows] = await conn.query(
            "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM weekly_reports WHERE brand_key = ? AND reporting_week = ?",
            [brandKey, reportingWeek],
          );
          const version = Number(rows[0].next);
          const [res] = await conn.query(
            `INSERT INTO weekly_reports
               (brand_key, title, reporting_week, description, version, source_type, status, locked_at, locked_by, uploaded_by)
             VALUES (?, ?, ?, ?, ?, ?, 'PROCESSING', UTC_TIMESTAMP(), 'upload', ?)`,
            [brandKey, finalTitle, reportingWeek, description || null, version, sourceType, uploadedBy],
          );
          await conn.commit();
          log.info("report row created", {
            report: Number(res.insertId), brand: brandKey, version, reportingWeek, sourceType,
            title: finalTitle, titleAdjusted: finalTitle !== title, ms: elapsed(),
          });
          return { id: Number(res.insertId), version, title: finalTitle };
        } catch (err) {
          try {
            await conn.rollback();
          } catch (_) {
            /* ignore */
          }
          log.error("creating the report row failed, rolled back", { brand: brandKey, reportingWeek, ms: elapsed(), error: err });
          throw err;
        }
      } finally {
        if (locked) {
          try {
            await conn.query("SELECT RELEASE_LOCK(?)", [lockName]);
          } catch (_) {
            /* the lock is dropped when the connection closes anyway */
          }
        }
        conn.release();
      }
    },

    // Source stored: record where it is and let the worker claim it.
    async releaseForProcessing(id, brandKey, { sourceKey, sizeBytes, sha256 }) {
      const [res] = await pool.query(
        `UPDATE weekly_reports
            SET source_storage_key = ?, source_size_bytes = ?, source_sha256 = ?, locked_at = NULL, locked_by = NULL,
                stage = 'QUEUED', slides_total = NULL, slides_done = 0
          WHERE id = ? AND brand_key = ? AND status = 'PROCESSING'`,
        [sourceKey, sizeBytes, sha256, id, brandKey],
      );
      if (res && res.affectedRows === 0) {
        log.warn("report was not queued: no PROCESSING row matched (deleted or cancelled meanwhile?)", { report: id, brand: brandKey });
      } else {
        log.info("report queued for the worker", { report: id, brand: brandKey, sourceKey, sizeBytes, sha256: String(sha256 || "").slice(0, 12) });
      }
    },

    async markFailed(id, code, detail) {
      log.warn("marking the report FAILED", { report: id, code, detail });
      await pool.query(
        `UPDATE weekly_reports SET status = 'FAILED', error_code = ?, error_detail = ?, locked_at = NULL, locked_by = NULL
          WHERE id = ? AND status = 'PROCESSING'`,
        [String(code).slice(0, 64), String(detail || "").slice(0, 1000), id],
      );
    },

    async findById(id) {
      const [rows] = await pool.query(`SELECT ${REPORT_COLUMNS} FROM weekly_reports WHERE id = ? AND deleted_at IS NULL`, [id]);
      return rows[0] || null;
    },

    // Elevated users see every report of the brand; everyone else only the published ones.
    async listByBrand(brandKey, { publishedOnly = false } = {}) {
      const [rows] = await pool.query(
        `SELECT ${REPORT_COLUMNS} FROM weekly_reports
          WHERE brand_key = ? AND deleted_at IS NULL ${publishedOnly ? "AND status = 'PUBLISHED'" : ""}
          ORDER BY ${publishedOnly ? "published_at DESC" : "created_at DESC"}, id DESC LIMIT 200`,
        [brandKey],
      );
      return rows;
    },

    async getSlide(reportId, slideNumber) {
      const [rows] = await pool.query(
        "SELECT slide_number, image_storage_key, thumbnail_storage_key FROM weekly_report_slides WHERE report_id = ? AND slide_number = ?",
        [reportId, slideNumber],
      );
      return rows[0] || null;
    },

    // Publishing only changes the target report. Any number of presentations can be published at
    // once; which ones stay published is the admin's decision (they unpublish the rest).
    async publish(id, brandKey, userId) {
      return inTransaction(async (conn) => {
        const [rows] = await conn.query(
          "SELECT id, status FROM weekly_reports WHERE id = ? AND brand_key = ? AND deleted_at IS NULL FOR UPDATE",
          [id, brandKey],
        );
        const row = rows[0];
        if (!row) throw httpError(404, "NOT_FOUND", "Report not found.");
        if (!["READY", "UNPUBLISHED"].includes(row.status)) {
          throw httpError(409, "INVALID_STATE", `A ${row.status} report cannot be published.`);
        }
        await conn.query(
          "UPDATE weekly_reports SET status = 'PUBLISHED', published_at = UTC_TIMESTAMP(), published_by = ? WHERE id = ?",
          [userId, id],
        );
        log.info("report published", { report: id, brand: brandKey, user: userId, from: row.status });
      });
    },

    async unpublish(id, brandKey) {
      const [res] = await pool.query(
        "UPDATE weekly_reports SET status = 'UNPUBLISHED' WHERE id = ? AND brand_key = ? AND status = 'PUBLISHED' AND deleted_at IS NULL",
        [id, brandKey],
      );
      if (!res.affectedRows) {
        log.warn("unpublish refused: the report is not published", { report: id, brand: brandKey });
        throw httpError(409, "INVALID_STATE", "Only a published report can be unpublished.");
      }
      log.info("report unpublished", { report: id, brand: brandKey });
    },

    async softDelete(id, brandKey) {
      const [res] = await pool.query(
        `UPDATE weekly_reports SET deleted_at = UTC_TIMESTAMP()
          WHERE id = ? AND brand_key = ? AND deleted_at IS NULL AND status IN ('READY','UNPUBLISHED','FAILED')`,
        [id, brandKey],
      );
      if (!res.affectedRows) {
        log.warn("delete refused: the report is published, processing or already deleted", { report: id, brand: brandKey });
        throw httpError(409, "INVALID_STATE", "Unpublish the report before deleting it. A report that is processing cannot be deleted.");
      }
      log.info("report deleted (files are removed next)", { report: id, brand: brandKey });
    },

    // Cancels a report that is still processing (queued or converting): hides it at once and marks its
    // files for removal. Returns whether the files can be removed right now: not while a worker or an
    // in-flight upload still holds the report, because they could write more files after the purge.
    async cancel(id, brandKey) {
      return inTransaction(async (conn) => {
        const [rows] = await conn.query(
          "SELECT status, locked_at FROM weekly_reports WHERE id = ? AND brand_key = ? AND deleted_at IS NULL FOR UPDATE",
          [id, brandKey],
        );
        const row = rows[0];
        if (!row) throw httpError(404, "NOT_FOUND", "Report not found.");
        if (row.status !== "PROCESSING") {
          throw httpError(409, "INVALID_STATE", "Only a report that is still processing can be cancelled.");
        }
        await conn.query("UPDATE weekly_reports SET deleted_at = UTC_TIMESTAMP() WHERE id = ?", [id]);
        log.info("report cancelled", { report: id, brand: brandKey, heldByWorkerOrUpload: row.locked_at !== null });
        return { purgeNow: row.locked_at === null };
      });
    },

    // Author-only edit of the description. The brand is in the WHERE clause like every other write.
    async updateDescription(id, brandKey, description) {
      const [res] = await pool.query(
        "UPDATE weekly_reports SET description = ? WHERE id = ? AND brand_key = ? AND deleted_at IS NULL",
        [description || null, id, brandKey],
      );
      if (!res.affectedRows) {
        // MySQL reports 0 affected rows when the value is unchanged, so confirm the report exists.
        const [rows] = await pool.query(
          "SELECT 1 FROM weekly_reports WHERE id = ? AND brand_key = ? AND deleted_at IS NULL",
          [id, brandKey],
        );
        if (!rows.length) throw httpError(404, "NOT_FOUND", "Report not found.");
      }
      log.info("report description updated", { report: id, brand: brandKey, words: description ? description.split(/\s+/).length : 0 });
    },

    async markPurged(id) {
      log.debug("files marked as removed", { report: id });
      await pool.query("UPDATE weekly_reports SET storage_purged_at = UTC_TIMESTAMP() WHERE id = ?", [id]);
    },

    // Deleted/cancelled reports whose files are still in S3 and that nothing is using any more.
    async claimPurgeBatch(limit = 5) {
      const [rows] = await pool.query(
        `SELECT id, brand_key FROM weekly_reports
          WHERE deleted_at IS NOT NULL AND storage_purged_at IS NULL AND locked_at IS NULL
          ORDER BY id LIMIT ?`,
        [Number(limit)],
      );
      return rows.map((r) => ({ id: Number(r.id), brandKey: r.brand_key }));
    },

    // A worker that stops because its report was cancelled lets go of it, so the files can be purged.
    async releaseLock(id) {
      log.info("worker let go of the report", { report: id });
      await pool.query("UPDATE weekly_reports SET locked_at = NULL, locked_by = NULL WHERE id = ?", [id]);
    },

    // Run at start-up by the API and the worker. Logs an ERROR when a migration is missing, because the symptoms
    // (a PDF stored with an empty type, then converted by LibreOffice instead of read directly) are easy to miss.
    async checkSchema() {
      try {
        const [rows] = await pool.query("SHOW COLUMNS FROM weekly_reports LIKE 'source_type'");
        const type = rows[0] && rows[0].Type ? String(rows[0].Type) : "";
        const pdfAllowed = /'pdf'/i.test(type);
        if (pdfAllowed) log.info("schema check ok: weekly_reports.source_type accepts pdf", { type });
        else {
          log.error("schema check FAILED: weekly_reports.source_type does not accept 'pdf'. Apply migrations/004-allow-pdf-source.sql, otherwise PDF uploads are stored with an empty type", { type });
        }
        const [descRows] = await pool.query("SHOW COLUMNS FROM weekly_reports LIKE 'description'");
        const descriptionOk = descRows.length > 0;
        if (!descriptionOk) {
          log.error("schema check FAILED: weekly_reports.description is missing. Apply migrations/005-add-description.sql, otherwise listing and uploading reports will fail");
        }
        return { ok: pdfAllowed && descriptionOk, type };
      } catch (err) {
        log.error("schema check could not run", { error: err });
        return { ok: false, type: null };
      }
    },

    // ---- worker side -------------------------------------------------------------------------

    async claimNext(workerId) {
      return inTransaction(async (conn) => {
        const [rows] = await conn.query(
          `SELECT id, brand_key, source_storage_key, source_type FROM weekly_reports
            WHERE status = 'PROCESSING' AND locked_at IS NULL AND deleted_at IS NULL AND source_storage_key <> ''
            ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        );
        const row = rows[0];
        if (!row) return null;
        await conn.query(
          "UPDATE weekly_reports SET locked_at = UTC_TIMESTAMP(), locked_by = ?, attempts = attempts + 1, stage = 'CONVERTING' WHERE id = ?",
          [workerId, row.id],
        );
        // A database that has not had migration 004 stores 'pdf' as '' (the column only knows pptx/ppt). The file
        // name written by the upload always ends in the real type, so use that instead of treating a PDF as a deck.
        const keyExt = String(row.source_storage_key || "").split(".").pop().toLowerCase();
        const sourceType = row.source_type || (["pptx", "ppt", "pdf"].includes(keyExt) ? keyExt : "");
        if (!row.source_type) {
          log.warn("source_type is empty in the database, using the file extension instead: apply migration 004-allow-pdf-source.sql", {
            report: Number(row.id), sourceKey: row.source_storage_key, usedType: sourceType,
          });
        }
        log.info("worker claimed the report", { report: Number(row.id), brand: row.brand_key, worker: workerId, sourceType });
        return { id: Number(row.id), brandKey: row.brand_key, sourceKey: row.source_storage_key, sourceType };
      });
    },

    // Live progress for the UI. Only touches a report that is still processing.
    async setProgress(id, { stage, slidesTotal = null, slidesDone = null }) {
      log.debug("progress", { report: id, stage, slidesDone, slidesTotal });
      await pool.query(
        "UPDATE weekly_reports SET stage = ?, slides_total = ?, slides_done = ? WHERE id = ? AND status = 'PROCESSING'",
        [stage, slidesTotal, slidesDone, id],
      );
    },

    async complete(id, slides) {
      const elapsed = stopwatch();
      return inTransaction(async (conn) => {
        await conn.query("DELETE FROM weekly_report_slides WHERE report_id = ?", [id]);
        for (const s of slides) {
          await conn.query(
            "INSERT INTO weekly_report_slides (report_id, slide_number, image_storage_key, thumbnail_storage_key, width, height) VALUES (?, ?, ?, ?, ?, ?)",
            [id, s.number, s.imageKey, s.thumbKey, s.width || null, s.height || null],
          );
        }
        await conn.query(
          `UPDATE weekly_reports
              SET status = 'READY', stage = NULL, slide_count = ?, slides_total = ?, slides_done = ?,
                  error_code = NULL, error_detail = NULL, locked_at = NULL, locked_by = NULL
            WHERE id = ? AND status = 'PROCESSING'`,
          [slides.length, slides.length, slides.length, id],
        );
        log.info("report is READY", { report: id, slides: slides.length, ms: elapsed() });
      });
    },

    // Anything still PROCESSING and locked longer than the timeout (crashed worker, upload that
    // never finished) is failed so it cannot sit there forever.
    async failStale(timeoutMs) {
      const seconds = Math.ceil(timeoutMs / 1000);
      const [res] = await pool.query(
        `UPDATE weekly_reports
            SET status = 'FAILED', error_code = 'PROCESSING_TIMEOUT', error_detail = 'Processing did not finish in time.',
                locked_at = NULL, locked_by = NULL
          WHERE status = 'PROCESSING' AND locked_at IS NOT NULL AND locked_at < (UTC_TIMESTAMP() - INTERVAL ? SECOND)`,
        [seconds],
      );
      if (res.affectedRows) log.warn("failed stuck reports", { count: res.affectedRows, olderThanSeconds: seconds });
      return res.affectedRows || 0;
    },

    async isDeleted(id) {
      const [rows] = await pool.query("SELECT deleted_at FROM weekly_reports WHERE id = ?", [id]);
      return !rows[0] || rows[0].deleted_at !== null;
    },
  };
}

module.exports = { buildReportsRepo };
