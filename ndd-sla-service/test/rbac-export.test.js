const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { buildApp } = require("../src/app");
const { testConfig, fakeRepo } = require("./helpers/fakes");
const { cell } = require("../src/services/csvExport");

const windows = { ndd: { start: "2026-11-18 12:00:00", end: "2026-11-19 12:00:00" }, other: { start: "2026-11-18 15:00:00", end: "2026-11-19 15:00:00" } };
const hdr = (role, permissions, brand = "AJMAL") => ({ "x-user-id": "u", "x-brand-id": brand, "x-role": role, "x-permissions": permissions });
const text = (r, cb) => { let d = ""; r.setEncoding("utf8"); r.on("data", (c) => { d += c; }); r.on("end", () => cb(null, d)); };
const o = (reference, over = {}) => ({ reference, location: "AJMAL_SONS", orderAt: "2026-11-18 13:00:00", orderDate: "2026-11-18", orderHour: 13, courier: "BlitzNDD", isNdd: true, pickedAt: null, sla: "BREACHED", ...over });

async function seeded() {
  const repo = fakeRepo();
  await repo.ensureRun({ brandKey: "AJMAL", reportDate: "2026-11-19", windows });
  await repo.ensureRun({ brandKey: "AJMAL", reportDate: "2026-11-18", windows });
  await repo.ensureRun({ brandKey: "OTHER", reportDate: "2026-11-19", windows });
  const run = repo._runs[0];
  Object.assign(run, { status: "COMPLETED", active_generation: 2, generation: 2 });
  await repo.insertOrders(run.id, 2, [
    o("A", { pickedAt: "2026-11-18 14:00:00", sla: "MET" }),
    o("B", { orderAt: "2026-11-18 16:00:00", orderHour: 16, courier: "Delhivery", isNdd: false }),
    o("C", { location: "EMIZA_GGN", orderAt: "2026-11-19 09:00:00", orderDate: "2026-11-19", orderHour: 9, courier: "Delhivery", isNdd: false }),
  ]);
  await repo.insertSummary(run.id, 2, [
    { location: "AJMAL_SONS", orderDate: "2026-11-18", orderHour: 13, met: 1, breached: 0, total: 1 },
    { location: "AJMAL_SONS", orderDate: "2026-11-18", orderHour: 16, met: 0, breached: 1, total: 1 },
    { location: "EMIZA_GGN", orderDate: "2026-11-19", orderHour: 9, met: 0, breached: 1, total: 1 },
  ]);
  await repo.insertOrders(run.id, 1, [o("OLD")]); // a superseded generation that must never be exported
  return repo;
}

test("RBAC: needs ndd_sla_panel (or all, or an elevated role); other panels' permissions do not help; requeue is author-only", async () => {
  const app = buildApp({ config: testConfig(), repo: await seeded() });
  const url = "/ndd-sla/reports/2026-11-19";
  await request(app).get(url).set(hdr("viewer", "")).expect(403);
  await request(app).get(url).set(hdr("viewer", "pnl_panel,weekly_report_preview,ads_panel")).expect(403);
  for (const path of ["/ndd-sla/runs", `${url}/orders`, `${url}/export`]) await request(app).get(path).set(hdr("viewer", "")).expect(403);
  await request(app).get(url).set(hdr("viewer", "ndd_sla_panel")).expect(200);
  await request(app).get(url).set(hdr("viewer", "overall_snapshot,all")).expect(200);
  await request(app).get(url).set(hdr("author", "")).expect(200);
  await request(app).post(`${url}/requeue`).set(hdr("viewer", "ndd_sla_panel")).expect(403);
  await request(app).post(`${url}/requeue`).set(hdr("viewer", "all")).expect(403);
  await request(app).post("/ndd-sla/reports/2026-11-18/requeue").set(hdr("author", "all")).expect(200);
  await request(app).post("/ndd-sla/reports/2030-01-01/requeue").set(hdr("author", "all")).expect(404);
});

test("requeue: scoped to the caller's brand, refused while locked, and the old snapshot stays served", async () => {
  const repo = await seeded();
  const app = buildApp({ config: testConfig(), repo });
  await request(app).post("/ndd-sla/reports/2026-11-19/requeue").set(hdr("author", "all", "OTHER")).expect(200);
  assert.equal(repo._runs.find((r) => r.brand_key === "AJMAL" && r.report_date === "2026-11-19").status, "COMPLETED", "AJMAL untouched by OTHER");
  repo._runs.find((r) => r.brand_key === "AJMAL" && r.report_date === "2026-11-18").locked_at = Date.now();
  await request(app).post("/ndd-sla/reports/2026-11-18/requeue").set(hdr("author", "all")).expect(409);
  const run = repo._runs.find((r) => r.brand_key === "AJMAL" && r.report_date === "2026-11-19");
  await request(app).post("/ndd-sla/reports/2026-11-19/requeue").set(hdr("author", "all")).expect(200);
  assert.equal(run.status, "SCHEDULED");
  assert.equal(run.active_generation, 2, "the previous successful snapshot stays active until a new one completes");
  const still = await request(app).get("/ndd-sla/reports/2026-11-19/orders").set(hdr("viewer", "ndd_sla_panel")).expect(200);
  assert.equal(still.body.orders.length, 3);
  const view = await request(app).get("/ndd-sla/reports/2026-11-19").set(hdr("viewer", "ndd_sla_panel")).expect(200);
  assert.deepEqual([view.body.run.status, view.body.run.ready, view.body.totals.total], ["SCHEDULED", true, 3]);
});

test("export: streams the persisted active generation as CSV with headers, filters and brand scope", async () => {
  const app = buildApp({ config: testConfig(), repo: await seeded() });
  const H = hdr("viewer", "ndd_sla_panel");
  const get = (path, h = H) => request(app).get(path).set(h).buffer().parse(text);
  const res = await get("/ndd-sla/reports/2026-11-19/export").expect(200);
  assert.match(res.headers["content-type"], /text\/csv/);
  assert.match(res.headers["content-disposition"], /attachment; filename="ndd-sla-orders-2026-11-19\.csv"/);
  assert.equal(res.headers["cache-control"], "no-store");
  const lines = res.body.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines[0], "Reference Code,Client Location,Order Date,Order Hour,Courier Name,NDD,Shipment Picked At,SLA Status,Marketplace");
  assert.equal(lines.length, 4, "header + 3 orders; the old generation is not exported");
  assert.equal(lines[1], "A,AJMAL & SONS,2026-11-18 13:00:00,13,BlitzNDD,Yes,2026-11-18 14:00:00,Met,");
  assert.equal(lines[2], "B,AJMAL & SONS,2026-11-18 16:00:00,16,Delhivery,No,,Breached,", "no pickup is an empty cell, never a date");
  assert.ok(!res.body.includes("OLD") && !res.body.includes("1900"));

  const only = await get("/ndd-sla/reports/2026-11-19/export?sla=BREACHED&location=EMIZA_GGN").expect(200);
  assert.equal(only.body.trim().split("\r\n").length, 2);

  const sum = await get("/ndd-sla/reports/2026-11-19/export?type=summary").expect(200);
  const sl = sum.body.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(sl[0], "Client Location,Order Date,Order Hour,SLA Met,SLA Breached,Total,Met %,Breached %");
  assert.equal(sl[1], "AJMAL & SONS,2026-11-18,13,1,0,1,100,0");

  await get("/ndd-sla/reports/2026-11-18/export").expect(409);
  await get("/ndd-sla/reports/2026-11-19/export", hdr("viewer", "ndd_sla_panel", "OTHER")).expect(409);
  await get("/ndd-sla/reports/2026-11-19/export?type=zip").expect(400);
  await get("/ndd-sla/reports/2030-01-01/export").expect(404);
  await get("/ndd-sla/reports/2026-11-19/export", hdr("viewer", "ndd_sla_panel", "NOBODY")).expect(404);
});

test("export: spreadsheet-formula cells from third-party data are neutralised; quotes and commas are escaped", () => {
  assert.equal(cell('=HYPERLINK("http://x")'), '"\'=HYPERLINK(""http://x"")"');
  assert.equal(cell("+1"), "'+1");
  assert.equal(cell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(cell("-2+3"), "'-2+3");
  assert.equal(cell("a,b"), '"a,b"');
  assert.equal(cell(null), "");
  assert.equal(cell("Delhivery"), "Delhivery");
});

test("export is memory-bounded: a large report is read in pages of at most 1000 rows", async () => {
  const repo = fakeRepo();
  await repo.ensureRun({ brandKey: "AJMAL", reportDate: "2026-11-19", windows });
  Object.assign(repo._runs[0], { status: "COMPLETED", active_generation: 1, generation: 1 });
  await repo.insertOrders(repo._runs[0].id, 1, Array.from({ length: 2500 }, (_, i) => o(`R${String(i).padStart(5, "0")}`)));
  let reads = 0;
  let biggest = 0;
  const realList = repo.listOrders;
  repo.listOrders = async (...a) => { reads += 1; const out = await realList(...a); biggest = Math.max(biggest, out.length); return out; };
  const app = buildApp({ config: testConfig(), repo });
  const res = await request(app).get("/ndd-sla/reports/2026-11-19/export").set(hdr("viewer", "ndd_sla_panel")).buffer().parse(text).expect(200);
  assert.equal(res.body.trim().split("\r\n").length, 2501);
  assert.equal(reads, 3);
  assert.ok(biggest <= 1001);
});
