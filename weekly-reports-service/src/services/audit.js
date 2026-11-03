const { ensureLogger } = require("../logger");

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

function buildAudit(pool, logger) {
  const log = ensureLogger(logger, "audit");
  return {
    ACTIONS,
    async record({ brandKey, reportId = null, userId = null, action, metadata = null }) {
      try {
        await pool.query(
          "INSERT INTO weekly_report_events (brand_key, report_id, user_id, action, metadata) VALUES (?, ?, ?, ?, ?)",
          [brandKey, reportId, userId, action, metadata ? JSON.stringify(metadata) : null],
        );
        // Access denials are security events: they are worth a warning, the rest is routine.
        const write = action === ACTIONS.ACCESS_DENIED ? log.warn : log.info;
        write(`recorded ${action}`, { brand: brandKey, report: reportId, user: userId, metadata });
      } catch (err) {
        log.error("audit write failed (the request continues)", { action, brand: brandKey, report: reportId, error: err });
      }
    },
  };
}

module.exports = { buildAudit, ACTIONS };
