// Golden test for the 19-Nov-2026 report. The whole path runs for real (matcher -> streamed CSV -> processor -> paged
// EasyCom -> batched persistence -> activation -> API); only Gmail/EasyCom transport and the database are in-memory.
// Expectations come from the fixture's own independent derivation, never from the processor under test.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { buildGolden, REPORT_DATE, EXPECTED_TOTAL } = require("./helpers/golden");
const { testConfig, fakeRepo, fakeGmail, fakeEasycom } = require("./helpers/fakes");
const { buildPipeline } = require("../src/services/pipeline");
const { buildApp } = require("../src/app");
const { wallToEpochMs } = require("../src/lib/wall");

const TZ = "Asia/Kolkata";

async function runGolden(overrides = {}) {
  const golden = buildGolden();
  const config = testConfig({}, { NDD_SLA_DB_BATCH_ROWS: "200", ...overrides });
  const clock = { t: wallToEpochMs("2026-11-19 16:00:00", TZ) };
  const repo = fakeRepo({ now: () => clock.t });
  const gmail = fakeGmail({
    messages: [{
      id: "msg-1", from: "GoKwik Reports <reports@gokwik.test>", subject: "Orders report 19-Nov-2026",
      receivedMs: wallToEpochMs("2026-11-19 15:30:00", TZ), attachments: [{ id: "att-1", filename: "orders_19nov.csv", size: golden.csv.length }],
    }],
    csvByMessage: { "msg-1": golden.csv },
  });
  const easycom = fakeEasycom({ pages: golden.pages });
  const pipeline = buildPipeline({ config, repo, gmail, easycom, now: () => clock.t, workerId: "w1" });
  const results = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await pipeline.tick();
    results.push(r);
    if (r.outcome === "idle") break;
  }
  return { golden, config, repo, gmail, easycom, results };
}

test("golden 19-Nov: pipeline output equals the independently derived expectation", async () => {
  const { golden, repo, results } = await runGolden();
  const done = results.find((r) => r.outcome === "completed" && r.runId);
  assert.ok(done, `expected a completed run, got ${JSON.stringify(results.map((r) => r.outcome))}`);

  const run = repo._runs.find((r) => r.report_date === REPORT_DATE);
  assert.equal(run.status, "COMPLETED");
  assert.equal(run.active_generation, 1);

  // Every rejection rule did its job, each counted separately.
  assert.equal(run.rows_in, golden.totalRows);
  assert.equal(run.rows_wrong_client, golden.noise.wrong_client);
  assert.equal(run.rows_wrong_status, golden.noise.wrong_status);
  assert.equal(run.rows_out_of_window, golden.noise.out_of_window);
  assert.equal(run.rows_duplicate, golden.noise.duplicate);
  assert.equal(run.rows_invalid, golden.noise.invalid);
  assert.equal(run.rows_kept, golden.kept.length);

  // Totals by location, from what was actually persisted.
  const stored = repo._orders.filter((o) => o.run_id === run.id && o.generation === 1);
  const byLoc = (loc) => stored.filter((o) => o.client_location === loc).length;
  assert.equal(stored.length, 1063);
  assert.equal(byLoc("AJMAL_SONS"), EXPECTED_TOTAL.AJMAL_SONS);
  assert.equal(byLoc("EMIZA_GGN"), EXPECTED_TOTAL.EMIZA_GGN);
  assert.equal(new Set(stored.map((o) => o.reference_code)).size, stored.length, "one row per Reference Code");

  // Row by row: window, hour, NDD flag, pickup (NULL when none, never a 1900 date) and SLA all match the expectation.
  const byRef = new Map(stored.map((o) => [o.reference_code, o]));
  for (const want of golden.kept) {
    const got = byRef.get(want.reference);
    assert.ok(got, `${want.reference} is missing`);
    assert.equal(got.client_location, want.location, want.reference);
    assert.equal(got.order_at, want.orderAt, want.reference);
    assert.equal(got.order_date, want.orderDate, want.reference);
    assert.equal(got.order_hour, want.orderHour, want.reference);
    assert.equal(Boolean(got.is_ndd), want.isNdd, want.reference);
    assert.equal(got.shipment_picked_at, want.pickedAt, want.reference);
    assert.equal(got.sla_status, want.sla, want.reference);
  }
  assert.equal(stored.filter((o) => String(o.shipment_picked_at || "").includes("1900")).length, 0);
  for (const ref of ["OTH-0", "BAD-0", "OUT-0", "BADDATE-0"]) assert.equal(byRef.has(ref), false, `${ref} must not be reported`);

  // Hourly summary equals the oracle, and met+breached == total everywhere.
  const summary = repo._summary.filter((s) => s.run_id === run.id && s.generation === 1);
  assert.equal(summary.length, golden.buckets.size);
  for (const s of summary) {
    const want = golden.buckets.get(`${s.client_location}|${s.order_date}|${s.order_hour}`);
    assert.ok(want, `unexpected bucket ${s.client_location} ${s.order_date} ${s.order_hour}`);
    assert.deepEqual([s.met_count, s.breached_count, s.total_count], [want.met, want.breached, want.total]);
  }
  const met = golden.kept.filter((o) => o.sla === "MET").length;
  assert.equal(run.sla_met, met);
  assert.equal(run.sla_breached, 1063 - met);
  assert.ok(met > 0 && met < 1063, "fixture must contain both outcomes");
  assert.equal(run.rows_unmatched, 0);
  assert.equal(run.easycom_pages, golden.pages.length);
});

test("golden 19-Nov: persistence is batched (no giant insert) and a Gmail download feeds exactly one run", async () => {
  const { repo, gmail } = await runGolden();
  assert.ok(repo._inserts.length >= 6, `expected several batches, got ${repo._inserts.length}`);
  assert.ok(Math.max(...repo._inserts) <= 200);
  assert.equal(repo._inserts.reduce((a, b) => a + b, 0), 1063);
  const completed = repo._runs.filter((r) => r.status === "COMPLETED");
  assert.equal(completed.length, 1, "only 19-Nov has a source; earlier dates keep waiting");
  assert.ok(gmail.calls.download >= 1);
});

test("golden 19-Nov: the API serves the same numbers (totals, per location, percentages, paged orders)", async () => {
  const { repo, config, golden } = await runGolden();
  const app = buildApp({ config, repo });
  const H = { "x-user-id": "u1", "x-brand-id": "AJMAL", "x-role": "viewer", "x-permissions": "ndd_sla_panel" };

  const res = await request(app).get(`/ndd-sla/reports/${REPORT_DATE}`).set(H).expect(200);
  assert.equal(res.body.run.status, "COMPLETED");
  assert.equal(res.body.run.ready, true);
  assert.equal(res.body.totals.total, 1063);
  const loc = Object.fromEntries(res.body.locations.map((l) => [l.location, l]));
  assert.equal(loc.AJMAL_SONS.total, 754);
  assert.equal(loc.EMIZA_GGN.total, 309);
  assert.equal(loc.AJMAL_SONS.label, "AJMAL & SONS");
  const met = golden.kept.filter((o) => o.sla === "MET").length;
  assert.equal(res.body.totals.met, met);
  assert.equal(res.body.totals.metPct, Math.round((met / 1063) * 1000) / 10);
  assert.equal(res.body.totals.metPct + res.body.totals.breachedPct > 99.8, true);

  // Pagination: walk every page; the union is exactly the 1,063 orders, in a stable order, with no repeats.
  const seen = [];
  let cursor;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await request(app).get(`/ndd-sla/reports/${REPORT_DATE}/orders`).query({ limit: 200, ...(cursor ? { cursor } : {}) }).set(H).expect(200);
    seen.push(...page.body.orders.map((o) => o.referenceCode));
    cursor = page.body.nextCursor;
    if (!cursor) break;
  }
  assert.equal(seen.length, 1063);
  assert.equal(new Set(seen).size, 1063);
  const breached = await request(app).get(`/ndd-sla/reports/${REPORT_DATE}/orders`).query({ sla: "BREACHED", limit: 500 }).set(H).expect(200);
  assert.ok(breached.body.orders.every((o) => o.sla === "BREACHED"));
  assert.ok(breached.body.orders.filter((o) => o.shipmentPickedAt !== null).length === 0, "breached orders never carry a pickup time");
});
