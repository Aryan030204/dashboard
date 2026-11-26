// Manual mode: an author uploads the GoKwik CSV and the EasyCom export; the SAME pipeline core produces the report.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const zlib = require("zlib");
const request = require("supertest");
const { buildApp } = require("../src/app");
const { buildPipeline } = require("../src/services/pipeline");
const { buildGolden, REPORT_DATE, EXPECTED_TOTAL } = require("./helpers/golden");
const { testConfig, fakeRepo } = require("./helpers/fakes");
const { wallToEpochMs } = require("../src/lib/wall");

const NOW = wallToEpochMs("2026-11-20 10:00:00", "Asia/Kolkata");
const H = (role = "author", permissions = "") => ({ "x-user-id": "uploader-1", "x-brand-id": "AJMAL", "x-role": role, "x-permissions": permissions });
const leftovers = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("ndd-upload-") || f.startsWith("ndd-sla-"));

function easycomCsv(pages) {
  const rows = pages.flat().map((s) => `${s.reference},"${String(s.pickedAtRaw ?? "")}"`);
  return `Reference Code,Shipment Picked At\r\n${rows.join("\r\n")}\r\n`;
}

function setup({ configOver = {}, envOver = {}, pipelineOver } = {}) {
  const repo = fakeRepo({ now: () => NOW });
  const config = testConfig(configOver, { NDD_SLA_DB_BATCH_ROWS: "200", ...envOver });
  const pipeline = pipelineOver || buildPipeline({ config, repo, now: () => NOW, workerId: "api:test" });
  const app = buildApp({ config, repo, pipeline, now: () => NOW });
  return { repo, config, app };
}
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 15)); }
  throw new Error("timed out waiting");
}
const finished = (repo) => waitFor(() => repo._runs.find((r) => r.report_date === REPORT_DATE && !r.locked_at && r.status !== "GOKWIK_RECEIVED"));
const upload = (app, files, headers = H(), date = REPORT_DATE) => {
  let r = request(app).post(`/ndd-sla/reports/${date}/upload`).set(headers);
  for (const [field, f] of Object.entries(files)) r = r.attach(field, f.data, { filename: f.name, contentType: "text/csv" });
  return r;
};

test("manual golden 19-Nov: plain GoKwik CSV + gzipped EasyCom export give the exact expected report", async () => {
  const golden = buildGolden();
  const { repo, app } = setup();
  const res = await upload(app, {
    gokwik: { data: Buffer.from(golden.csv), name: "gokwik_19nov.csv" },
    easycom: { data: zlib.gzipSync(easycomCsv(golden.pages)), name: "easycom_19nov.csv.gz" },
  }).expect(202);
  assert.equal(res.body.accepted, true);

  const run = await finished(repo);
  assert.equal(run.status, "COMPLETED");
  assert.deepEqual([run.source_mode, run.source_filename, run.easycom_source_filename, run.uploaded_by], ["MANUAL", "gokwik_19nov.csv", "easycom_19nov.csv.gz", "uploader-1"]);
  assert.match(run.source_sha256, /^[0-9a-f]{64}$/);
  // An upload applies no time window: the fixture's "outside the window" orders are counted too.
  const total = 1063 + golden.noise.out_of_window;
  assert.deepEqual([run.rows_kept, run.rows_wrong_client, run.rows_wrong_status, run.rows_out_of_window, run.rows_duplicate, run.rows_invalid],
    [total, golden.noise.wrong_client, golden.noise.wrong_status, 0, golden.noise.duplicate, golden.noise.invalid]);

  const stored = repo._orders.filter((o) => o.run_id === run.id && o.generation === run.active_generation);
  assert.equal(stored.length, total);
  const inGolden = stored.filter((o) => !o.reference_code.startsWith("OUT-"));
  assert.equal(inGolden.filter((o) => o.client_location === "AJMAL_SONS").length, EXPECTED_TOTAL.AJMAL_SONS);
  assert.equal(inGolden.filter((o) => o.client_location === "EMIZA_GGN").length, EXPECTED_TOTAL.EMIZA_GGN);
  const byRef = new Map(stored.map((o) => [o.reference_code, o]));
  for (const want of golden.kept) {
    const got = byRef.get(want.reference);
    assert.deepEqual([got.order_at, got.shipment_picked_at, got.sla_status], [want.orderAt, want.pickedAt, want.sla], want.reference);
  }
  await waitFor(() => leftovers().length === 0); // deleted right after the run completes, never stored

  const view = await request(app).get(`/ndd-sla/reports/${REPORT_DATE}`).set(H()).expect(200);
  assert.deepEqual([view.body.totals.total, view.body.run.source.mode, view.body.run.source.easycomFilename], [1063, "MANUAL", "easycom_19nov.csv.gz"]);
});

test("auto and manual agree on every windowed order; manual also counts the orders outside the windows", async () => {
  const golden = buildGolden();
  const { repo, app } = setup();
  await upload(app, { gokwik: { data: zlib.gzipSync(golden.csv), name: "g.csv.gz" }, easycom: { data: Buffer.from(easycomCsv(golden.pages)), name: "e.csv" } }).expect(202);
  const manual = await finished(repo);
  const manualRows = repo._orders.filter((o) => o.run_id === manual.id).map((o) => [o.reference_code, o.order_at, o.shipment_picked_at, o.sla_status]).sort();

  const { fakeGmail, fakeEasycom } = require("./helpers/fakes");
  const autoRepo = fakeRepo({ now: () => NOW });
  const config = testConfig({}, { NDD_SLA_SCHEDULE_LOOKBACK_DAYS: "1" });
  const gmail = fakeGmail({ messages: [{ id: "m", from: "reports@gokwik.test", subject: "Orders report", receivedMs: wallToEpochMs("2026-11-19 15:30:00", "Asia/Kolkata"), attachments: [{ id: "a", filename: "o.csv", size: 1 }] }], csvByMessage: { m: golden.csv } });
  const pipe = buildPipeline({ config, repo: autoRepo, gmail, easycom: fakeEasycom({ pages: golden.pages }), now: () => NOW, workerId: "w" });
  for (let i = 0; i < 3; i += 1) await pipe.tick();
  const auto = autoRepo._runs.find((r) => r.report_date === REPORT_DATE);
  assert.equal(auto.status, "COMPLETED");
  const autoRows = autoRepo._orders.filter((o) => o.run_id === auto.id).map((o) => [o.reference_code, o.order_at, o.shipment_picked_at, o.sla_status]).sort();
  assert.deepEqual(manualRows.filter(([ref]) => !ref.startsWith("OUT-")), autoRows);
  assert.equal(manualRows.length - autoRows.length, golden.noise.out_of_window);
});

test("upload RBAC: needs BOTH ndd_sla_panel (view) and ndd_sla_upload; authors pass; nothing is stored on refusal", async () => {
  const golden = buildGolden();
  const { app, repo } = setup();
  const files = { gokwik: { data: Buffer.from(golden.csv), name: "g.csv" }, easycom: { data: Buffer.from(easycomCsv(golden.pages)), name: "e.csv" } };
  await upload(app, files, H("viewer", "")).expect(403);
  await upload(app, files, H("viewer", "ndd_sla_panel")).expect(403);
  await upload(app, files, H("viewer", "ndd_sla_upload")).expect(403);
  assert.equal(repo._runs.length, 0);
  await upload(app, files, H("viewer", "ndd_sla_panel,ndd_sla_upload")).expect(202);
  await finished(repo);
  assert.deepEqual(leftovers(), []);
});

test("upload validation: both files, non-empty, CSV names, date shape, size limit", async () => {
  const { app, repo } = setup({ envOver: { NDD_SLA_MAX_UPLOAD_BYTES: "2000" } });
  const ok = { data: Buffer.from("Reference Code,Shipment Picked At\n"), name: "e.csv" };
  const small = { data: Buffer.from("a,b\n1,2\n"), name: "g.csv" };
  assert.equal((await upload(app, { gokwik: small }).expect(400)).body.code, "MISSING_FILE");
  assert.equal((await upload(app, { gokwik: { data: Buffer.alloc(0), name: "g.csv" }, easycom: ok }).expect(400)).body.code, "EMPTY_FILE");
  assert.equal((await upload(app, { gokwik: { data: Buffer.from("x"), name: "g.xlsx" }, easycom: ok }).expect(400)).body.code, "UNSUPPORTED_FILE");
  assert.equal((await upload(app, { gokwik: small, easycom: ok }, H(), "not-a-date").expect(400)).body.code, "VALIDATION_ERROR");
  assert.equal((await upload(app, { gokwik: { data: Buffer.alloc(5000, "a"), name: "g.csv" }, easycom: ok }).expect(413)).body.code, "FILE_TOO_LARGE");
  assert.equal(repo._runs.length, 0, "no run is created for a refused upload");
  assert.deepEqual(leftovers(), [], "refused uploads leave no temp files");
});

test("upload can be switched off; the API then answers 404 and nothing runs", async () => {
  const { app } = setup({ envOver: { NDD_SLA_UPLOAD_ENABLED: "false" } });
  const res = await upload(app, { gokwik: { data: Buffer.from("a\n1\n"), name: "g.csv" }, easycom: { data: Buffer.from("a\n1\n"), name: "e.csv" } }).expect(404);
  assert.equal(res.body.code, "UPLOAD_DISABLED");
  assert.deepEqual(leftovers(), []);
});

test("bad files fail the run for good with a clear reason, keep the previous report, and clean up", async () => {
  const golden = buildGolden();
  const { app, repo } = setup();
  await upload(app, { gokwik: { data: Buffer.from(golden.csv), name: "g.csv" }, easycom: { data: Buffer.from(easycomCsv(golden.pages)), name: "e.csv" } }).expect(202);
  const first = await finished(repo);
  const generation = first.active_generation;
  const rowsBefore = repo._orders.length;

  // 1. GoKwik file with the wrong header
  await upload(app, { gokwik: { data: Buffer.from("Wrong,Header\n1,2\n"), name: "g.csv" }, easycom: { data: Buffer.from(easycomCsv(golden.pages)), name: "e.csv" } }).expect(202);
  let run = await waitFor(() => repo._runs[0].status === "PROCESSING_FAILED" && !repo._runs[0].locked_at && repo._runs[0]);
  assert.deepEqual([run.error_code, run.next_attempt_at, run.attempts], ["CSV_MISSING_COLUMNS", null, 1]);
  assert.match(run.error_detail, /Reference Code|Client Location|Courier Name/);
  assert.equal(run.active_generation, generation, "the previous successful report is still served");
  assert.equal(repo._orders.length, rowsBefore);

  // 2. EasyCom file with the wrong header: reported as an EasyCom file problem
  await upload(app, { gokwik: { data: Buffer.from(golden.csv), name: "g.csv" }, easycom: { data: Buffer.from("Foo,Bar\n1,2\n"), name: "e.csv" } }).expect(202);
  run = await waitFor(() => repo._runs[0].status === "EASYCOM_FAILED" && !repo._runs[0].locked_at && repo._runs[0]);
  assert.equal(run.error_code, "CSV_MISSING_COLUMNS");
  assert.match(run.error_detail, /^EasyCom file:/);
  assert.equal(run.active_generation, generation);

  // 3. A corrupt gzip and a gzip bomb
  await upload(app, { gokwik: { data: Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from("not really gzip data")]), name: "g.csv.gz" }, easycom: { data: Buffer.from(easycomCsv(golden.pages)), name: "e.csv" } }).expect(202);
  run = await waitFor(() => repo._runs[0].status === "PROCESSING_FAILED" && !repo._runs[0].locked_at && repo._runs[0].error_code === "FILE_CORRUPT" && repo._runs[0]);
  assert.equal(run.active_generation, generation);
  await waitFor(() => leftovers().length === 0);
});

test("gzip bomb: an upload that expands past the cap is refused", async () => {
  const golden = buildGolden();
  const { app, repo } = setup({ envOver: { NDD_SLA_MAX_EXPANDED_BYTES: "5000" } });
  await upload(app, { gokwik: { data: zlib.gzipSync(golden.csv), name: "g.csv.gz" }, easycom: { data: Buffer.from(easycomCsv(golden.pages)), name: "e.csv" } }).expect(202);
  const run = await waitFor(() => repo._runs[0].status === "PROCESSING_FAILED" && !repo._runs[0].locked_at && repo._runs[0]);
  assert.equal(run.error_code, "FILE_TOO_LARGE");
});

test("a second upload while one is processing is refused (429); a busy date does not block an upload, it becomes another report", async () => {
  const golden = buildGolden();
  let release;
  const gate = new Promise((r) => { release = r; });
  const { repo, config } = setup();
  const slow = { processUpload: async (run) => { await gate; return { outcome: "completed", runId: run.id }; } };
  const app = buildApp({ config, repo, pipeline: slow, now: () => NOW });
  const files = { gokwik: { data: Buffer.from(golden.csv), name: "g.csv" }, easycom: { data: Buffer.from(easycomCsv(golden.pages)), name: "e.csv" } };
  await upload(app, files).expect(202);
  assert.equal((await upload(app, files).expect(429)).body.code, "BUSY");
  release();
  await waitFor(() => leftovers().length === 0);

  repo._runs[0].locked_at = NOW; // something else holds the date's first report
  await upload(app, files).expect(202);
  assert.deepEqual(repo._runs.map((r) => r.report_seq).sort(), [1, 2], "the upload is its own report");
  await waitFor(() => leftovers().length === 0);
});

test("the worker never claims a manual run; a manual run whose uploader died fails as UPLOAD_INTERRUPTED", async () => {
  const state = { t: NOW };
  const repo = fakeRepo({ now: () => state.t });
  const windows = { ndd: { start: "2026-11-18 12:00:00", end: "2026-11-19 12:00:00" }, other: { start: "2026-11-18 15:00:00", end: "2026-11-19 15:00:00" } };
  const claim = await repo.claimForUpload({ brandKey: "AJMAL", reportDate: REPORT_DATE, windows, lockedBy: "manual:u:abc", uploadedBy: "u" });
  assert.equal(claim.claimed, true);
  repo._runs[0].locked_at = null; // pretend the lock was dropped: a manual run must still not be claimable by the worker
  repo._runs[0].status = "SCHEDULED";
  assert.equal(await repo.claimNext("AJMAL", "worker"), null);

  Object.assign(repo._runs[0], { locked_at: state.t, locked_by: "manual:u:abc", status: "EASYCOM_FETCHING" });
  state.t += 20 * 60000;
  assert.equal(await repo.releaseStaleLocks(15 * 60000), 0);
  assert.deepEqual([repo._runs[0].status, repo._runs[0].error_code, repo._runs[0].next_attempt_at], ["PROCESSING_FAILED", "UPLOAD_INTERRUPTED", null]);
  assert.deepEqual(await repo.requeue("AJMAL", REPORT_DATE), { requeued: true, id: repo._runs[0].id });
  assert.equal(repo._runs[0].source_mode, "AUTO", "a requeue hands the date back to the automated flow");
});

test("the report date is only a label: the same files under an unrelated date give the same report", async () => {
  const golden = buildGolden();
  const { app, repo } = setup();
  const files = { gokwik: { data: Buffer.from(golden.csv), name: "g.csv" }, easycom: { data: Buffer.from(easycomCsv(golden.pages)), name: "e.csv" } };
  await upload(app, files, H(), "2025-01-01").expect(202);
  const run = await waitFor(() => repo._runs[0] && !repo._runs[0].locked_at && repo._runs[0].status === "COMPLETED" && repo._runs[0]);
  assert.equal(run.report_date, "2025-01-01");
  assert.deepEqual([run.rows_kept, run.rows_out_of_window], [1063 + golden.noise.out_of_window, 0]);
  // The window view comes from the files' newest order date (19 Nov here), not from the unrelated label date.
  const view = await request(app).get("/ndd-sla/reports/2025-01-01").set(H()).expect(200);
  assert.deepEqual([view.body.totals.total, view.body.run.windows.other.end], [1063, "2026-11-19 15:00:00"]);
});

test("the report counts the window in the files; each order date can be picked and they add up", async () => {
  const golden = buildGolden();
  const { app, repo } = setup();
  const files = { gokwik: { data: Buffer.from(golden.csv), name: "g.csv" }, easycom: { data: Buffer.from(easycomCsv(golden.pages)), name: "e.csv" } };
  await upload(app, files).expect(202);
  await finished(repo);
  const get = async (query) => (await request(app).get(`/ndd-sla/reports/${REPORT_DATE}${query}`).set(H()).expect(200)).body;
  const both = await get("");
  assert.equal(both.totals.total, 1063);
  assert.deepEqual(both.days.map((d) => d.date), ["2026-11-18", "2026-11-19"]);
  for (const d of both.days) assert.equal((await get(`?day=${d.date}`)).totals.total, d.total);
  assert.equal(both.days[0].total + both.days[1].total, 1063);
  const orders = await request(app).get(`/ndd-sla/reports/${REPORT_DATE}/orders?day=2026-11-18&limit=500`).set(H()).expect(200);
  assert.ok(orders.body.orders.length && orders.body.orders.every((o) => o.orderAt.startsWith("2026-11-18") && !o.referenceCode.startsWith("OUT-")));
});
