const { httpError } = require("../errors");

// Every method that is reachable from a request takes the brand key and puts it in the WHERE
// clause. A report id alone never grants access (PRD section 9 / SEC-3).
const REPORT_COLUMNS = `id, brand_key, title, reporting_week, version, source_type, source_size_bytes, status,
  stage, slide_count, slides_total, slides_done, error_code, error_detail, uploaded_by, published_by,
  uploaded_at, published_at, created_at, updated_at`;

function buildReportsRepo(pool) {
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
    // Creates the next version for (brand, week). The row starts "locked" so the worker does not
    // claim it while the source file is still being uploaded to S3.
    async createReport({ brandKey, title, reportingWeek, sourceType, uploadedBy }) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          return await inTransaction(async (conn) => {
            const [rows] = await conn.query(
              "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM weekly_reports WHERE brand_key = ? AND reporting_week = ?",
              [brandKey, reportingWeek],
            );
            const version = Number(rows[0].next);
            const [res] = await conn.query(
              `INSERT INTO weekly_reports
                 (brand_key, title, reporting_week, version, source_type, status, locked_at, locked_by, uploaded_by)
               VALUES (?, ?, ?, ?, ?, 'PROCESSING', UTC_TIMESTAMP(), 'upload', ?)`,
              [brandKey, title, reportingWeek, version, sourceType, uploadedBy],
            );
            return { id: Number(res.insertId), version };
          });
        } catch (err) {
          // Two uploads for the same week raced for the same version number: retry.
          if (err && err.code === "ER_DUP_ENTRY") continue;
          throw err;
        }
      }
      throw httpError(409, "VERSION_CONFLICT", "Could not allocate a version. Try again.");
    },

    // Source stored: record where it is and let the worker claim it.
    async releaseForProcessing(id, brandKey, { sourceKey, sizeBytes, sha256 }) {
      await pool.query(
        `UPDATE weekly_reports
            SET source_storage_key = ?, source_size_bytes = ?, source_sha256 = ?, locked_at = NULL, locked_by = NULL,
                stage = 'QUEUED', slides_total = NULL, slides_done = 0
          WHERE id = ? AND brand_key = ? AND status = 'PROCESSING'`,
        [sourceKey, sizeBytes, sha256, id, brandKey],
      );
    },

    async markFailed(id, code, detail) {
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
      });
    },

    async unpublish(id, brandKey) {
      const [res] = await pool.query(
        "UPDATE weekly_reports SET status = 'UNPUBLISHED' WHERE id = ? AND brand_key = ? AND status = 'PUBLISHED' AND deleted_at IS NULL",
        [id, brandKey],
      );
      if (!res.affectedRows) throw httpError(409, "INVALID_STATE", "Only a published report can be unpublished.");
    },

    async softDelete(id, brandKey) {
      const [res] = await pool.query(
        `UPDATE weekly_reports SET deleted_at = UTC_TIMESTAMP()
          WHERE id = ? AND brand_key = ? AND deleted_at IS NULL AND status IN ('READY','UNPUBLISHED','FAILED')`,
        [id, brandKey],
      );
      if (!res.affectedRows) {
        throw httpError(409, "INVALID_STATE", "Unpublish the report before deleting it. A report that is processing cannot be deleted.");
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
        return { id: Number(row.id), brandKey: row.brand_key, sourceKey: row.source_storage_key, sourceType: row.source_type };
      });
    },

    // Live progress for the UI. Only touches a report that is still processing.
    async setProgress(id, { stage, slidesTotal = null, slidesDone = null }) {
      await pool.query(
        "UPDATE weekly_reports SET stage = ?, slides_total = ?, slides_done = ? WHERE id = ? AND status = 'PROCESSING'",
        [stage, slidesTotal, slidesDone, id],
      );
    },

    async complete(id, slides) {
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
      return res.affectedRows || 0;
    },

    async isDeleted(id) {
      const [rows] = await pool.query("SELECT deleted_at FROM weekly_reports WHERE id = ?", [id]);
      return !rows[0] || rows[0].deleted_at !== null;
    },
  };
}

module.exports = { buildReportsRepo };
