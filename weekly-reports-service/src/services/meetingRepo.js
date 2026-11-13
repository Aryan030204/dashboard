const { httpError } = require("../errors");
const { ensureLogger } = require("../logger");

// MySQL access for Meeting Pointers. Every method that is reachable from a request takes the brand key and puts it
// in the WHERE clause: an id alone never grants access. Duplicate protection is done by UNIQUE keys (see migration
// 006), never by "SELECT, then INSERT if missing".
const IMPORT_COLUMNS = `id, brand_key, fireflies_transcript_id, source_url, status, error_code, error_message,
  attempts, meeting_id, requested_by, created_at, updated_at, finished_at`;
const MEETING_COLUMNS = `id, brand_key, fireflies_transcript_id, title, meeting_date, organizer, attendees, summary,
  source_url, imported_by, created_at, updated_at`;
const POINTER_COLUMNS = `id, brand_key, meeting_id, source_key, original_text, refined_title, refined_description,
  assignee, due_date, priority, category, labels, review_state, created_at, updated_at`;

const isDuplicate = (err) => Boolean(err) && (err.code === "ER_DUP_ENTRY" || err.errno === 1062);

function buildMeetingRepo(pool, { logger } = {}) {
  const log = ensureLogger(logger, "meeting-repo");

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

  const repo = {
    async findMeetingByTranscript(brandKey, transcriptId) {
      const [rows] = await pool.query(
        `SELECT ${MEETING_COLUMNS} FROM meeting_records WHERE brand_key = ? AND fireflies_transcript_id = ? LIMIT 1`,
        [brandKey, transcriptId],
      );
      return rows[0] || null;
    },

    async findActiveImport(brandKey, transcriptId) {
      const [rows] = await pool.query(
        `SELECT ${IMPORT_COLUMNS} FROM meeting_imports
          WHERE brand_key = ? AND fireflies_transcript_id = ? AND status IN ('QUEUED','FETCHING') LIMIT 1`,
        [brandKey, transcriptId],
      );
      return rows[0] || null;
    },

    // QUEUED job. If another import of the same meeting is already queued or running, the UNIQUE active_key
    // refuses it and the caller gets a 409 that points at the running import.
    async createImport({ brandKey, transcriptId, sourceUrl, requestedBy }) {
      try {
        const [res] = await pool.query(
          `INSERT INTO meeting_imports (brand_key, fireflies_transcript_id, source_url, status, next_attempt_at, requested_by)
           VALUES (?, ?, ?, 'QUEUED', UTC_TIMESTAMP(), ?)`,
          [brandKey, transcriptId, sourceUrl, requestedBy],
        );
        return { id: Number(res.insertId) };
      } catch (err) {
        if (!isDuplicate(err)) throw err;
        const existing = await repo.findActiveImport(brandKey, transcriptId);
        log.warn("import refused: the same meeting is already being imported", { brand: brandKey, transcript: transcriptId, existingImport: existing && Number(existing.id) });
        const error = httpError(409, "DUPLICATE_MEETING", "This meeting is already being imported.");
        error.importId = existing ? Number(existing.id) : null;
        throw error;
      }
    },

    async findImport(id, brandKey) {
      const [rows] = await pool.query(`SELECT ${IMPORT_COLUMNS} FROM meeting_imports WHERE id = ? AND brand_key = ?`, [id, brandKey]);
      return rows[0] || null;
    },

    async findMeeting(id, brandKey) {
      const [rows] = await pool.query(`SELECT ${MEETING_COLUMNS} FROM meeting_records WHERE id = ? AND brand_key = ?`, [id, brandKey]);
      return rows[0] || null;
    },

    async listPointers(meetingId, brandKey) {
      const [rows] = await pool.query(
        `SELECT ${POINTER_COLUMNS} FROM meeting_pointers WHERE meeting_id = ? AND brand_key = ? ORDER BY id`,
        [meetingId, brandKey],
      );
      return rows;
    },

    // ---- worker side -----------------------------------------------------------------------------

    async claimNextImport(workerId) {
      return inTransaction(async (conn) => {
        const [rows] = await conn.query(
          `SELECT id, brand_key, fireflies_transcript_id, source_url, requested_by, attempts FROM meeting_imports
            WHERE status = 'QUEUED' AND next_attempt_at <= UTC_TIMESTAMP()
            ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        );
        const row = rows[0];
        if (!row) return null;
        await conn.query(
          "UPDATE meeting_imports SET status = 'FETCHING', locked_at = UTC_TIMESTAMP(), locked_by = ?, attempts = attempts + 1 WHERE id = ?",
          [workerId, row.id],
        );
        return {
          id: Number(row.id),
          brandKey: row.brand_key,
          transcriptId: row.fireflies_transcript_id,
          sourceUrl: row.source_url,
          requestedBy: row.requested_by,
          attempts: Number(row.attempts) + 1,
        };
      });
    },

    // Meeting + raw pointers + IMPORTED, all or nothing. Returns { meetingId } or { duplicate: true, meetingId }
    // when the brand already has this meeting (the UNIQUE key decided, not a prior SELECT).
    async completeImport({ importId, brandKey, connectionId, importedBy, meeting, pointers }) {
      try {
        return await inTransaction(async (conn) => {
          const [res] = await conn.query(
            `INSERT INTO meeting_records
               (brand_key, fireflies_connection_id, fireflies_transcript_id, title, meeting_date, organizer, attendees, summary, source_url, imported_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              brandKey, connectionId || null, meeting.transcriptId, meeting.title, meeting.meetingDate || null,
              meeting.organizer || null, JSON.stringify(meeting.attendees || []), meeting.summary || null,
              meeting.sourceUrl || null, importedBy,
            ],
          );
          const meetingId = Number(res.insertId);
          if (pointers.length) {
            await conn.query(
              "INSERT INTO meeting_pointers (brand_key, meeting_id, source_key, original_text) VALUES ?",
              [pointers.map((p) => [brandKey, meetingId, p.sourceKey, p.originalText])],
            );
          }
          const [upd] = await conn.query(
            `UPDATE meeting_imports
                SET status = 'IMPORTED', meeting_id = ?, error_code = NULL, error_message = NULL,
                    locked_at = NULL, locked_by = NULL, finished_at = UTC_TIMESTAMP()
              WHERE id = ? AND brand_key = ? AND status = 'FETCHING'`,
            [meetingId, importId, brandKey],
          );
          if (!upd.affectedRows) throw Object.assign(new Error("import is no longer being fetched"), { lostClaim: true });
          return { meetingId };
        });
      } catch (err) {
        if (isDuplicate(err)) {
          const existing = await repo.findMeetingByTranscript(brandKey, meeting.transcriptId);
          return { duplicate: true, meetingId: existing ? Number(existing.id) : null };
        }
        throw err;
      }
    },

    // Terminal state (IMPORTED is written by completeImport). `status` is one of the failure states.
    async finishImport(id, brandKey, { status, code, message, meetingId = null }) {
      await pool.query(
        `UPDATE meeting_imports
            SET status = ?, error_code = ?, error_message = ?, meeting_id = ?, locked_at = NULL, locked_by = NULL, finished_at = UTC_TIMESTAMP()
          WHERE id = ? AND brand_key = ? AND status = 'FETCHING'`,
        [status, String(code).slice(0, 64), String(message || "").slice(0, 500), meetingId, id, brandKey],
      );
    },

    // Retryable failure: back to QUEUED, not claimable before next_attempt_at.
    async scheduleRetry(id, brandKey, { delayMs, code, message }) {
      const seconds = Math.max(1, Math.ceil(delayMs / 1000));
      await pool.query(
        `UPDATE meeting_imports
            SET status = 'QUEUED', error_code = ?, error_message = ?, locked_at = NULL, locked_by = NULL,
                next_attempt_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND)
          WHERE id = ? AND brand_key = ? AND status = 'FETCHING'`,
        [String(code).slice(0, 64), String(message || "").slice(0, 500), seconds, id, brandKey],
      );
    },

    // A job left FETCHING by a crashed worker is requeued, or failed once it has used all its attempts.
    async recoverStale(staleMs, maxAttempts) {
      const seconds = Math.ceil(staleMs / 1000);
      const [failed] = await pool.query(
        `UPDATE meeting_imports
            SET status = 'FETCH_FAILED', error_code = 'IMPORT_FAILED', error_message = 'The import did not finish. Start it again.',
                locked_at = NULL, locked_by = NULL, finished_at = UTC_TIMESTAMP()
          WHERE status = 'FETCHING' AND locked_at < (UTC_TIMESTAMP() - INTERVAL ? SECOND) AND attempts >= ?`,
        [seconds, maxAttempts],
      );
      const [requeued] = await pool.query(
        `UPDATE meeting_imports
            SET status = 'QUEUED', locked_at = NULL, locked_by = NULL, next_attempt_at = UTC_TIMESTAMP()
          WHERE status = 'FETCHING' AND locked_at < (UTC_TIMESTAMP() - INTERVAL ? SECOND) AND attempts < ?`,
        [seconds, maxAttempts],
      );
      const out = { failed: failed.affectedRows || 0, requeued: requeued.affectedRows || 0 };
      if (out.failed || out.requeued) log.warn("recovered stuck imports", out);
      return out;
    },

    // Start-up check: migration 006 must have been applied.
    async checkSchema() {
      try {
        const missing = [];
        for (const table of ["meeting_records", "meeting_imports", "meeting_pointers", "meeting_pointer_events"]) {
          const [rows] = await pool.query("SHOW TABLES LIKE ?", [table]);
          if (!rows.length) missing.push(table);
        }
        if (missing.length) {
          log.error("schema check FAILED: Meeting Pointers tables are missing. Apply migrations/006-create-meeting-pointers.sql", { missing });
        } else {
          log.info("schema check ok: Meeting Pointers tables exist");
        }
        return { ok: missing.length === 0, missing };
      } catch (err) {
        log.error("meeting schema check could not run", { error: err });
        return { ok: false, missing: null };
      }
    },
  };
  return repo;
}

module.exports = { buildMeetingRepo };
