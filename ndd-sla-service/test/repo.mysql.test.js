// Runs the real repo SQL (and the golden pipeline) against a MySQL 8 server. SKIPPED unless NDD_TEST_DB_HOST is set.
// It applies migrations/001 to a THROWAWAY database you point it at and DROPs the ndd_sla_* tables first, so never
// aim it at a real database:
//   NDD_TEST_DB_HOST=127.0.0.1 NDD_TEST_DB_PORT=33399 NDD_TEST_DB_USER=root NDD_TEST_DB_PASSWORD= NDD_TEST_DB_NAME=ndd_test npm test
// (Local throwaway server used during development: `mysqld --initialize-insecure` on its own datadir and port.)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const request = require("supertest");
const { buildRepo } = require("../src/services/repo");
const { buildCredentials } = require("../src/services/credentials");
const { buildPipeline } = require("../src/services/pipeline");
const { buildApp } = require("../src/app");
const { buildGolden, REPORT_DATE, EXPECTED_TOTAL } = require("./helpers/golden");
const { testConfig, fakeGmail, fakeEasycom } = require("./helpers/fakes");
const { wallToEpochMs } = require("../src/lib/wall");

const env = process.env;
const opts = { skip: env.NDD_TEST_DB_HOST ? false : "set NDD_TEST_DB_HOST to run the MySQL tests" };
const windows = { ndd: { start: "2026-11-18 12:00:00", end: "2026-11-19 12:00:00" }, other: { start: "2026-11-18 15:00:00", end: "2026-11-19 15:00:00" } };
let pool;
let repo;

const order = (ref, over = {}) => ({
  reference: ref, location: "AJMAL_SONS", orderAt: "2026-11-18 13:00:00", orderDate: "2026-11-18", orderHour: 13,
  courier: "BlitzNDD", isNdd: true, pickedAt: null, sla: "BREACHED", ...over,
});
const dates = (n) => Array.from({ length: n }, (_, i) => `2027-01-${String(i + 1).padStart(2, "0")}`);

test("setup: apply the real migration to the throwaway database", opts, async () => {
  pool = mysql.createPool({
    host: env.NDD_TEST_DB_HOST, port: Number(env.NDD_TEST_DB_PORT || 3306), user: env.NDD_TEST_DB_USER,
    password: env.NDD_TEST_DB_PASSWORD, database: env.NDD_TEST_DB_NAME, multipleStatements: true, timezone: "Z", dateStrings: true,
  });
  await pool.query("DROP TABLE IF EXISTS ndd_sla_events, ndd_sla_summary, ndd_sla_orders, ndd_sla_credentials, ndd_sla_runs");
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "migrations", "001-create-ndd-sla.sql"), "utf8"));
  repo = buildRepo(pool);
  // Before 002 the schema check must complain about the missing source_mode column.
  assert.deepEqual(await repo.checkSchema(), { ok: false, missing: ["ndd_sla_runs.source_mode"] });
  // 001 is documented as safe to run twice.
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "migrations", "001-create-ndd-sla.sql"), "utf8"));
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "migrations", "002-add-manual-upload.sql"), "utf8"));
  assert.deepEqual(await repo.checkSchema(), { ok: true, missing: [] });
});

test("lifecycle: ensure (idempotent) -> claim -> generation -> batched insert -> activate -> read", opts, async () => {
  assert.equal((await repo.ensureRun({ brandKey: "AJMAL", reportDate: "2026-11-19", windows })).created, true);
  assert.equal((await repo.ensureRun({ brandKey: "AJMAL", reportDate: "2026-11-19", windows })).created, false);
  const run = await repo.claimNext("AJMAL", "w1");
  assert.equal(run.report_date, "2026-11-19");
  assert.equal(run.ndd_window_start, "2026-11-18 12:00:00", "wall-clock DATETIME comes back untouched");
  assert.equal(await repo.claimNext("AJMAL", "w2"), null, "a locked run is not claimed twice");

  await repo.update(run.id, "w1", { gmail_message_id: "m1", source_filename: "o.csv" });
  await repo.transition(run.id, "w1", "PROCESSING", { rows_kept: 2 });
  const gen = await repo.beginGeneration(run.id, "w1");
  assert.equal(gen, 1);
  await repo.insertOrders(run.id, gen, [
    order("A", { pickedAt: "2026-11-18 14:00:00", sla: "MET" }),
    order("B", { location: "EMIZA_GGN", orderAt: "2026-11-18 16:00:00", orderHour: 16, courier: "Delhivery", isNdd: false }),
  ]);
  await repo.insertSummary(run.id, gen, [
    { location: "AJMAL_SONS", orderDate: "2026-11-18", orderHour: 13, met: 1, breached: 0, total: 1 },
    { location: "EMIZA_GGN", orderDate: "2026-11-18", orderHour: 16, met: 0, breached: 1, total: 1 },
  ]);
  assert.equal((await repo.getRun("AJMAL", "2026-11-19")).active_generation, 0, "not visible before activation");
  await repo.activate(run.id, "w1", gen, { sla_met: 1, sla_breached: 1 });
  const done = await repo.getRun("AJMAL", "2026-11-19");
  assert.deepEqual([done.status, done.active_generation, done.locked_by], ["COMPLETED", 1, null]);
  const orders = await repo.listOrders(run.id, 1, { limit: 10 });
  assert.deepEqual(orders.map((o) => [o.reference_code, o.shipment_picked_at]), [["A", "2026-11-18 14:00:00"], ["B", null]]);
  assert.equal((await repo.getSummary(run.id, 1)).length, 2);
  assert.equal(await repo.getRun("OTHER", "2026-11-19"), null);
});

test("fencing and duplicate Gmail message against real MySQL", opts, async () => {
  await repo.ensureRun({ brandKey: "AJMAL", reportDate: "2026-11-20", windows });
  const run = await repo.claimNext("AJMAL", "w1");
  await assert.rejects(repo.heartbeat(run.id, "intruder"), (e) => e.code === "LOCK_LOST");
  await assert.rejects(repo.update(run.id, "w1", { gmail_message_id: "m1" }), (e) => e.code === "GMAIL_MESSAGE_ALREADY_USED");
  assert.equal(await repo.releaseStaleLocks(3600 * 1000), 0);
});

test("credentials round trip through the real table", opts, async () => {
  const creds = buildCredentials(pool, { aesKey: "k".repeat(32) });
  await creds.save("AJMAL", "EASYCOM", "tok-1234");
  assert.equal(await creds.getToken("AJMAL", "EASYCOM"), "tok-1234");
  await creds.save("AJMAL", "EASYCOM", "tok-5678"); // upsert
  assert.equal(await creds.getToken("AJMAL", "EASYCOM"), "tok-5678");
  const [row] = await creds.describe("AJMAL");
  assert.equal(row.tokenSuffix, "5678");
  const [[raw]] = await pool.query("SELECT token_encrypted FROM ndd_sla_credentials WHERE brand_key = 'AJMAL'");
  assert.ok(!raw.token_encrypted.includes("tok-"), "stored encrypted");
});

test("schema: indexes, unique keys, foreign keys and enums are really there and enforced", opts, async () => {
  const idx = async (table) => (await pool.query(`SHOW INDEX FROM ${table}`))[0].reduce((m, r) => { (m[r.Key_name] ||= []).push(r.Column_name); return m; }, {});
  const runs = await idx("ndd_sla_runs");
  assert.deepEqual(runs.uq_run, ["brand_key", "report_date", "report_type"]);
  assert.deepEqual(runs.uq_msg, ["brand_key", "gmail_message_id"]);
  assert.deepEqual(runs.idx_claim, ["status", "next_attempt_at", "locked_at"]);
  const orders = await idx("ndd_sla_orders");
  assert.deepEqual(orders.idx_list, ["run_id", "generation", "client_location", "order_at", "reference_code"]);
  assert.deepEqual(orders.PRIMARY, ["run_id", "generation", "reference_code"]);

  await repo.ensureRun({ brandKey: "SCHEMA", reportDate: "2027-02-01", windows });
  const run = await repo.getRun("SCHEMA", "2027-02-01");
  const insert = "INSERT INTO ndd_sla_orders (run_id, generation, reference_code, client_location, order_at, order_date, order_hour, courier, is_ndd, sla_status) VALUES (?, 1, 'X', ?, '2027-02-01 10:00:00', '2027-02-01', 10, 'c', 0, 'MET')";
  await assert.rejects(pool.query(insert, [run.id, "NOPE"]), /Data truncated|enum|Incorrect/i);
  await assert.rejects(pool.query(insert, [999999, "AJMAL_SONS"]), /foreign key/i);
  await repo.insertOrders(run.id, 1, [order("A")]);
  await assert.rejects(repo.insertOrders(run.id, 1, [order("A")]), /Duplicate entry/, "one row per Reference Code per generation");
  await pool.query("DELETE FROM ndd_sla_runs WHERE id = ?", [run.id]);
  assert.equal((await pool.query("SELECT COUNT(*) n FROM ndd_sla_orders WHERE run_id = ?", [run.id]))[0][0].n, 0, "ON DELETE CASCADE");
});

test("claiming: concurrent workers never get the same run (SKIP LOCKED); each due run is claimed once", opts, async () => {
  for (const d of dates(3)) await repo.ensureRun({ brandKey: "RACE", reportDate: d, windows });
  const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => repo.claimNext("RACE", `w${i}`)));
  const got = claims.filter(Boolean);
  assert.equal(got.length, 3, "three runs, three winners");
  assert.equal(new Set(got.map((r) => r.id)).size, 3);
  const [rows] = await pool.query("SELECT locked_by FROM ndd_sla_runs WHERE brand_key = 'RACE'");
  assert.ok(rows.every((r) => r.locked_by));
});

test("claim eligibility against real SQL: terminal states, final failures, due and not-yet-due retries", opts, async () => {
  const B = "CLAIM";
  const ds = dates(5);
  for (const d of ds) await repo.ensureRun({ brandKey: B, reportDate: d, windows });
  const set = (date, sql) => pool.query(`UPDATE ndd_sla_runs SET ${sql} WHERE brand_key = ? AND report_date = ?`, [B, date]);
  await set(ds[0], "status = 'COMPLETED'");
  await set(ds[1], "status = 'GOKWIK_TIMEOUT'");
  await set(ds[2], "status = 'EASYCOM_FAILED', next_attempt_at = NULL");
  await set(ds[3], "status = 'EASYCOM_FAILED', next_attempt_at = (UTC_TIMESTAMP() + INTERVAL 1 HOUR)");
  assert.equal((await repo.claimNext(B, "w1")).report_date, ds[4], "only the plain SCHEDULED run is claimable");
  assert.equal(await repo.claimNext(B, "w2"), null);
  await set(ds[3], "next_attempt_at = (UTC_TIMESTAMP() - INTERVAL 1 SECOND)");
  assert.equal((await repo.claimNext(B, "w2")).report_date, ds[3], "a due retry is claimed");
});

test("failure bookkeeping: failAttempt (retry and final), scheduleWait, stale-lock release, requeue, audit events", opts, async () => {
  const B = "FAIL";
  await repo.ensureRun({ brandKey: B, reportDate: "2027-03-01", windows });
  let run = await repo.claimNext(B, "w1");
  await repo.failAttempt(run.id, "w1", { status: "EASYCOM_FAILED", code: "EASYCOM_UNAVAILABLE", detail: "HTTP 503", delayMs: 90000 });
  let row = await repo.getRun(B, "2027-03-01");
  assert.deepEqual([row.status, row.attempts, row.error_code, row.locked_by], ["EASYCOM_FAILED", 1, "EASYCOM_UNAVAILABLE", null]);
  const [[dueRow]] = await pool.query("SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), next_attempt_at) s FROM ndd_sla_runs WHERE id = ?", [run.id]);
  const due = Number(dueRow.s);
  assert.ok(due > 60 && due <= 90, `next_attempt_at is ~90s ahead, got ${due}`);
  assert.equal(await repo.claimNext(B, "w2"), null, "not due yet");

  await pool.query("UPDATE ndd_sla_runs SET next_attempt_at = NULL, status = 'SCHEDULED' WHERE id = ?", [run.id]);
  run = await repo.claimNext(B, "w1");
  await repo.scheduleWait(run.id, "w1", 60000);
  row = await repo.getRun(B, "2027-03-01");
  assert.deepEqual([row.status, row.attempts], ["WAITING_FOR_GOKWIK", 1], "waiting does not count as a failed attempt");

  await pool.query("UPDATE ndd_sla_runs SET next_attempt_at = NULL WHERE id = ?", [run.id]);
  run = await repo.claimNext(B, "w1");
  await repo.failAttempt(run.id, "w1", { status: "PROCESSING_FAILED", code: "X", detail: "final", delayMs: null });
  assert.equal(await repo.claimNext(B, "w3"), null, "a final failure is never claimed");

  assert.deepEqual(await repo.requeue(B, "2027-03-01"), { requeued: true, id: run.id });
  row = await repo.getRun(B, "2027-03-01");
  assert.deepEqual([row.status, row.attempts, row.error_code, row.gmail_message_id], ["SCHEDULED", 0, null, null]);
  run = await repo.claimNext(B, "w4");
  assert.deepEqual(await repo.requeue(B, "2027-03-01"), { requeued: false, reason: "LOCKED" });
  assert.deepEqual(await repo.requeue(B, "1999-01-01"), { requeued: false, reason: "NOT_FOUND" });

  await pool.query("UPDATE ndd_sla_runs SET locked_at = (UTC_TIMESTAMP() - INTERVAL 20 MINUTE) WHERE id = ?", [run.id]);
  assert.equal(await repo.releaseStaleLocks(15 * 60000), 1);
  await assert.rejects(repo.heartbeat(run.id, "w4"), (e) => e.code === "LOCK_LOST", "the dead worker can no longer write");
  const events = (await pool.query("SELECT to_status FROM ndd_sla_events WHERE run_id = ? ORDER BY id", [run.id]))[0].map((e) => e.to_status);
  assert.ok(events.includes("EASYCOM_FAILED") && events.includes("PROCESSING_FAILED") && events.at(-1) === "SCHEDULED");
});

test("transactions: a lost-lock activate rolls back; the previous generation stays complete and visible", opts, async () => {
  const B = "TXN";
  await repo.ensureRun({ brandKey: B, reportDate: "2027-04-01", windows });
  let run = await repo.claimNext(B, "w1");
  let gen = await repo.beginGeneration(run.id, "w1");
  await repo.insertOrders(run.id, gen, [order("OLD1"), order("OLD2")]);
  await repo.insertSummary(run.id, gen, [{ location: "AJMAL_SONS", orderDate: "2026-11-18", orderHour: 13, met: 0, breached: 2, total: 2 }]);
  await repo.activate(run.id, "w1", gen, { sla_breached: 2 });
  assert.equal(gen, 1);

  await repo.requeue(B, "2027-04-01");
  run = await repo.claimNext(B, "w2");
  gen = await repo.beginGeneration(run.id, "w2");
  assert.equal(gen, 2);
  await repo.insertOrders(run.id, gen, [order("NEW1")]);
  await pool.query("UPDATE ndd_sla_runs SET locked_by = 'thief' WHERE id = ?", [run.id]); // lock stolen mid-run
  await assert.rejects(repo.activate(run.id, "w2", gen, { sla_breached: 1 }), (e) => e.code === "LOCK_LOST");
  const row = await repo.getRun(B, "2027-04-01");
  assert.equal(row.active_generation, 1, "the failed activation did not switch generations");
  assert.deepEqual((await repo.listOrders(run.id, 1, { limit: 10 })).map((o) => o.reference_code), ["OLD1", "OLD2"]);
  assert.equal((await repo.getSummary(run.id, 1)).length, 1);

  await pool.query("UPDATE ndd_sla_runs SET locked_by = 'w2' WHERE id = ?", [run.id]);
  await repo.discardGeneration(run.id, 2);
  assert.equal(await repo.beginGeneration(run.id, "w2"), 3, "generation numbers never repeat");
  await repo.insertOrders(run.id, 3, [order("NEW2")]);
  await repo.activate(run.id, "w2", 3, {});
  assert.deepEqual((await pool.query("SELECT reference_code, generation FROM ndd_sla_orders WHERE run_id = ? ORDER BY generation, reference_code", [run.id]))[0].map((r) => [r.reference_code, r.generation]),
    [["OLD1", 1], ["OLD2", 1], ["NEW2", 3]], "generation 1 is kept one more cycle for readers that started before the switch");
  await repo.requeue(B, "2027-04-01");
  await repo.claimNext(B, "w5");
  assert.equal(await repo.beginGeneration(run.id, "w5"), 4);
  await repo.insertOrders(run.id, 4, [order("NEW3")]);
  await repo.activate(run.id, "w5", 4, {});
  assert.deepEqual((await pool.query("SELECT DISTINCT generation g FROM ndd_sla_orders WHERE run_id = ? ORDER BY g", [run.id]))[0].map((r) => r.g), [3, 4], "the next activation drops generation 1");
});

test("batched inserts: thousands of rows, atomic per statement, NULL pickups, keyset pages, index-ordered query plan", opts, async () => {
  await repo.ensureRun({ brandKey: "BULK", reportDate: "2027-05-01", windows });
  const run = await repo.claimNext("BULK", "w1");
  const gen = await repo.beginGeneration(run.id, "w1");
  const rows = Array.from({ length: 5000 }, (_, i) => order(`R${String(i).padStart(5, "0")}`, {
    location: i % 3 ? "AJMAL_SONS" : "EMIZA_GGN",
    orderAt: `2026-11-18 ${String(12 + (i % 12)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00`,
    pickedAt: i % 2 ? "2026-11-18 20:00:00" : null, sla: i % 2 ? "MET" : "BREACHED",
  }));
  for (let i = 0; i < rows.length; i += 500) await repo.insertOrders(run.id, gen, rows.slice(i, i + 500));
  assert.equal((await pool.query("SELECT COUNT(*) n FROM ndd_sla_orders WHERE run_id = ?", [run.id]))[0][0].n, 5000);
  assert.equal((await pool.query("SELECT COUNT(*) n FROM ndd_sla_orders WHERE run_id = ? AND shipment_picked_at IS NULL", [run.id]))[0][0].n, 2500);
  assert.equal((await pool.query("SELECT COUNT(*) n FROM ndd_sla_orders WHERE run_id = ? AND YEAR(shipment_picked_at) <= 1900", [run.id]))[0][0].n, 0);

  await assert.rejects(repo.insertOrders(run.id, gen, [order("NEWROW"), order("R00001")]), /Duplicate/);
  assert.equal((await pool.query("SELECT COUNT(*) n FROM ndd_sla_orders WHERE run_id = ? AND reference_code = 'NEWROW'", [run.id]))[0][0].n, 0, "a failed batch inserts nothing");

  const expected = rows.filter((r) => r.location === "AJMAL_SONS").length;
  const seen = [];
  let after;
  for (;;) {
    const page = await repo.listOrders(run.id, gen, { location: "AJMAL_SONS", limit: 700, after });
    seen.push(...page.slice(0, 700));
    if (page.length <= 700) break;
    const last = page[699];
    after = { orderAt: last.order_at, reference: last.reference_code };
  }
  assert.equal(seen.length, expected);
  assert.equal(new Set(seen.map((r) => r.reference_code)).size, expected);
  const [plan] = await pool.query("EXPLAIN SELECT * FROM ndd_sla_orders WHERE run_id = ? AND generation = ? AND client_location = ? ORDER BY order_at, reference_code LIMIT 100", [run.id, gen, "AJMAL_SONS"]);
  assert.equal(plan[0].key, "idx_list");
  assert.ok(!/filesort/i.test(plan[0].Extra || ""), `ordered by the index, no filesort (${plan[0].Extra})`);
});

test("golden 19-Nov through the REAL repository and API on MySQL", opts, async () => {
  const golden = buildGolden();
  const config = testConfig({}, { NDD_SLA_DB_BATCH_ROWS: "200", NDD_SLA_SCHEDULE_LOOKBACK_DAYS: "0", NDD_SLA_BRAND_KEY: "GOLD" });
  const t = wallToEpochMs("2026-11-19 16:00:00", "Asia/Kolkata");
  const gmail = fakeGmail({
    messages: [{ id: "gold-1", from: "reports@gokwik.test", subject: "Orders report", receivedMs: wallToEpochMs("2026-11-19 15:30:00", "Asia/Kolkata"), attachments: [{ id: "a", filename: "o.csv", size: 10 }] }],
    csvByMessage: { "gold-1": golden.csv },
  });
  const pipeline = buildPipeline({ config, repo, gmail, easycom: fakeEasycom({ pages: golden.pages }), now: () => t, workerId: "gold-worker" });
  const out = [];
  for (let i = 0; i < 3; i += 1) out.push((await pipeline.tick()).outcome);
  assert.ok(out.includes("completed"), JSON.stringify(out));

  const run = await repo.getRun("GOLD", REPORT_DATE);
  assert.deepEqual(
    [run.status, run.active_generation, run.rows_kept, run.rows_wrong_client, run.rows_wrong_status, run.rows_out_of_window, run.rows_duplicate, run.rows_invalid],
    ["COMPLETED", 1, 1063, golden.noise.wrong_client, golden.noise.wrong_status, golden.noise.out_of_window, golden.noise.duplicate, golden.noise.invalid],
  );
  const [stored] = await pool.query("SELECT * FROM ndd_sla_orders WHERE run_id = ? AND generation = 1", [run.id]);
  assert.equal(stored.length, 1063);
  const byRef = new Map(stored.map((o) => [o.reference_code, o]));
  for (const want of golden.kept) {
    const got = byRef.get(want.reference);
    assert.deepEqual(
      [got.client_location, got.order_at, got.order_hour, Boolean(got.is_ndd), got.shipment_picked_at, got.sla_status],
      [want.location, want.orderAt, want.orderHour, want.isNdd, want.pickedAt, want.sla], want.reference,
    );
  }
  assert.equal(stored.filter((o) => o.client_location === "AJMAL_SONS").length, EXPECTED_TOTAL.AJMAL_SONS);
  assert.equal(stored.filter((o) => o.client_location === "EMIZA_GGN").length, EXPECTED_TOTAL.EMIZA_GGN);
  const [[sum]] = await pool.query("SELECT SUM(met_count) m, SUM(breached_count) b, SUM(total_count) t FROM ndd_sla_summary WHERE run_id = ? AND generation = 1", [run.id]);
  assert.deepEqual([Number(sum.t), Number(sum.m) + Number(sum.b)], [1063, 1063]);

  const headers = { "x-user-id": "u", "x-brand-id": "GOLD", "x-role": "author", "x-permissions": "all" };
  const res = await request(buildApp({ config, repo })).get(`/ndd-sla/reports/${REPORT_DATE}`).set(headers).expect(200);
  assert.deepEqual([res.body.totals.total, res.body.locations.map((l) => l.total).sort()], [1063, [309, 754]]);
});

test("manual upload: atomic claim, worker never claims manual runs, interrupted uploads fail, requeue hands back to AUTO", opts, async () => {
  const B = "MANUAL";
  const claim = await repo.claimForUpload({ brandKey: B, reportDate: "2027-06-01", windows, lockedBy: "manual:u1:abc123", uploadedBy: "u1" });
  assert.equal(claim.claimed, true);
  assert.deepEqual([claim.run.source_mode, claim.run.status], ["MANUAL", "GOKWIK_RECEIVED"]);
  const second = await repo.claimForUpload({ brandKey: B, reportDate: "2027-06-01", windows, lockedBy: "manual:u2:def456", uploadedBy: "u2" });
  assert.deepEqual([second.claimed, second.reason], [false, "LOCKED"]);
  assert.equal(await repo.claimNext(B, "worker"), null, "locked, and manual anyway");

  await repo.update(claim.run.id, "manual:u1:abc123", { source_filename: "g.csv", easycom_source_filename: "e.csv" });
  const row = await repo.getRun(B, "2027-06-01");
  assert.deepEqual([row.source_mode, row.uploaded_by, row.source_filename, row.easycom_source_filename], ["MANUAL", "u1", "g.csv", "e.csv"]);

  // The uploader process dies: the lock goes stale and the run fails for good, never resumed by the AUTO worker.
  await pool.query("UPDATE ndd_sla_runs SET locked_at = (UTC_TIMESTAMP() - INTERVAL 30 MINUTE) WHERE id = ?", [claim.run.id]);
  await repo.releaseStaleLocks(15 * 60000);
  const dead = await repo.getRun(B, "2027-06-01");
  assert.deepEqual([dead.status, dead.error_code, dead.locked_by, dead.next_attempt_at], ["PROCESSING_FAILED", "UPLOAD_INTERRUPTED", null, null]);
  assert.equal(await repo.claimNext(B, "worker"), null, "a MANUAL run is invisible to the worker");

  // A manual upload over a date that already has a completed AUTO report keeps the old report until activation.
  await repo.ensureRun({ brandKey: B, reportDate: "2027-06-02", windows });
  const auto = await repo.claimNext(B, "w1");
  const g1 = await repo.beginGeneration(auto.id, "w1");
  await repo.insertOrders(auto.id, g1, [order("AUTO1")]);
  await repo.activate(auto.id, "w1", g1, {});
  const over = await repo.claimForUpload({ brandKey: B, reportDate: "2027-06-02", windows, lockedBy: "manual:u1:zzz999", uploadedBy: "u1" });
  assert.equal(over.claimed, true);
  assert.equal((await repo.getRun(B, "2027-06-02")).active_generation, 1);
  assert.deepEqual((await repo.listOrders(auto.id, 1, { limit: 5 })).map((o) => o.reference_code), ["AUTO1"]);

  await pool.query("UPDATE ndd_sla_runs SET locked_at = NULL, locked_by = NULL WHERE id = ?", [over.run.id]);
  assert.deepEqual(await repo.requeue(B, "2027-06-02"), { requeued: true, id: over.run.id });
  assert.equal((await repo.getRun(B, "2027-06-02")).source_mode, "AUTO");
});

test("teardown", opts, async () => { await pool.end(); });
