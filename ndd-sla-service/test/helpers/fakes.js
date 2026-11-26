// In-memory stand-ins with the SAME contract as services/repo.js (fenced writes, generations, event log, retries),
// plus scriptable Gmail / EasyCom fakes. The real SQL is checked in repo.sql.test.js (captured SQL) and
// repo.mysql.test.js (real MySQL, opt-in).
const { PipelineError } = require("../../src/errors");
const { getConfig } = require("../../src/config");

const ENV = {
  NDD_SLA_REPORT_DATE_ANCHOR: "end", NDD_SLA_NDD_START_TIME: "12:00", NDD_SLA_OTHER_START_TIME: "15:00",
  NDD_SLA_WINDOW_LENGTH_HOURS: "24", NDD_SLA_TIMEZONE: "Asia/Kolkata",
  NDD_SLA_GMAIL_SENDER: "reports@gokwik.test", NDD_SLA_GMAIL_SUBJECT_PATTERN: "^Orders report", NDD_SLA_GMAIL_FILENAME_PATTERN: "\\.csv$",
  NDD_SLA_DB_BATCH_ROWS: "500", NDD_SLA_BACKOFF_BASE_MS: "1000", NDD_SLA_MAX_ATTEMPTS: "3", NDD_SLA_POLL_MS: "60000",
  NDD_SLA_GOKWIK_DEADLINE_HOURS: "24", ALLOW_INSECURE_AUTH: "true",
};

function testConfig(extra = {}, env = {}) {
  const cfg = getConfig({ ...ENV, ...env });
  return { ...cfg, tmpDir: require("os").tmpdir(), ...extra };
}

const inView = (o, window) => {
  if (!window) return true;
  const w = Number(o.is_ndd) ? window.ndd : window.other;
  return o.order_at >= w.start && o.order_at < w.end;
};

const emptyRun = (id, brandKey, reportDate, windows) => ({
  id, brand_key: brandKey, report_date: reportDate, report_type: "NDD_SLA", report_seq: 1, control: "NONE", paused_at: null, source_mode: "AUTO", easycom_source_filename: null, uploaded_by: null, status: "SCHEDULED", attempts: 0,
  next_attempt_at: null, locked_at: null, locked_by: null, error_code: null, error_detail: null,
  ndd_window_start: windows.ndd.start, ndd_window_end: windows.ndd.end,
  other_window_start: windows.other.start, other_window_end: windows.other.end,
  gmail_message_id: null, gmail_attachment_id: null, source_filename: null, source_bytes: null, source_sha256: null,
  source_received_at: null, duplicate_messages: 0, easycom_pages: 0, easycom_fetched: 0,
  rows_in: 0, rows_wrong_client: 0, rows_wrong_status: 0, rows_out_of_window: 0, rows_duplicate: 0, rows_invalid: 0,
  rows_kept: 0, rows_unmatched: 0, sla_met: 0, sla_breached: 0, gmail_ms: null, easycom_ms: null, process_ms: null,
  generation: 0, active_generation: 0, started_at: null, completed_at: null,
});

function fakeRepo({ now = () => Date.now() } = {}) {
  const runs = [];
  const orders = []; // { run_id, generation, ... }
  const summary = [];
  const events = [];
  const inserts = []; // sizes of every insertOrders batch
  let seq = 0;
  const due = (r) => r.next_attempt_at === null || r.next_attempt_at <= now();
  const byId = (id) => runs.find((r) => r.id === id);
  const lost = (id) => new PipelineError("LOCK_LOST", `Run ${id} is no longer locked by this worker`);
  const owned = (id, w) => {
    const r = byId(id);
    if (!r || r.locked_by !== w) throw lost(id);
    return r;
  };
  const event = (run_id, from, to, actor, metadata) => events.push({ run_id, from, to, actor, metadata });

  const repo = {
    _runs: runs, _orders: orders, _summary: summary, _events: events, _inserts: inserts,
    async checkSchema() { return { ok: true, missing: [] }; },
    async ensureRun({ brandKey, reportDate, windows }) {
      if (runs.some((r) => r.brand_key === brandKey && r.report_date === reportDate && r.report_seq === 1)) return { created: false };
      const run = emptyRun(++seq, brandKey, reportDate, windows);
      runs.push(run);
      event(run.id, null, "SCHEDULED", "scheduler");
      return { created: true };
    },
    async releaseStaleLocks(ms) {
      let n = 0;
      for (const r of runs) {
        if (r.source_mode === "MANUAL" && r.locked_at !== null && r.locked_at < now() - ms && !["COMPLETED", "GOKWIK_TIMEOUT", "CANCELLED"].includes(r.status)) {
          Object.assign(r, { status: "PROCESSING_FAILED", error_code: "UPLOAD_INTERRUPTED", next_attempt_at: null, locked_at: null, locked_by: null });
          continue;
        }
        if (r.locked_at !== null && r.locked_at < now() - ms && !["COMPLETED", "GOKWIK_TIMEOUT", "CANCELLED"].includes(r.status)) {
          r.locked_at = null; r.locked_by = null; n += 1;
        }
      }
      return n;
    },
    async claimNext(brandKey, workerId) {
      const candidates = runs.filter((r) => r.brand_key === brandKey && r.source_mode === "AUTO" && r.locked_at === null
        && !["COMPLETED", "GOKWIK_TIMEOUT", "CANCELLED"].includes(r.status) && r.control === "NONE"
        && (!["EASYCOM_FAILED", "PROCESSING_FAILED"].includes(r.status) || r.next_attempt_at !== null) && due(r))
        .sort((a, b) => b.report_date.localeCompare(a.report_date));
      const run = candidates[0];
      if (!run) return null;
      Object.assign(run, { locked_at: now(), locked_by: workerId, next_attempt_at: null, started_at: run.started_at || now() });
      return { ...run };
    },
    async heartbeat(id, w) { const r = owned(id, w); r.locked_at = now(); return r.control; },
    async setControl(brandKey, id, control) {
      const r = runs.find((x) => x.id === id && x.brand_key === brandKey);
      if (!r) return { ok: false, reason: "NOT_FOUND" };
      if (["COMPLETED", "GOKWIK_TIMEOUT", "CANCELLED"].includes(r.status)) return { ok: false, reason: "NOT_ACTIVE", status: r.status };
      if (control === "CANCEL" && r.locked_at === null) {
        Object.assign(r, { status: "CANCELLED", control: "NONE", paused_at: null, next_attempt_at: null, error_code: "CANCELLED", error_detail: "Cancelled by a user." });
        return { ok: true, status: "CANCELLED" };
      }
      Object.assign(r, { control, paused_at: control === "PAUSE" ? now() : null });
      return { ok: true, status: r.status };
    },
    async markCancelled(id, w, { code = "CANCELLED", detail = "Cancelled by a user." } = {}) {
      const r = owned(id, w);
      const from = r.status;
      Object.assign(r, { status: "CANCELLED", control: "NONE", paused_at: null, error_code: code, error_detail: detail, next_attempt_at: null, locked_at: null, locked_by: null });
      event(id, from, "CANCELLED", w, { code });
    },
    async transition(id, w, to, fields = {}, metadata) {
      const r = owned(id, w);
      const from = r.status;
      Object.assign(r, fields, { status: to });
      event(id, from, to, w, metadata);
    },
    async update(id, w, fields) {
      const r = owned(id, w);
      if (fields.gmail_message_id && runs.some((x) => x !== r && x.brand_key === r.brand_key && x.gmail_message_id === fields.gmail_message_id)) {
        throw new PipelineError("GMAIL_MESSAGE_ALREADY_USED", "This Gmail message is already attached to another report run");
      }
      Object.assign(r, fields);
    },
    async scheduleWait(id, w, delayMs) {
      const r = owned(id, w);
      Object.assign(r, { status: "WAITING_FOR_GOKWIK", next_attempt_at: now() + delayMs, locked_at: null, locked_by: null });
    },
    async failAttempt(id, w, { status, code, detail, delayMs }) {
      const r = owned(id, w);
      const from = r.status;
      Object.assign(r, { status, error_code: code, error_detail: detail, attempts: r.attempts + 1,
        next_attempt_at: delayMs === null ? null : now() + delayMs, locked_at: null, locked_by: null });
      event(id, from, status, w, { code, final: delayMs === null });
    },
    async beginGeneration(id, w) {
      const r = owned(id, w);
      for (const list of [orders, summary]) {
        for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].run_id === id && list[i].generation > r.active_generation) list.splice(i, 1);
      }
      r.generation = Math.max(r.generation, r.active_generation) + 1;
      return r.generation;
    },
    async insertOrders(id, generation, rows) {
      inserts.push(rows.length);
      for (const o of rows) orders.push({ run_id: id, generation, reference_code: o.reference, client_location: o.location,
        order_at: o.orderAt, order_date: o.orderDate, order_hour: o.orderHour, courier: o.courier, is_ndd: o.isNdd ? 1 : 0,
        shipment_picked_at: o.pickedAt, sla_status: o.sla, marketplace: o.marketplace ?? null });
      return rows.length;
    },
    async insertSummary(id, generation, buckets) {
      for (const b of buckets) summary.push({ run_id: id, generation, client_location: b.location, order_date: b.orderDate,
        order_hour: b.orderHour, met_count: b.met, breached_count: b.breached, total_count: b.total });
      return buckets.length;
    },
    async discardGeneration(id, generation) {
      for (const list of [orders, summary]) {
        for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].run_id === id && list[i].generation === generation) list.splice(i, 1);
      }
    },
    async activate(id, w, generation, fields) {
      const r = owned(id, w);
      if (r.generation !== generation) throw lost(id);
      const from = r.status;
      const previous = r.active_generation;
      Object.assign(r, fields, { status: "COMPLETED", active_generation: generation, error_code: null, error_detail: null,
        next_attempt_at: null, completed_at: now(), locked_at: null, locked_by: null });
      for (const list of [orders, summary]) {
        for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].run_id === id && ![generation, previous].includes(list[i].generation)) list.splice(i, 1);
      }
      event(id, from, "COMPLETED", w, { generation });
    },
    async requeue(brandKey, reportDate) {
      const r = runs.find((x) => x.brand_key === brandKey && x.report_date === reportDate && x.report_seq === 1);
      return r ? repo.requeueRun(brandKey, r.id) : { requeued: false, reason: "NOT_FOUND" };
    },
    async deleteRun(brandKey, id) {
      const i = runs.findIndex((x) => x.id === id && x.brand_key === brandKey);
      if (i < 0) return { deleted: false, reason: "NOT_FOUND" };
      if (runs[i].locked_at) return { deleted: false, reason: "LOCKED" };
      runs.splice(i, 1);
      for (const list of [orders, summary]) for (let k = list.length - 1; k >= 0; k -= 1) if (list[k].run_id === id) list.splice(k, 1);
      return { deleted: true };
    },
    async requeueRun(brandKey, id) {
      const r = runs.find((x) => x.id === id && x.brand_key === brandKey);
      if (!r) return { requeued: false, reason: "NOT_FOUND" };
      if (r.locked_at) return { requeued: false, reason: "LOCKED" };
      if (r.report_seq > 1) return { requeued: false, reason: "NOT_AUTOMATED" };
      Object.assign(r, { control: "NONE", paused_at: null, status: "SCHEDULED", source_mode: "AUTO", attempts: 0, next_attempt_at: null, error_code: null, error_detail: null, gmail_message_id: null, gmail_attachment_id: null });
      return { requeued: true, id: r.id };
    },
    async claimForUpload({ brandKey, reportDate, windows, lockedBy, uploadedBy }) {
      const top = Math.max(0, ...runs.filter((r) => r.brand_key === brandKey && r.report_date === reportDate).map((r) => r.report_seq));
      const run = emptyRun(++seq, brandKey, reportDate, windows);
      Object.assign(run, { report_seq: top + 1, source_mode: "MANUAL", uploaded_by: uploadedBy, locked_at: now(), locked_by: lockedBy,
        status: "GOKWIK_RECEIVED", started_at: now() });
      runs.push(run);
      event(run.id, null, "GOKWIK_RECEIVED", lockedBy, { manualUpload: true, reportSeq: run.report_seq });
      return { claimed: true, run: { ...run } };
    },
    async listRuns(brandKey, { from, to, limit = 60 } = {}) {
      return runs.filter((r) => r.brand_key === brandKey && (!from || r.report_date >= from) && (!to || r.report_date <= to))
        .sort((a, b) => b.report_date.localeCompare(a.report_date) || b.report_seq - a.report_seq).slice(0, limit).map((r) => ({ ...r }));
    },
    async getRun(brandKey, date) {
      const same = runs.filter((x) => x.brand_key === brandKey && x.report_date === date)
        .sort((a, b) => (Number(b.active_generation > 0) - Number(a.active_generation > 0)) || b.report_seq - a.report_seq);
      return same[0] ? { ...same[0] } : null;
    },
    async getRunById(brandKey, id) {
      const r = runs.find((x) => x.id === id && x.brand_key === brandKey);
      return r ? { ...r } : null;
    },
    async lastOrderDate(id, generation) {
      return orders.filter((o) => o.run_id === id && o.generation === generation).map((o) => o.order_date).sort().pop() || null;
    },
    async listMarketplaces(id, generation, { window, day } = {}) {
      const totals = new Map();
      for (const o of orders) if (o.run_id === id && o.generation === generation && o.marketplace && inView(o, window) && (!day || o.order_date === day)) totals.set(o.marketplace, (totals.get(o.marketplace) || 0) + 1);
      return [...totals].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    },
    async getSummary(id, generation, { marketplace, window, day } = {}) {
      if (marketplace || window || day) {
        const buckets = new Map();
        for (const o of orders.filter((x) => x.run_id === id && x.generation === generation && (!marketplace || x.marketplace === marketplace) && inView(x, window) && (!day || x.order_date === day))) {
          const key = `${o.client_location}|${o.order_date}|${o.order_hour}`;
          const b = buckets.get(key) || { client_location: o.client_location, order_date: o.order_date, order_hour: o.order_hour, met_count: 0, breached_count: 0, total_count: 0 };
          if (o.sla_status === "MET") b.met_count += 1; else b.breached_count += 1;
          b.total_count += 1;
          buckets.set(key, b);
        }
        return [...buckets.values()].sort((a, b) => a.client_location.localeCompare(b.client_location) || a.order_date.localeCompare(b.order_date) || a.order_hour - b.order_hour);
      }
      return summary.filter((s) => s.run_id === id && s.generation === generation)
        .sort((a, b) => a.client_location.localeCompare(b.client_location) || a.order_date.localeCompare(b.order_date) || a.order_hour - b.order_hour);
    },
    async listOrders(id, generation, { location, sla, marketplace, window, day, limit = 100, after } = {}) {
      return orders.filter((o) => o.run_id === id && o.generation === generation && (!location || o.client_location === location)
        && (!sla || o.sla_status === sla) && (!marketplace || o.marketplace === marketplace) && inView(o, window) && (!day || o.order_date === day)
        && (!after || o.order_at > after.orderAt || (o.order_at === after.orderAt && o.reference_code > after.reference)))
        .sort((a, b) => a.order_at.localeCompare(b.order_at) || a.reference_code.localeCompare(b.reference_code)).slice(0, limit + 1);
    },
  };
  return repo;
}

// Gmail fake: `messages` is what the "inbox" holds; downloads write `csvText` to destPath.
function fakeGmail({ messages = [], csvByMessage = {}, failList = null, failDownload = null } = {}) {
  const fs = require("fs");
  const crypto = require("crypto");
  const calls = { list: 0, download: 0 };
  return {
    calls,
    messages,
    async listCandidates() {
      calls.list += 1;
      if (failList) throw failList;
      return messages;
    },
    async downloadAttachment({ messageId, destPath }) {
      calls.download += 1;
      if (failDownload) throw failDownload;
      const data = Buffer.from(csvByMessage[messageId] ?? "", "utf8");
      await fs.promises.writeFile(destPath, data);
      return { bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
    },
  };
}

// EasyCom fake: pages = array of arrays of { reference, pickedAtRaw }. failAtPage (1-based) throws there.
function fakeEasycom({ pages = [], failAtPage = null, error = null } = {}) {
  const calls = { fetch: 0 };
  return {
    calls,
    async *fetchShipments() {
      calls.fetch += 1;
      for (let i = 0; i < pages.length; i += 1) {
        if (failAtPage === i + 1) throw error || new PipelineError("EASYCOM_UNAVAILABLE", "boom", { retryable: true });
        yield { page: i + 1, items: pages[i], rawCount: pages[i].length };
      }
    },
  };
}

module.exports = { testConfig, fakeRepo, fakeGmail, fakeEasycom, ENV };
