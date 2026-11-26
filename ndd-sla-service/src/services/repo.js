// Persistence for the NDD/SLA pipeline, written against migrations/001-create-ndd-sla.sql (never applied from here).
//
// Concurrency model (same idea as weekly-reports reportsRepo, tightened):
//   * claimNext   takes one due run with SELECT ... FOR UPDATE SKIP LOCKED and stamps locked_by / locked_at.
//   * every later write is FENCED: its WHERE includes locked_by = <this worker>, so a worker that lost its lock (stale
//     release, restart) cannot overwrite a newer attempt. A fenced write that matches nothing throws LOCK_LOST.
//   * `generation` = the last attempt that wrote rows; `active_generation` = the one the API serves (0 = none yet).
//     Rows of a new attempt are written under generation+1 and become visible only in activate(), in ONE transaction
//     that keeps ONE previous generation and deletes anything older. Keeping it means a reader that fetched the run just
//     before a re-run activated (a paging client, a long CSV export) still finds its rows; a failed attempt leaves the
//     old report untouched.
//   * attempts counts FAILED attempts only; polling for a file that has not arrived yet does not consume retries.
const { PipelineError } = require("../errors");
const { ensureLogger } = require("../logger");

const TERMINAL_NO_CLAIM = "('COMPLETED','GOKWIK_TIMEOUT','CANCELLED')";
const CONTROLS = new Set(["NONE", "PAUSE", "CANCEL"]);

// Columns a worker may set through update()/transition(); keys outside this list are rejected (no SQL from keys).
const UPDATABLE = new Set([
  "gmail_message_id", "gmail_attachment_id", "source_filename", "source_bytes", "source_sha256", "source_received_at",
  "duplicate_messages", "easycom_pages", "easycom_fetched", "rows_in", "rows_wrong_client", "rows_wrong_status",
  "rows_out_of_window", "rows_duplicate", "rows_invalid", "rows_kept", "rows_unmatched", "sla_met", "sla_breached",
  "gmail_ms", "easycom_ms", "process_ms", "error_code", "error_detail", "next_attempt_at",
  "easycom_source_filename", "control", "paused_at", "source_mode",
]);

function setClause(fields) {
  const keys = Object.keys(fields);
  for (const k of keys) if (!UPDATABLE.has(k)) throw new Error(`repo: column ${k} is not updatable`);
  return { sql: keys.map((k) => `${k} = ?`).join(", "), values: keys.map((k) => fields[k]) };
}

// "Report window" view: only orders placed inside the run's own NDD / non-NDD windows (start included, end excluded).
const WINDOW_SQL = "((is_ndd = 1 AND order_at >= ? AND order_at < ?) OR (is_ndd = 0 AND order_at >= ? AND order_at < ?))";
const windowArgs = (w) => [w.ndd.start, w.ndd.end, w.other.start, w.other.end];

function buildRepo(pool, { logger } = {}) {
  const log = ensureLogger(logger, "repo");

  async function inTransaction(fn) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      try { await conn.rollback(); } catch (_) { /* ignore */ }
      throw err;
    } finally {
      conn.release();
    }
  }

  const lost = (runId) => new PipelineError("LOCK_LOST", `Run ${runId} is no longer locked by this worker`);

  async function addEvent(db, runId, from, to, actor, metadata) {
    await db.query(
      "INSERT INTO ndd_sla_events (run_id, from_status, to_status, actor, metadata) VALUES (?, ?, ?, ?, ?)",
      [runId, from, to, String(actor).slice(0, 64), metadata ? JSON.stringify(metadata) : null],
    );
  }

  // Locks the run row for this worker or throws LOCK_LOST; returns its current status.
  async function lockedStatus(conn, runId, workerId) {
    const [rows] = await conn.query("SELECT status FROM ndd_sla_runs WHERE id = ? AND locked_by = ? FOR UPDATE", [runId, workerId]);
    if (!rows.length) throw lost(runId);
    return rows[0].status;
  }

  return {
    async checkSchema() {
      const wanted = ["ndd_sla_runs", "ndd_sla_orders", "ndd_sla_summary", "ndd_sla_events", "ndd_sla_credentials"];
      const hasColumn = async (name) => {
        const [cols] = await pool.query("SHOW COLUMNS FROM ndd_sla_runs LIKE ?", [name]);
        return cols.length > 0;
      };
      try {
        const [rows] = await pool.query(
          "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'ndd\\_sla\\_%'",
        );
        const have = new Set(rows.map((r) => String(r.name || r.TABLE_NAME).toLowerCase()));
        const missing = wanted.filter((t) => !have.has(t));
        if (missing.length) log.error("schema check FAILED: apply migrations/001-create-ndd-sla.sql", { missing });
        else if (!(await hasColumn("report_seq"))) {
          log.error("schema check FAILED: ndd_sla_runs.report_seq is missing. Apply migrations/003-multi-report-control.sql");
          return { ok: false, missing: ["ndd_sla_runs.report_seq"] };
        } else if (!(await hasColumn("source_mode"))) {
          log.error("schema check FAILED: ndd_sla_runs.source_mode is missing. Apply migrations/002-add-manual-upload.sql");
          return { ok: false, missing: ["ndd_sla_runs.source_mode"] };
        } else if (!(await pool.query("SHOW COLUMNS FROM ndd_sla_orders LIKE ?", ["marketplace"]))[0].length) {
          log.error("schema check FAILED: ndd_sla_orders.marketplace is missing. Apply migrations/004-add-marketplace.sql");
          return { ok: false, missing: ["ndd_sla_orders.marketplace"] };
        } else log.info("schema check ok");
        return { ok: missing.length === 0, missing };
      } catch (err) {
        log.error("schema check could not run", { error: err });
        return { ok: false, missing: wanted };
      }
    },

    // Idempotent: one run per (brand, report date, type). windows = { ndd:{start,end}, other:{start,end} }.
    async ensureRun({ brandKey, reportDate, windows }) {
      const [res] = await pool.query(
        `INSERT INTO ndd_sla_runs
           (brand_key, report_date, ndd_window_start, ndd_window_end, other_window_start, other_window_end)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        [brandKey, reportDate, windows.ndd.start, windows.ndd.end, windows.other.start, windows.other.end],
      );
      const created = res.affectedRows === 1 && Number(res.insertId) > 0;
      if (created) {
        await addEvent(pool, Number(res.insertId), null, "SCHEDULED", "scheduler", { reportDate });
        log.info("run scheduled", { run: Number(res.insertId), brand: brandKey, reportDate });
      }
      return { created };
    },

    // A lock without a heartbeat for lockStaleMs belongs to a dead worker. The run keeps its status and is picked up again.
    async releaseStaleLocks(lockStaleMs, pauseMaxMs = null) {
      const seconds = Math.ceil(lockStaleMs / 1000);
      // A run paused while nobody holds it (waiting for the GoKwik email) has no process to time the pause out.
      if (pauseMaxMs) {
        await pool.query(
          `UPDATE ndd_sla_runs SET status = 'CANCELLED', control = 'NONE', paused_at = NULL, next_attempt_at = NULL,
             error_code = 'PAUSE_TIMEOUT', error_detail = 'The report stayed paused too long and was cancelled.'
            WHERE control = 'PAUSE' AND locked_at IS NULL AND paused_at < (UTC_TIMESTAMP() - INTERVAL ? SECOND)
              AND status NOT IN ${TERMINAL_NO_CLAIM}`,
          [Math.ceil(pauseMaxMs / 1000)],
        );
      }
      // A manual upload whose API process died cannot be resumed (its temp files are gone): fail it for good; the
      // previous successful report stays visible and the author can upload again.
      await pool.query(
        `UPDATE ndd_sla_runs SET status = 'PROCESSING_FAILED', error_code = 'UPLOAD_INTERRUPTED',
           error_detail = 'The upload was interrupted before it finished. Upload the files again.',
           next_attempt_at = NULL, locked_at = NULL, locked_by = NULL
          WHERE source_mode = 'MANUAL' AND locked_at IS NOT NULL AND locked_at < (UTC_TIMESTAMP() - INTERVAL ? SECOND)
            AND status NOT IN ${TERMINAL_NO_CLAIM}`,
        [seconds],
      );
      const [res] = await pool.query(
        `UPDATE ndd_sla_runs SET locked_at = NULL, locked_by = NULL
          WHERE locked_at IS NOT NULL AND locked_at < (UTC_TIMESTAMP() - INTERVAL ? SECOND) AND status NOT IN ${TERMINAL_NO_CLAIM}`,
        [seconds],
      );
      if (res.affectedRows) log.warn("released stale run lock(s)", { count: res.affectedRows, olderThanSeconds: seconds });
      return res.affectedRows || 0;
    },

    async claimNext(brandKey, workerId) {
      return inTransaction(async (conn) => {
        const [rows] = await conn.query(
          `SELECT * FROM ndd_sla_runs
            WHERE brand_key = ? AND source_mode = 'AUTO' AND locked_at IS NULL AND control = 'NONE' AND status NOT IN ${TERMINAL_NO_CLAIM}
              AND (status NOT IN ('EASYCOM_FAILED','PROCESSING_FAILED') OR next_attempt_at IS NOT NULL)
              AND (next_attempt_at IS NULL OR next_attempt_at <= UTC_TIMESTAMP())
            ORDER BY report_date DESC, id DESC LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [brandKey],
        );
        const row = rows[0];
        if (!row) return null;
        await conn.query(
          "UPDATE ndd_sla_runs SET locked_at = UTC_TIMESTAMP(), locked_by = ?, next_attempt_at = NULL, started_at = COALESCE(started_at, UTC_TIMESTAMP()) WHERE id = ?",
          [workerId, row.id],
        );
        log.info("claimed run", { run: Number(row.id), brand: brandKey, status: row.status, reportDate: row.report_date, worker: workerId });
        return { ...row, id: Number(row.id), locked_by: workerId };
      });
    },

    // Proves the worker is alive (resets the stale-lock clock) and still owns the run. Returns what a user asked for
    // ("NONE" | "PAUSE" | "CANCEL") so pause/cancel need no extra polling.
    async heartbeat(runId, workerId) {
      const [res] = await pool.query("UPDATE ndd_sla_runs SET locked_at = UTC_TIMESTAMP() WHERE id = ? AND locked_by = ?", [runId, workerId]);
      if (!res.affectedRows) throw lost(runId);
      const [rows] = await pool.query("SELECT control FROM ndd_sla_runs WHERE id = ?", [runId]);
      return rows[0] ? rows[0].control : "NONE";
    },

    // A user's request to pause / resume / cancel. A run nobody holds right now is changed directly; a held run only gets
    // the flag and its process obeys at the next checkpoint. Scoped to the caller's brand.
    async setControl(brandKey, runId, control, actor = "manual") {
      if (!CONTROLS.has(control)) throw new Error(`repo: unknown control ${control}`);
      return inTransaction(async (conn) => {
        const [rows] = await conn.query(
          "SELECT id, status, locked_at, next_attempt_at, control FROM ndd_sla_runs WHERE id = ? AND brand_key = ? FOR UPDATE", [runId, brandKey],
        );
        const row = rows[0];
        if (!row) return { ok: false, reason: "NOT_FOUND" };
        const failedFinal = ["EASYCOM_FAILED", "PROCESSING_FAILED"].includes(row.status) && row.next_attempt_at === null && !row.locked_at;
        if (["COMPLETED", "GOKWIK_TIMEOUT", "CANCELLED"].includes(row.status) || failedFinal) return { ok: false, reason: "NOT_ACTIVE", status: row.status };
        if (control === "NONE" && row.control === "NONE") return { ok: true, status: row.status };
        if (control === "CANCEL" && !row.locked_at) {
          await conn.query(
            `UPDATE ndd_sla_runs SET status = 'CANCELLED', control = 'NONE', paused_at = NULL, next_attempt_at = NULL,
               error_code = 'CANCELLED', error_detail = 'Cancelled by a user.' WHERE id = ?`, [row.id],
          );
          await addEvent(conn, Number(row.id), row.status, "CANCELLED", actor, null);
          return { ok: true, status: "CANCELLED" };
        }
        await conn.query(
          `UPDATE ndd_sla_runs SET control = ?, paused_at = ${control === "PAUSE" ? "UTC_TIMESTAMP()" : "NULL"} WHERE id = ?`,
          [control, row.id],
        );
        await addEvent(conn, Number(row.id), row.status, row.status, actor, { control });
        return { ok: true, status: row.status };
      });
    },

    // The owning process acknowledges a cancel (user request or pause timeout): final, nothing retries, and the previous
    // active report stays served.
    async markCancelled(runId, workerId, { code = "CANCELLED", detail = "Cancelled by a user." } = {}) {
      return inTransaction(async (conn) => {
        const from = await lockedStatus(conn, runId, workerId);
        await conn.query(
          `UPDATE ndd_sla_runs SET status = 'CANCELLED', control = 'NONE', paused_at = NULL, error_code = ?, error_detail = ?,
             next_attempt_at = NULL, locked_at = NULL, locked_by = NULL WHERE id = ? AND locked_by = ?`,
          [String(code).slice(0, 48), String(detail).slice(0, 500), runId, workerId],
        );
        await addEvent(conn, runId, from, "CANCELLED", workerId, { code });
        log.info("run cancelled", { run: runId, code });
      });
    },

    // Status change + audit event, atomically and fenced. `fields` are whitelisted columns to set in the same write.
    async transition(runId, workerId, toStatus, fields = {}, metadata = null) {
      return inTransaction(async (conn) => {
        const from = await lockedStatus(conn, runId, workerId);
        const set = setClause(fields);
        await conn.query(
          `UPDATE ndd_sla_runs SET status = ?${set.sql ? `, ${set.sql}` : ""} WHERE id = ? AND locked_by = ?`,
          [toStatus, ...set.values, runId, workerId],
        );
        await addEvent(conn, runId, from, toStatus, workerId, metadata);
        log.info("run status", { run: runId, from, to: toStatus });
      });
    },

    // Fenced column update without a status change. A duplicate Gmail message id (uq_msg) means the same email
    // already feeds another report; that is permanent, not a reason to retry.
    async update(runId, workerId, fields) {
      const set = setClause(fields);
      if (!set.sql) return;
      try {
        const [res] = await pool.query(`UPDATE ndd_sla_runs SET ${set.sql} WHERE id = ? AND locked_by = ?`, [...set.values, runId, workerId]);
        if (!res.affectedRows) throw lost(runId);
      } catch (err) {
        if (err && err.code === "ER_DUP_ENTRY") {
          throw new PipelineError("GMAIL_MESSAGE_ALREADY_USED", "This Gmail message is already attached to another report run");
        }
        throw err;
      }
    },

    // Still waiting for GoKwik: keep the status, try again later, do NOT count it as a failed attempt.
    async scheduleWait(runId, workerId, delayMs, metadata = null) {
      return inTransaction(async (conn) => {
        const from = await lockedStatus(conn, runId, workerId);
        await conn.query(
          `UPDATE ndd_sla_runs SET status = 'WAITING_FOR_GOKWIK', next_attempt_at = (UTC_TIMESTAMP() + INTERVAL ? SECOND),
             locked_at = NULL, locked_by = NULL WHERE id = ? AND locked_by = ?`,
          [Math.ceil(delayMs / 1000), runId, workerId],
        );
        if (from !== "WAITING_FOR_GOKWIK") await addEvent(conn, runId, from, "WAITING_FOR_GOKWIK", workerId, metadata);
      });
    },

    // A failed attempt. delayMs = null => no more retries (the failure is final until requeue()).
    async failAttempt(runId, workerId, { status, code, detail, delayMs }) {
      return inTransaction(async (conn) => {
        const from = await lockedStatus(conn, runId, workerId);
        await conn.query(
          `UPDATE ndd_sla_runs SET status = ?, error_code = ?, error_detail = ?, attempts = attempts + 1,
             next_attempt_at = ${delayMs === null ? "NULL" : "(UTC_TIMESTAMP() + INTERVAL ? SECOND)"},
             locked_at = NULL, locked_by = NULL WHERE id = ? AND locked_by = ?`,
          [status, String(code).slice(0, 48), String(detail || "").slice(0, 500),
            ...(delayMs === null ? [] : [Math.ceil(delayMs / 1000)]), runId, workerId],
        );
        await addEvent(conn, runId, from, status, workerId, { code, final: delayMs === null });
        log.warn("run attempt failed", { run: runId, status, code, final: delayMs === null });
      });
    },

    // New attempt's generation. Rows of an earlier attempt that never became active are deleted first.
    async beginGeneration(runId, workerId) {
      return inTransaction(async (conn) => {
        await lockedStatus(conn, runId, workerId);
        const [rows] = await conn.query("SELECT generation, active_generation FROM ndd_sla_runs WHERE id = ?", [runId]);
        const active = Number(rows[0].active_generation);
        const next = Math.max(Number(rows[0].generation), active) + 1;
        // Only unfinished attempts (above the active one) are removed here; older kept generations go in activate().
        await conn.query("DELETE FROM ndd_sla_orders WHERE run_id = ? AND generation > ?", [runId, active]);
        await conn.query("DELETE FROM ndd_sla_summary WHERE run_id = ? AND generation > ?", [runId, active]);
        await conn.query("UPDATE ndd_sla_runs SET generation = ? WHERE id = ?", [next, runId]);
        return next;
      });
    },

    // One multi-row INSERT per call; the caller batches (NDD_SLA_DB_BATCH_ROWS).
    async insertOrders(runId, generation, rows) {
      if (!rows.length) return 0;
      const values = rows.map((r) => [
        runId, generation, r.reference, r.location, r.orderAt, r.orderDate, r.orderHour, r.courier, r.isNdd ? 1 : 0,
        r.pickedAt, r.sla, // pickedAt is NULL when there was no real pickup, never a placeholder date
        r.marketplace ?? null,
      ]);
      await pool.query(
        `INSERT INTO ndd_sla_orders (run_id, generation, reference_code, client_location, order_at, order_date, order_hour,
           courier, is_ndd, shipment_picked_at, sla_status, marketplace) VALUES ?`,
        [values],
      );
      return rows.length;
    },

    async insertSummary(runId, generation, buckets) {
      if (!buckets.length) return 0;
      const values = buckets.map((b) => [runId, generation, b.location, b.orderDate, b.orderHour, b.met, b.breached, b.total]);
      await pool.query(
        `INSERT INTO ndd_sla_summary (run_id, generation, client_location, order_date, order_hour, met_count, breached_count, total_count) VALUES ?`,
        [values],
      );
      return buckets.length;
    },

    async discardGeneration(runId, generation) {
      await pool.query("DELETE FROM ndd_sla_orders WHERE run_id = ? AND generation = ?", [runId, generation]);
      await pool.query("DELETE FROM ndd_sla_summary WHERE run_id = ? AND generation = ?", [runId, generation]);
    },

    // The only place a generation becomes visible. One transaction: counts + status + active_generation + old data gone.
    async activate(runId, workerId, generation, fields) {
      return inTransaction(async (conn) => {
        const from = await lockedStatus(conn, runId, workerId);
        const [[current]] = await conn.query("SELECT active_generation FROM ndd_sla_runs WHERE id = ?", [runId]);
        const previous = Number(current.active_generation);
        const set = setClause(fields);
        const [res] = await conn.query(
          `UPDATE ndd_sla_runs SET status = 'COMPLETED', active_generation = ?, ${set.sql ? `${set.sql}, ` : ""}
             error_code = NULL, error_detail = NULL, next_attempt_at = NULL, completed_at = UTC_TIMESTAMP(),
             locked_at = NULL, locked_by = NULL
           WHERE id = ? AND locked_by = ? AND generation = ?`,
          [generation, ...set.values, runId, workerId, generation],
        );
        if (!res.affectedRows) throw lost(runId);
        await conn.query("DELETE FROM ndd_sla_orders WHERE run_id = ? AND generation NOT IN (?, ?)", [runId, generation, previous]);
        await conn.query("DELETE FROM ndd_sla_summary WHERE run_id = ? AND generation NOT IN (?, ?)", [runId, generation, previous]);
        await addEvent(conn, runId, from, "COMPLETED", workerId, { generation, previous });
        log.info("run completed", { run: runId, generation });
      });
    },

    // Manual re-run of a finished/failed AUTOMATED report (report #1): keeps the old active report visible until a new one
    // completes. Uploaded reports (seq > 1) cannot be re-run because their files are not kept; upload again instead.
    async requeueRun(brandKey, runId, actor = "manual") {
      return inTransaction(async (conn) => {
        const [rows] = await conn.query(
          "SELECT id, status, locked_at, report_seq FROM ndd_sla_runs WHERE id = ? AND brand_key = ? FOR UPDATE", [runId, brandKey],
        );
        const row = rows[0];
        if (!row) return { requeued: false, reason: "NOT_FOUND" };
        if (row.locked_at) return { requeued: false, reason: "LOCKED" };
        if (Number(row.report_seq) > 1) return { requeued: false, reason: "NOT_AUTOMATED" };
        await conn.query(
          `UPDATE ndd_sla_runs SET status = 'SCHEDULED', source_mode = 'AUTO', attempts = 0, next_attempt_at = NULL, error_code = NULL,
             error_detail = NULL, control = 'NONE', paused_at = NULL, gmail_message_id = NULL, gmail_attachment_id = NULL WHERE id = ?`,
          [row.id],
        );
        await addEvent(conn, Number(row.id), row.status, "SCHEDULED", actor, { requeue: true });
        return { requeued: true, id: Number(row.id) };
      });
    },

    // Permanently deletes one report (the run, its orders, hourly summary and audit trail via ON DELETE CASCADE).
    // Refused while a process holds it: cancel it first. Scoped to the caller's brand.
    async deleteRun(brandKey, runId, actor = "manual") {
      return inTransaction(async (conn) => {
        const [rows] = await conn.query(
          "SELECT id, report_date, report_seq, status, locked_at FROM ndd_sla_runs WHERE id = ? AND brand_key = ? FOR UPDATE", [runId, brandKey],
        );
        const row = rows[0];
        if (!row) return { deleted: false, reason: "NOT_FOUND" };
        if (row.locked_at) return { deleted: false, reason: "LOCKED" };
        await conn.query("DELETE FROM ndd_sla_runs WHERE id = ?", [row.id]);
        log.info("run deleted", { run: Number(row.id), reportDate: row.report_date, seq: Number(row.report_seq), status: row.status, actor });
        return { deleted: true };
      });
    },

    // Date-keyed form (kept for the /reports/:date routes): the automated report of that date.
    async requeue(brandKey, reportDate, actor = "manual") {
      const [rows] = await pool.query("SELECT id FROM ndd_sla_runs WHERE brand_key = ? AND report_date = ? AND report_seq = 1", [brandKey, reportDate]);
      if (!rows[0]) return { requeued: false, reason: "NOT_FOUND" };
      return this.requeueRun(brandKey, Number(rows[0].id), actor);
    },

    // Manual upload: every upload becomes a NEW report (next report_seq) for the date, created already locked for THIS
    // uploader in one transaction so the worker cannot grab it. Other reports of the date are untouched and stay served.
    async claimForUpload({ brandKey, reportDate, windows, lockedBy, uploadedBy }) {
      return inTransaction(async (conn) => {
        const [[top]] = await conn.query(
          "SELECT COALESCE(MAX(report_seq), 0) AS top FROM ndd_sla_runs WHERE brand_key = ? AND report_date = ? FOR UPDATE", [brandKey, reportDate],
        );
        const seq = Number(top.top) + 1;
        const [res] = await conn.query(
          `INSERT INTO ndd_sla_runs (brand_key, report_date, report_seq, source_mode, uploaded_by, status, locked_at, locked_by, started_at,
             ndd_window_start, ndd_window_end, other_window_start, other_window_end)
           VALUES (?, ?, ?, 'MANUAL', ?, 'GOKWIK_RECEIVED', UTC_TIMESTAMP(), ?, UTC_TIMESTAMP(), ?, ?, ?, ?)`,
          [brandKey, reportDate, seq, String(uploadedBy).slice(0, 64), lockedBy, windows.ndd.start, windows.ndd.end, windows.other.start, windows.other.end],
        );
        const id = Number(res.insertId);
        await addEvent(conn, id, null, "GOKWIK_RECEIVED", lockedBy, { manualUpload: true, reportSeq: seq });
        const [rows] = await conn.query("SELECT * FROM ndd_sla_runs WHERE id = ?", [id]);
        return { claimed: true, run: { ...rows[0], id } };
      });
    },

    // ---- reads (every one takes the brand from the signed header, never from the URL) -----------------------------

    async listRuns(brandKey, { from, to, limit = 60 } = {}) {
      const where = ["brand_key = ?"];
      const args = [brandKey];
      if (from) { where.push("report_date >= ?"); args.push(from); }
      if (to) { where.push("report_date <= ?"); args.push(to); }
      args.push(Number(limit));
      const [rows] = await pool.query(
        `SELECT * FROM ndd_sla_runs WHERE ${where.join(" AND ")} ORDER BY report_date DESC, report_seq DESC LIMIT ?`, args,
      );
      return rows;
    },

    // The report served for a date: the newest one that has data, else the newest run.
    async getRun(brandKey, reportDate) {
      const [rows] = await pool.query(
        "SELECT * FROM ndd_sla_runs WHERE brand_key = ? AND report_date = ? ORDER BY (active_generation > 0) DESC, report_seq DESC LIMIT 1",
        [brandKey, reportDate],
      );
      return rows[0] || null;
    },

    async getRunById(brandKey, runId) {
      const [rows] = await pool.query("SELECT * FROM ndd_sla_runs WHERE id = ? AND brand_key = ?", [runId, brandKey]);
      return rows[0] || null;
    },

    // Unfiltered: the stored hourly summary. With a marketplace or window filter: the same shape, counted from the orders.
    async getSummary(runId, generation, { marketplace, window, day } = {}) {
      if (marketplace || window || day) {
        const where = ["run_id = ?", "generation = ?"];
        const args = [runId, generation];
        if (marketplace) { where.push("marketplace = ?"); args.push(marketplace); }
        if (window) { where.push(WINDOW_SQL); args.push(...windowArgs(window)); }
        if (day) { where.push("order_date = ?"); args.push(day); }
        const [filtered] = await pool.query(
          `SELECT client_location, order_date, order_hour, SUM(sla_status = 'MET') AS met_count,
             SUM(sla_status = 'BREACHED') AS breached_count, COUNT(*) AS total_count FROM ndd_sla_orders
            WHERE ${where.join(" AND ")}
            GROUP BY client_location, order_date, order_hour ORDER BY client_location, order_date, order_hour`,
          args,
        );
        return filtered;
      }
      const [rows] = await pool.query(
        `SELECT client_location, order_date, order_hour, met_count, breached_count, total_count FROM ndd_sla_summary
          WHERE run_id = ? AND generation = ? ORDER BY client_location, order_date, order_hour`,
        [runId, generation],
      );
      return rows;
    },

    // The marketplaces present in a report (empty for reports built before they were recorded).
    async listMarketplaces(runId, generation, { window, day } = {}) {
      const [rows] = await pool.query(
        `SELECT marketplace AS name, COUNT(*) AS total FROM ndd_sla_orders
          WHERE run_id = ? AND generation = ? AND marketplace IS NOT NULL${window ? ` AND ${WINDOW_SQL}` : ""}${day ? " AND order_date = ?" : ""}
          GROUP BY marketplace ORDER BY total DESC, name`,
        [runId, generation, ...(window ? windowArgs(window) : []), ...(day ? [day] : [])],
      );
      return rows.map((r) => ({ name: r.name, total: Number(r.total) }));
    },

    // The newest order date stored for a report (null when it has no orders).
    async lastOrderDate(runId, generation) {
      const [rows] = await pool.query("SELECT MAX(order_date) AS last FROM ndd_sla_orders WHERE run_id = ? AND generation = ?", [runId, generation]);
      return rows[0]?.last || null;
    },

    // Keyset pagination on (order_at, reference_code): stable and index-backed (idx_list).
    async listOrders(runId, generation, { location, sla, marketplace, window, day, limit = 100, after } = {}) {
      const where = ["run_id = ?", "generation = ?"];
      const args = [runId, generation];
      if (location) { where.push("client_location = ?"); args.push(location); }
      if (sla) { where.push("sla_status = ?"); args.push(sla); }
      if (marketplace) { where.push("marketplace = ?"); args.push(marketplace); }
      if (window) { where.push(WINDOW_SQL); args.push(...windowArgs(window)); }
      if (day) { where.push("order_date = ?"); args.push(day); }
      if (after) { where.push("(order_at > ? OR (order_at = ? AND reference_code > ?))"); args.push(after.orderAt, after.orderAt, after.reference); }
      args.push(Number(limit) + 1);
      const [rows] = await pool.query(
        `SELECT reference_code, client_location, order_at, order_date, order_hour, courier, is_ndd, shipment_picked_at, sla_status, marketplace
           FROM ndd_sla_orders WHERE ${where.join(" AND ")} ORDER BY order_at, reference_code LIMIT ?`,
        args,
      );
      return rows;
    },
  };
}

module.exports = { buildRepo };
