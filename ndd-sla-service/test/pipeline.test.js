const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const { testConfig, fakeRepo, fakeGmail, fakeEasycom } = require("./helpers/fakes");
const { buildPipeline } = require("../src/services/pipeline");
const { PipelineError } = require("../src/errors");
const { wallToEpochMs } = require("../src/lib/wall");

const TZ = "Asia/Kolkata";
const at = (wall) => wallToEpochMs(wall, TZ);
const HEADER = "Reference Code,Client Location,Order Status,Courier Name,Order Date\n";
const row = (ref, courier, orderAt, loc = "AJMAL & SONS", status = "Delivered") => `${ref},${loc},${status},${courier},${orderAt}\n`;
// Two kept orders on 2026-11-19: one NDD (window 11-18 12:00..11-19 12:00), one other (11-18 15:00..11-19 15:00).
const CSV = HEADER + row("R1", "BlitzNDD", "2026-11-18 13:00:00") + row("R2", "Delhivery", "2026-11-19 10:00:00") + row("R3", "Delhivery", "2026-11-19 16:00:00");
const message = (over = {}) => ({
  id: "m1", from: "reports@gokwik.test", subject: "Orders report", receivedMs: at("2026-11-19 15:30:00"),
  attachments: [{ id: "a1", filename: "o.csv", size: CSV.length }], ...over,
});

function setup({ csv = CSV, messages = [message()], pages = [[{ reference: "R1", pickedAtRaw: "2026-11-18 14:00:00" }]], clock = "2026-11-19 16:00:00", configOver = {}, envOver = {}, ecOpts = {} } = {}) {
  const state = { t: at(clock) };
  const config = testConfig(configOver, { NDD_SLA_SCHEDULE_LOOKBACK_DAYS: "0", ...envOver });
  const repo = fakeRepo({ now: () => state.t });
  const gmail = fakeGmail({ messages, csvByMessage: { m1: csv } });
  const easycom = fakeEasycom({ pages, ...ecOpts });
  const pipeline = buildPipeline({ config, repo, gmail, easycom, now: () => state.t, workerId: "w1" });
  return { state, config, repo, gmail, easycom, pipeline };
}
const advance = (state, ms) => { state.t += ms; };

test("happy path: R1 picked up (MET), R2 not in EasyCom (BREACHED, counted unmatched), R3 outside its window", async () => {
  const { repo, pipeline } = setup();
  const r = await pipeline.tick();
  assert.equal(r.outcome, "completed");
  const run = repo._runs[0];
  assert.deepEqual([run.status, run.active_generation, run.rows_kept, run.rows_out_of_window], ["COMPLETED", 1, 2, 1]);
  assert.deepEqual([run.sla_met, run.sla_breached, run.rows_unmatched], [1, 1, 1]);
  const stored = Object.fromEntries(repo._orders.map((o) => [o.reference_code, o]));
  assert.equal(stored.R1.sla_status, "MET");
  assert.equal(stored.R2.shipment_picked_at, null);
  assert.equal(run.source_filename, "o.csv");
  assert.match(run.source_sha256, /^[0-9a-f]{64}$/);
  const path = repo._events.filter((e) => e.run_id === run.id).map((e) => e.to);
  assert.deepEqual(path, ["SCHEDULED", "WAITING_FOR_GOKWIK", "GOKWIK_RECEIVED", "EASYCOM_FETCHING", "PROCESSING", "COMPLETED"]);
});

test("scheduler: no run before the windows close, exactly one per date, idempotent", async () => {
  const early = setup({ clock: "2026-11-19 14:00:00", envOver: { NDD_SLA_SCHEDULE_LOOKBACK_DAYS: "1" } });
  assert.equal(await early.pipeline.scheduleRuns(), 1, "only 18-Nov is closed at 14:00 on 19-Nov (non-NDD window ends 15:00)");
  assert.deepEqual(early.repo._runs.map((r) => r.report_date), ["2026-11-18"]);
  advance(early.state, 2 * 3600 * 1000);
  assert.equal(await early.pipeline.scheduleRuns(), 1);
  assert.equal(await early.pipeline.scheduleRuns(), 0);
  assert.deepEqual(early.repo._runs.map((r) => r.report_date).sort(), ["2026-11-18", "2026-11-19"]);
  const w = early.repo._runs.find((r) => r.report_date === "2026-11-19");
  assert.deepEqual([w.ndd_window_start, w.ndd_window_end, w.other_window_start, w.other_window_end],
    ["2026-11-18 12:00:00", "2026-11-19 12:00:00", "2026-11-18 15:00:00", "2026-11-19 15:00:00"]);
});

test("waiting for GoKwik: polls without burning retries, then completes when the email arrives", async () => {
  const { state, repo, gmail, pipeline } = setup({ messages: [] });
  assert.equal((await pipeline.tick()).outcome, "waiting");
  let run = repo._runs[0];
  assert.deepEqual([run.status, run.attempts, run.locked_by], ["WAITING_FOR_GOKWIK", 0, null]);
  assert.equal((await pipeline.tick()).outcome, "idle", "not due yet");
  assert.equal(gmail.calls.list, 1);

  gmail.messages.push(message());
  advance(state, 61000);
  assert.equal((await pipeline.tick()).outcome, "completed");
  run = repo._runs[0];
  assert.equal(run.attempts, 0);
});

test("GoKwik timeout: after the deadline the run ends GOKWIK_TIMEOUT and is never claimed again", async () => {
  const { state, repo, pipeline } = setup({ messages: [] });
  assert.equal((await pipeline.tick()).outcome, "waiting");
  advance(state, 25 * 3600 * 1000); // the scheduler also opens 20-Nov now; newest report is claimed first
  const outcomes = [];
  for (let i = 0; i < 3; i += 1) outcomes.push((await pipeline.tick()).outcome);
  const run = repo._runs.find((r) => r.report_date === "2026-11-19");
  assert.equal(run.status, "GOKWIK_TIMEOUT");
  assert.ok(outcomes.includes("timeout"));
  assert.equal(run.next_attempt_at, null);
  assert.equal(outcomes[2], "idle", "a timed-out run is never claimed again");
});

test("EasyCom failure: retried with backoff, resumes WITHOUT searching Gmail again, earlier partial rows never leak", async () => {
  const { state, repo, gmail, easycom, pipeline } = setup({
    pages: [[{ reference: "R1", pickedAtRaw: "2026-11-18 14:00:00" }], [{ reference: "R2", pickedAtRaw: "2026-11-18 16:00:00" }]],
    ecOpts: { failAtPage: 2 },
  });
  const r = await pipeline.tick();
  assert.equal(r.outcome, "retry_scheduled");
  let run = repo._runs[0];
  assert.deepEqual([run.status, run.attempts, run.error_code], ["EASYCOM_FAILED", 1, "EASYCOM_UNAVAILABLE"]);
  assert.equal(run.active_generation, 0);
  assert.equal(repo._orders.length, 0);
  assert.ok(run.next_attempt_at > state.t, "backoff in the future");
  assert.equal((await pipeline.tick()).outcome, "idle");

  easycom.fetchShipments = fakeEasycom({ pages: [[{ reference: "R1", pickedAtRaw: "2026-11-18 14:00:00" }], [{ reference: "R2", pickedAtRaw: "2026-11-18 16:00:00" }]] }).fetchShipments;
  advance(state, 5 * 60000);
  assert.equal((await pipeline.tick()).outcome, "completed");
  run = repo._runs[0];
  assert.deepEqual([run.status, run.sla_met, run.sla_breached, run.error_code], ["COMPLETED", 2, 0, null]);
  assert.equal(gmail.calls.list, 1, "message already chosen; not searched again");
});

test("retries are bounded: after NDD_SLA_MAX_ATTEMPTS failures the run stays failed and is not claimed", async () => {
  const { state, repo, pipeline } = setup({ pages: [[{ reference: "R1", pickedAtRaw: "" }]], ecOpts: { failAtPage: 1 } });
  const outcomes = [];
  for (let i = 0; i < 6; i += 1) {
    outcomes.push((await pipeline.tick()).outcome);
    advance(state, 60 * 60000);
  }
  assert.deepEqual(outcomes.slice(0, 3), ["retry_scheduled", "retry_scheduled", "failed"]);
  assert.ok(outcomes.slice(3).every((o) => o === "idle"));
  const run = repo._runs[0];
  assert.deepEqual([run.status, run.attempts, run.next_attempt_at], ["EASYCOM_FAILED", 3, null]);
});

test("permanent errors (bad CSV header) fail at once without retries, and the temp file is removed", async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("ndd-sla-"));
  const { repo, pipeline } = setup({ csv: "Wrong,Header\n1,2\n" });
  const r = await pipeline.tick();
  assert.equal(r.outcome, "failed");
  assert.equal(r.code, "CSV_MISSING_COLUMNS");
  assert.deepEqual([repo._runs[0].status, repo._runs[0].next_attempt_at], ["PROCESSING_FAILED", null]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("ndd-sla-")), before);
});

test("generations: a re-run replaces the report atomically; a failed re-run leaves the old report intact", async () => {
  const { state, repo, gmail, pipeline } = setup();
  await pipeline.tick();
  assert.equal(repo._runs[0].active_generation, 1);

  // Re-run with corrected data, but the write fails half way: generation 1 must stay active and complete.
  await repo.requeue("AJMAL", "2026-11-19");
  gmail.messages[0] = message({ id: "m2" });
  gmail.csvByMessage = undefined;
  const g2csv = HEADER + row("R2", "Delhivery", "2026-11-19 10:00:00") + row("R9", "Delhivery", "2026-11-19 11:00:00");
  const realDownload = gmail.downloadAttachment;
  gmail.downloadAttachment = async (args) => realDownload({ ...args, messageId: "m1" }).then(async (r) => { await fs.promises.writeFile(args.destPath, g2csv); return r; });
  const realInsert = repo.insertOrders;
  let calls = 0;
  repo.insertOrders = async (...a) => { calls += 1; if (calls === 1) { await realInsert(...a); throw new PipelineError("DB_BLIP", "boom", { retryable: true }); } return realInsert(...a); };
  advance(state, 1000);
  assert.equal((await pipeline.tick()).outcome, "retry_scheduled");
  let run = repo._runs[0];
  assert.deepEqual([run.active_generation, run.generation], [1, 2]);
  assert.deepEqual(repo._orders.map((o) => o.reference_code).sort(), ["R1", "R2"], "old report fully intact, partial gen 2 rows discarded");

  advance(state, 10 * 60000);
  assert.equal((await pipeline.tick()).outcome, "completed");
  run = repo._runs[0];
  assert.equal(run.active_generation, 3);
  assert.deepEqual(repo._orders.filter((o) => o.generation === 3).map((o) => o.reference_code).sort(), ["R2", "R9"], "the new generation is complete");
  assert.deepEqual([...new Set(repo._orders.map((o) => o.generation))].sort(), [1, 3], "the previous successful generation is kept one cycle; the failed gen 2 is gone");
});

test("lost lock: the worker stops writing and records nothing when another worker took the run", async () => {
  const { repo, pipeline } = setup();
  const realHeartbeat = repo.heartbeat;
  repo.heartbeat = async (id, w) => {
    repo._runs[0].locked_by = "someone-else"; // lock stolen
    return realHeartbeat(id, w);
  };
  const r = await pipeline.tick();
  assert.equal(r.outcome, "lock_lost");
  const run = repo._runs[0];
  assert.equal(run.active_generation, 0);
  assert.equal(run.attempts, 0, "no failure written by the loser");
  assert.equal(run.locked_by, "someone-else");
});

test("stale locks (dead worker) are released and the run is resumed, a live lock is left alone", async () => {
  const { state, repo, pipeline } = setup();
  await pipeline.scheduleRuns();
  const [run] = repo._runs;
  Object.assign(run, { status: "EASYCOM_FETCHING", locked_at: state.t - 60000, locked_by: "dead" });
  assert.equal(await repo.releaseStaleLocks(15 * 60000), 0);
  state.t += 16 * 60000;
  assert.equal(await repo.releaseStaleLocks(15 * 60000), 1);
  assert.equal(run.locked_by, null);
  assert.equal(run.status, "EASYCOM_FETCHING");
});

test("memory stays bounded by the kept set: shipments for unknown codes are dropped page by page", async () => {
  const junk = Array.from({ length: 5000 }, (_, i) => ({ reference: `X${i}`, pickedAtRaw: "2026-11-19 01:00:00" }));
  const { repo, pipeline } = setup({ pages: [junk, junk, [{ reference: "R1", pickedAtRaw: "2026-11-18 14:00:00" }]] });
  assert.equal((await pipeline.tick()).outcome, "completed");
  assert.equal(repo._runs[0].easycom_fetched, 10001);
  assert.equal(repo._orders.length, 2);
});

test("cancel: a CANCEL request stops the run at the next checkpoint, discards its rows and keeps the earlier report", async () => {
  const { repo, pipeline } = setup();
  const realHeartbeat = repo.heartbeat;
  let calls = 0;
  repo.heartbeat = async (id, w) => {
    calls += 1;
    if (calls === 6) repo._runs[0].control = "CANCEL"; // asked part-way through
    return realHeartbeat(id, w);
  };
  const r = await pipeline.tick();
  assert.equal(r.outcome, "cancelled");
  const run = repo._runs[0];
  assert.deepEqual([run.status, run.control, run.locked_by, run.active_generation, run.attempts], ["CANCELLED", "NONE", null, 0, 0]);
  assert.equal(repo._orders.length, 0, "partial rows are gone");
  assert.equal((await repo.claimNext("AJMAL", "w1")), null, "a cancelled run is never claimed again");
});

test("pause: the run holds at a checkpoint, keeps its lock fresh, and finishes after resume", async () => {
  const { repo, state, config } = setup();
  const sleeps = [];
  const pipeline = buildPipeline({
    config, repo, gmail: fakeGmail({ messages: [message()], csvByMessage: { m1: CSV } }), easycom: fakeEasycom({ pages: [[{ reference: "R1", pickedAtRaw: "2026-11-18 14:00:00" }]] }),
    now: () => state.t, workerId: "w1",
    sleep: async (ms) => { sleeps.push(ms); advance(state, ms); if (sleeps.length === 3) repo._runs[0].control = "NONE"; },
  });
  const realHeartbeat = repo.heartbeat;
  let calls = 0;
  repo.heartbeat = async (id, w) => { calls += 1; if (calls === 4) repo._runs[0].control = "PAUSE"; return realHeartbeat(id, w); };
  const r = await pipeline.tick();
  assert.equal(r.outcome, "completed");
  assert.equal(sleeps.length, 3, "waited while paused");
  assert.equal(repo._runs[0].status, "COMPLETED");
});

test("pause that is never resumed is cancelled after the limit", async () => {
  const { repo, state, config } = setup({ configOver: {} });
  config.worker.pauseMaxMs = 10000;
  const pipeline = buildPipeline({
    config, repo, gmail: fakeGmail({ messages: [message()], csvByMessage: { m1: CSV } }), easycom: fakeEasycom({ pages: [[]] }),
    now: () => state.t, workerId: "w1", sleep: async (ms) => advance(state, ms),
  });
  const realHeartbeat = repo.heartbeat;
  repo.heartbeat = async (id, w) => { repo._runs[0].control = "PAUSE"; return realHeartbeat(id, w); };
  const r = await pipeline.tick();
  assert.deepEqual([r.outcome, r.code], ["cancelled", "PAUSE_TIMEOUT"]);
  assert.equal(repo._runs[0].error_code, "PAUSE_TIMEOUT");
});

test("each manual upload is a new report for the date; the automated report is untouched", async () => {
  const { repo } = setup();
  await repo.ensureRun({ brandKey: "AJMAL", reportDate: "2026-11-19", windows: { ndd: { start: "a", end: "b" }, other: { start: "c", end: "d" } } });
  const first = await repo.claimForUpload({ brandKey: "AJMAL", reportDate: "2026-11-19", windows: { ndd: { start: "a", end: "b" }, other: { start: "c", end: "d" } }, lockedBy: "m1", uploadedBy: "u" });
  const second = await repo.claimForUpload({ brandKey: "AJMAL", reportDate: "2026-11-19", windows: { ndd: { start: "a", end: "b" }, other: { start: "c", end: "d" } }, lockedBy: "m2", uploadedBy: "u" });
  assert.deepEqual([first.run.report_seq, second.run.report_seq], [2, 3]);
  assert.equal((await repo.listRuns("AJMAL")).length, 3);
  assert.deepEqual(await repo.requeueRun("AJMAL", first.run.id), { requeued: false, reason: "LOCKED" });
});

test("delete: removes the report and its rows; refused while a process holds it; scoped to the brand", async () => {
  const { repo, pipeline } = setup();
  await pipeline.tick();
  const id = repo._runs[0].id;
  assert.deepEqual(await repo.deleteRun("OTHER", id), { deleted: false, reason: "NOT_FOUND" });
  repo._runs[0].locked_at = 1;
  assert.deepEqual(await repo.deleteRun("AJMAL", id), { deleted: false, reason: "LOCKED" });
  repo._runs[0].locked_at = null;
  assert.deepEqual(await repo.deleteRun("AJMAL", id), { deleted: true });
  assert.deepEqual([repo._runs.length, repo._orders.length, repo._summary.length], [0, 0, 0]);
});

test("upload: files put in the wrong slots (pickup export as GoKwik, orders export as EasyCom) are swapped and still build the report", async () => {
  const path = require("path");
  const { repo, config, state } = setup();
  const pipeline = buildPipeline({ config, repo, gmail: fakeGmail({ messages: [], csvByMessage: {} }), easycom: fakeEasycom({ pages: [] }), now: () => state.t, workerId: "w1" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndd-swap-"));
  const orders = path.join(dir, "orders.csv");
  const pickups = path.join(dir, "pickups.csv");
  fs.writeFileSync(orders, CSV.replace("Courier Name", "Courier"));
  fs.writeFileSync(pickups, "S.no,AWB,Order Code,Shipment picked at\n1,A1,R1,11/18/2026 02:15 PM\n2,A2,R2,\n");
  const windows = { ndd: { start: "2026-11-18 12:00:00", end: "2026-11-19 12:00:00" }, other: { start: "2026-11-18 15:00:00", end: "2026-11-19 15:00:00" } };
  const claim = await repo.claimForUpload({ brandKey: "AJMAL", reportDate: "2026-11-19", windows, lockedBy: "manual:u", uploadedBy: "u" });
  // the pickup export sits in the GoKwik slot, the orders export in the EasyCom slot
  const r = await pipeline.processUpload(claim.run, { gokwik: { path: pickups, name: "pickups.csv" }, easycom: { path: orders, name: "orders.csv" } });
  assert.equal(r.outcome, "completed");
  const stored = Object.fromEntries(repo._orders.map((o) => [o.reference_code, o]));
  assert.equal(stored.R1.sla_status, "MET");
  assert.equal(stored.R1.shipment_picked_at, "2026-11-18 14:15:00");
  assert.equal(stored.R2.sla_status, "BREACHED");
  assert.equal(repo._runs.find((x) => x.id === claim.run.id).source_filename, "orders.csv", "the audit record names the files by their real role");
  fs.rmSync(dir, { recursive: true, force: true });
});
