// Audit events (PRD section 24). Datum has no platform audit log, so this stays local to the
// service. A failed audit write is logged but never blocks the request.
const ACTIONS = Object.freeze({
  UPLOADED: "REPORT_UPLOADED",
  VERSION_CREATED: "REPORT_VERSION_CREATED",
  PROCESSED: "REPORT_PROCESSED",
  PROCESSING_FAILED: "REPORT_PROCESSING_FAILED",
  PUBLISHED: "REPORT_PUBLISHED",
  UNPUBLISHED: "REPORT_UNPUBLISHED",
  DELETED: "REPORT_DELETED",
  CANCELLED: "REPORT_CANCELLED",
  ACCESS_DENIED: "ACCESS_DENIED",
});

function buildAudit(pool, logger = console) {
  return {
    ACTIONS,
    async record({ brandKey, reportId = null, userId = null, action, metadata = null }) {
      try {
        await pool.query(
          "INSERT INTO weekly_report_events (brand_key, report_id, user_id, action, metadata) VALUES (?, ?, ?, ?, ?)",
          [brandKey, reportId, userId, action, metadata ? JSON.stringify(metadata) : null],
        );
      } catch (err) {
        logger.error("[weekly-reports] audit write failed", action, err && err.message);
      }
    },
  };
}

module.exports = { buildAudit, ACTIONS };
