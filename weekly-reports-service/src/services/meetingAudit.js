const { ensureLogger } = require("../logger");

// Audit events for Meeting Pointers (table meeting_pointer_events). Same contract as services/audit.js: a failed
// audit write is logged but never blocks the request or the import. Callers must never put secrets in
// before/after (the API key and the AES key are never passed here).
const MEETING_ACTIONS = Object.freeze({
  FIREFLIES_CONFIGURATION_CREATED: "FIREFLIES_CONFIGURATION_CREATED",
  FIREFLIES_CONFIGURATION_UPDATED: "FIREFLIES_CONFIGURATION_UPDATED",
  IMPORT_REQUESTED: "IMPORT_REQUESTED",
  IMPORT_STARTED: "IMPORT_STARTED",
  IMPORT_SUCCEEDED: "IMPORT_SUCCEEDED",
  IMPORT_FAILED: "IMPORT_FAILED",
  DUPLICATE_DETECTED: "DUPLICATE_DETECTED",
});

function buildMeetingAudit(pool, logger) {
  const log = ensureLogger(logger, "meeting-audit");
  return {
    ACTIONS: MEETING_ACTIONS,
    async record({ brandKey = null, actor = null, action, entityType, entityId = null, before = null, after = null }) {
      try {
        await pool.query(
          "INSERT INTO meeting_pointer_events (brand_key, actor, action, entity_type, entity_id, before_state, after_state) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            brandKey, actor, action, entityType, entityId === null ? null : String(entityId),
            before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
          ],
        );
        log.info(`recorded ${action}`, { brand: brandKey, entity: entityType, id: entityId, actor });
      } catch (err) {
        log.error("meeting audit write failed (the request continues)", { action, brand: brandKey, entity: entityType, id: entityId, error: err });
      }
    },
  };
}

module.exports = { buildMeetingAudit, MEETING_ACTIONS };
