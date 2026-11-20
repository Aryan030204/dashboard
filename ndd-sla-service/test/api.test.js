const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const request = require("supertest");
const { buildApp } = require("../src/app");
const { testConfig, fakeRepo } = require("./helpers/fakes");

const windows = { ndd: { start: "2026-11-18 12:00:00", end: "2026-11-19 12:00:00" }, other: { start: "2026-11-18 15:00:00", end: "2026-11-19 15:00:00" } };
const SECRET = "s3cret";

async function seeded() {
  const repo = fakeRepo();
  await repo.ensureRun({ brandKey: "AJMAL", reportDate: "2026-11-19", windows });
  await repo.ensureRun({ brandKey: "AJMAL", reportDate: "2026-11-18", windows });
  await repo.ensureRun({ brandKey: "OTHER", reportDate: "2026-11-19", windows });
  const run = repo._runs[0];
  Object.assign(run, { status: "COMPLETED", active_generation: 2, generation: 2, rows_kept: 3, source_filename: "o.csv" });
  await repo.insertOrders(run.id, 2, [
    { reference: "A", location: "AJMAL_SONS", orderAt: "2026-11-18 13:00:00", orderDate: "2026-11-18", orderHour: 13, courier: "BlitzNDD", isNdd: true, pickedAt: "2026-11-18 14:00:00", sla: "MET" },
    { reference: "B", location: "AJMAL_SONS", orderAt: "2026-11-18 16:00:00", orderDate: "2026-11-18", orderHour: 16, courier: "Delhivery", isNdd: false, pickedAt: null, sla: "BREACHED" },
    { reference: "C", location: "EMIZA_GGN", orderAt: "2026-11-19 09:00:00", orderDate: "2026-11-19", orderHour: 9, courier: "Delhivery", isNdd: false, pickedAt: null, sla: "BREACHED" },
  ]);
  await repo.insertSummary(run.id, 2, [
    { location: "AJMAL_SONS", orderDate: "2026-11-18", orderHour: 13, met: 1, breached: 0, total: 1 },
    { location: "AJMAL_SONS", orderDate: "2026-11-18", orderHour: 16, met: 0, breached: 1, total: 1 },
    { location: "EMIZA_GGN", orderDate: "2026-11-19", orderHour: 9, met: 0, breached: 1, total: 1 },
  ]);
  // stale data from an old generation that must never be served
  await repo.insertOrders(run.id, 1, [{ reference: "OLD", location: "AJMAL_SONS", orderAt: "2026-11-18 13:00:00", orderDate: "2026-11-18", orderHour: 13, courier: "x", isNdd: false, pickedAt: null, sla: "BREACHED" }]);
  return repo;
}

function signed(brand, { secret = SECRET, ts = Math.floor(Date.now() / 1000), user = "u1", role = "viewer", perms = "ndd_sla_panel" } = {}) {
  const sig = crypto.createHmac("sha256", secret).update([user, brand, role, ts].join("|")).digest("hex");
  return { "x-user-id": user, "x-brand-id": brand, "x-role": role, "x-permissions": perms, "x-gw-ts": String(ts), "x-gw-sig": sig };
}

test("auth: signature required (bad signature, stale timestamp, missing headers) and the brand comes from the signed header", async () => {
  const app = buildApp({ config: testConfig({ gatewaySharedSecret: SECRET, allowInsecureAuth: false }), repo: await seeded() });
  await request(app).get("/ndd-sla/runs").expect(401);
  await request(app).get("/ndd-sla/runs").set(signed("AJMAL", { secret: "wrong" })).expect(401);
  await request(app).get("/ndd-sla/runs").set(signed("AJMAL", { ts: 1000 })).expect(401);
  const ok = await request(app).get("/ndd-sla/runs").set(signed("AJMAL")).expect(200);
  assert.deepEqual(ok.body.runs.map((r) => r.reportDate), ["2026-11-19", "2026-11-18"]);
  // Tenant isolation: another brand sees only its own run, and cannot read AJMAL's report by date.
  const other = await request(app).get("/ndd-sla/runs").set(signed("OTHER")).expect(200);
  assert.equal(other.body.runs.length, 1);
  await request(app).get("/ndd-sla/reports/2026-11-18").set(signed("OTHER")).expect(404);
  await request(app).get("/health").expect(200);
});

test("report: serves only the active generation, with per-location/hourly counts and derived percentages", async () => {
  const app = buildApp({ config: testConfig(), repo: await seeded() });
  const H = { "x-user-id": "u", "x-brand-id": "AJMAL", "x-role": "viewer", "x-permissions": "ndd_sla_panel" };
  const res = await request(app).get("/ndd-sla/reports/2026-11-19").set(H).expect(200);
  assert.equal(res.body.totals.total, 3);
  assert.deepEqual([res.body.totals.met, res.body.totals.breached, res.body.totals.metPct, res.body.totals.breachedPct], [1, 2, 33.3, 66.7]);
  const aj = res.body.locations.find((l) => l.location === "AJMAL_SONS");
  assert.deepEqual([aj.total, aj.metPct], [2, 50]);
  assert.equal(aj.hourly.length, 2);
  assert.equal(res.body.run.windows.ndd.start, "2026-11-18 12:00:00");
  assert.equal(res.body.run.source.filename, "o.csv");
  const orders = await request(app).get("/ndd-sla/reports/2026-11-19/orders").set(H).expect(200);
  assert.deepEqual(orders.body.orders.map((o) => o.referenceCode), ["A", "B", "C"], "OLD (previous generation) is never served");
  assert.equal(orders.body.orders[0].isNdd, true);
  assert.equal(orders.body.orders[1].shipmentPickedAt, null);
  assert.equal(orders.body.nextCursor, null);
});

test("not-ready and unknown dates: status is reported, orders are 409, bad input is 400 not 500", async () => {
  const app = buildApp({ config: testConfig(), repo: await seeded() });
  const H = { "x-user-id": "u", "x-brand-id": "AJMAL", "x-role": "viewer", "x-permissions": "ndd_sla_panel" };
  const pending = await request(app).get("/ndd-sla/reports/2026-11-18").set(H).expect(200);
  assert.deepEqual([pending.body.run.ready, pending.body.run.status, pending.body.totals], [false, "SCHEDULED", null]);
  await request(app).get("/ndd-sla/reports/2026-11-18/orders").set(H).expect(409);
  await request(app).get("/ndd-sla/reports/2030-01-01").set(H).expect(404);
  await request(app).get("/ndd-sla/reports/not-a-date").set(H).expect(400);
  await request(app).get("/ndd-sla/reports/2026-11-19/orders?limit=9999").set(H).expect(400);
  await request(app).get("/ndd-sla/reports/2026-11-19/orders?location=NOPE").set(H).expect(400);
  await request(app).get("/ndd-sla/reports/2026-11-19/orders?cursor=%%%").set(H).expect(400);
  const filtered = await request(app).get("/ndd-sla/reports/2026-11-19/orders?location=EMIZA_GGN&limit=1").set(H).expect(200);
  assert.deepEqual(filtered.body.orders.map((o) => o.referenceCode), ["C"]);
});

test("orders pagination returns a cursor only while more rows remain", async () => {
  const app = buildApp({ config: testConfig(), repo: await seeded() });
  const H = { "x-user-id": "u", "x-brand-id": "AJMAL", "x-role": "viewer", "x-permissions": "ndd_sla_panel" };
  const p1 = await request(app).get("/ndd-sla/reports/2026-11-19/orders?limit=2").set(H).expect(200);
  assert.equal(p1.body.orders.length, 2);
  assert.ok(p1.body.nextCursor);
  const p2 = await request(app).get("/ndd-sla/reports/2026-11-19/orders").query({ limit: 2, cursor: p1.body.nextCursor }).set(H).expect(200);
  assert.deepEqual(p2.body.orders.map((o) => o.referenceCode), ["C"]);
  assert.equal(p2.body.nextCursor, null);
});
