// Brand isolation and permission matrix against the real routes.
// Model: elevated roles manage; a non-admin holding weekly_report_preview can only list and
// preview the PUBLISHED reports of their own brand.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { makeApp, client, author, gatewayHeaders, validPptx, fakeStorage } = require("./helpers");

function setup() {
  const ctx = makeApp();
  const bbb = ctx.repo.seed({ brand: "BBB", status: "PUBLISHED", title: "BBB Weekly" });
  const pts = ctx.repo.seed({ brand: "PTS", status: "PUBLISHED", title: "PTS Weekly" });
  return { ...ctx, bbb, pts };
}

test("T1 a client lists the published reports of its own brand only", async () => {
  const { app, bbb } = setup();
  const res = await request(app).get("/weekly-reports?brand_key=BBB").set(client("BBB"));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.reports.map((r) => r.id), [bbb.id]);
  assert.equal(res.body.reports[0].title, "BBB Weekly");
});

test("a client sees several published weeks, newest first, and never unpublished/processing/failed ones", async () => {
  const ctx = makeApp();
  const w40 = ctx.repo.seed({ brand: "BBB", week: "Week 40", status: "PUBLISHED" });
  const w41 = ctx.repo.seed({ brand: "BBB", week: "Week 41", status: "PUBLISHED" });
  ctx.repo.seed({ brand: "BBB", week: "Week 42", status: "READY" });
  ctx.repo.seed({ brand: "BBB", week: "Week 43", status: "PROCESSING" });
  ctx.repo.seed({ brand: "BBB", week: "Week 44", status: "FAILED" });
  ctx.repo.seed({ brand: "BBB", week: "Week 45", status: "UNPUBLISHED" });
  const res = await request(ctx.app).get("/weekly-reports").set(client("BBB"));
  assert.deepEqual(res.body.reports.map((r) => r.id), [w41.id, w40.id]);
});

test("client responses never expose storage keys, errors, progress, versions or user ids", async () => {
  const { app, bbb } = setup();
  const list = await request(app).get("/weekly-reports").set(client("BBB"));
  const one = await request(app).get(`/weekly-reports/${bbb.id}`).set(client("BBB"));
  for (const body of [list.body.reports[0], one.body]) {
    assert.deepEqual(Object.keys(body).sort(), ["brand_key", "id", "published_at", "reporting_week", "slide_count", "title"]);
  }
});

test("T2 BBB user asking for a PTS report id gets 403 and an audit event", async () => {
  const { app, pts, audit } = setup();
  const res = await request(app).get(`/weekly-reports/${pts.id}`).set(client("BBB"));
  assert.equal(res.status, 403);
  assert.ok(audit.events.some((e) => e.action === "ACCESS_DENIED" && e.reportId === pts.id));
});

test("T3 PTS user asking for a BBB report id gets 403", async () => {
  const { app, bbb } = setup();
  assert.equal((await request(app).get(`/weekly-reports/${bbb.id}`).set(client("PTS"))).status, 403);
});

test("T4 a user without weekly_report_preview is refused on every view endpoint", async () => {
  const { app, bbb } = setup();
  const headers = gatewayHeaders({ brand: "BBB", role: "viewer", permissions: ["daily_funnel_panel"] });
  for (const path of ["/weekly-reports", `/weekly-reports/${bbb.id}`, `/weekly-reports/${bbb.id}/slides/1`]) {
    assert.equal((await request(app).get(path).set(headers)).status, 403, path);
  }
});

test("the old permission name no longer grants access", async () => {
  const { app } = setup();
  const headers = gatewayHeaders({ brand: "BBB", role: "viewer", permissions: ["weekly_reports_panel"] });
  assert.equal((await request(app).get("/weekly-reports").set(headers)).status, 403);
});

test("T5 asking for another brand through the query is rejected", async () => {
  const { app } = setup();
  const res = await request(app).get("/weekly-reports?brand_key=PTS").set(client("BBB"));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "BRAND_MISMATCH");
});

test("T6 an elevated user on brand BBB cannot read a PTS report", async () => {
  const { app, pts } = setup();
  assert.equal((await request(app).get(`/weekly-reports/${pts.id}`).set(author("BBB"))).status, 403);
});

test("T7 changing :id to another brand's id never grants access (view, slides, publish, delete)", async () => {
  const { app, pts } = setup();
  const attempts = [
    request(app).get(`/weekly-reports/${pts.id}/slides/1`).set(client("BBB")),
    request(app).post(`/weekly-reports/${pts.id}/unpublish`).set(author("BBB")),
    request(app).post(`/weekly-reports/${pts.id}/publish`).set(author("BBB")),
    request(app).delete(`/weekly-reports/${pts.id}`).set(author("BBB")),
  ];
  for (const res of await Promise.all(attempts)) assert.equal(res.status, 403);
});

test("T8 a different brand in the body is rejected and nothing is stored", async () => {
  const { app, repo } = setup();
  const before = repo._reports.length;
  const res = await request(app)
    .post("/weekly-reports")
    .set(author("BBB"))
    .field("title", "x").field("reporting_week", "Week 1").field("brand_key", "PTS")
    .attach("file", validPptx(), "deck.pptx");
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "BRAND_MISMATCH");
  assert.equal(repo._reports.length, before);
});

test("T9 a client can preview only: upload, publish, unpublish and delete are all 403, even with the 'all' scope", async () => {
  const { app, bbb } = setup();
  const h = client("BBB");
  const calls = [
    request(app).post("/weekly-reports").set(h).field("title", "x").field("reporting_week", "w").attach("file", validPptx(), "d.pptx"),
    request(app).post(`/weekly-reports/${bbb.id}/publish`).set(h),
    request(app).post(`/weekly-reports/${bbb.id}/unpublish`).set(h),
    request(app).delete(`/weekly-reports/${bbb.id}`).set(h),
  ];
  for (const res of await Promise.all(calls)) assert.equal(res.status, 403);
  const allPerm = gatewayHeaders({ brand: "BBB", role: "viewer", permissions: ["all"] });
  assert.equal((await request(app).post(`/weekly-reports/${bbb.id}/unpublish`).set(allPerm)).status, 403);
  assert.equal((await request(app).delete(`/weekly-reports/${bbb.id}`).set(allPerm)).status, 403);
});

test("T10 a client gets 404 for non-published reports of its own brand (READY, FAILED, PROCESSING, UNPUBLISHED)", async () => {
  const { app, repo } = setup();
  for (const status of ["READY", "FAILED", "PROCESSING", "UNPUBLISHED"]) {
    const r = repo.seed({ brand: "BBB", status, week: `Week ${status}` });
    assert.equal((await request(app).get(`/weekly-reports/${r.id}`).set(client("BBB"))).status, 404, status);
    assert.equal((await request(app).get(`/weekly-reports/${r.id}/slides/1`).set(client("BBB"))).status, 404, status);
  }
});

test("T11 slide number out of range is 404", async () => {
  const { app, bbb } = setup();
  for (const n of [0, -1, 4, 99, "abc", "1.5"]) {
    assert.equal((await request(app).get(`/weekly-reports/${bbb.id}/slides/${n}`).set(client("BBB"))).status, 404, String(n));
  }
});

test("T12 requests without a valid gateway signature are 401", async () => {
  const { app } = setup();
  assert.equal((await request(app).get("/weekly-reports")).status, 401);
  assert.equal((await request(app).get("/weekly-reports").set(client("BBB", { sig: "deadbeef" }))).status, 401);
  assert.equal((await request(app).get("/weekly-reports").set(client("BBB", { secret: "wrong-secret" }))).status, 401);
  const stale = gatewayHeaders({ brand: "BBB", role: "viewer", permissions: ["weekly_report_preview"], ts: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal((await request(app).get("/weekly-reports").set(stale)).status, 401);
});

test("T12b with no shared secret configured every request is refused (fail closed)", async () => {
  const { app } = makeApp({ config: { gatewaySharedSecret: "", allowInsecureAuth: false } });
  assert.equal((await request(app).get("/weekly-reports").set(client("BBB"))).status, 401);
});

test("T13 no response body contains a storage key, bucket or s3 url", async () => {
  const { app, bbb } = setup();
  const bodies = [
    (await request(app).get("/weekly-reports").set(client("BBB"))).text,
    (await request(app).get(`/weekly-reports/${bbb.id}`).set(client("BBB"))).text,
    (await request(app).get("/weekly-reports").set(author("BBB"))).text,
    (await request(app).get(`/weekly-reports/${bbb.id}`).set(author("BBB"))).text,
  ];
  for (const text of bodies) assert.ok(!/source_storage_key|s3\.amazonaws|presentation\.pptx|\/source\//i.test(text), text);
});

test("T14 publishing never unpublishes anything: several presentations, even of the same week, can be live together", async () => {
  const { app, repo } = makeApp();
  const other = repo.seed({ brand: "BBB", week: "Week 49", status: "PUBLISHED" });
  const v1 = repo.seed({ brand: "BBB", week: "Week 50", status: "READY" });
  const v2 = repo.seed({ brand: "BBB", week: "Week 50", status: "READY" });
  assert.equal((await request(app).post(`/weekly-reports/${v1.id}/publish`).set(author("BBB"))).status, 200);
  assert.equal((await request(app).post(`/weekly-reports/${v2.id}/publish`).set(author("BBB"))).status, 200);

  const ids = (await request(app).get("/weekly-reports").set(client("BBB"))).body.reports.map((r) => r.id);
  assert.deepEqual(ids.slice().sort(), [other.id, v1.id, v2.id].sort(), "all three are visible to the client");

  // The admin decides what stays: unpublish one, the others remain.
  assert.equal((await request(app).post(`/weekly-reports/${v1.id}/unpublish`).set(author("BBB"))).status, 200);
  const after = (await request(app).get("/weekly-reports").set(client("BBB"))).body.reports.map((r) => r.id);
  assert.deepEqual(after.slice().sort(), [other.id, v2.id].sort());
  assert.equal((await request(app).get(`/weekly-reports/${v1.id}`).set(client("BBB"))).status, 404);
});

test("an elevated user's list includes every status and the processing progress", async () => {
  const ctx = makeApp();
  const r = ctx.repo.seed({ brand: "BBB", status: "PROCESSING", week: "W1" });
  await ctx.repo.setProgress(r.id, { stage: "SAVING_SLIDES", slidesTotal: 15, slidesDone: 7 });
  ctx.repo.seed({ brand: "BBB", status: "READY", week: "W2" });
  const res = await request(ctx.app).get("/weekly-reports").set(author("BBB"));
  assert.equal(res.body.reports.length, 2);
  const processing = res.body.reports.find((x) => x.id === r.id);
  assert.deepEqual([processing.stage, processing.slides_total, processing.slides_done], ["SAVING_SLIDES", 15, 7]);
});

test("the removed /latest route is not a way in (it is treated as an invalid id)", async () => {
  const { app } = setup();
  assert.equal((await request(app).get("/weekly-reports/latest").set(client("BBB"))).status, 400);
});

test("CROSS_BRAND_STATUS=404 hides that the other brand's report exists", async () => {
  const ctx = makeApp({ config: { crossBrandStatus: 404 } });
  const pts = ctx.repo.seed({ brand: "PTS", status: "PUBLISHED" });
  assert.equal((await request(ctx.app).get(`/weekly-reports/${pts.id}`).set(client("BBB"))).status, 404);
});

test("invalid ids are rejected before any lookup", async () => {
  const { app } = setup();
  for (const id of ["abc", "1;DROP", "0x10", "99999999999999999999"]) {
    assert.equal((await request(app).get(`/weekly-reports/${id}`).set(client("BBB"))).status, 400, id);
  }
});

test("slides are served inline and private, exactly as stored, with no storage URL", async () => {
  const { app, bbb } = setup();
  const res = await request(app).get(`/weekly-reports/${bbb.id}/slides/2`).set(client("BBB", { email: "ceo@bbb.com" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "image/webp");
  assert.match(res.headers["cache-control"], /private/);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["content-disposition"], "inline");
  assert.equal(res.body.toString(), `image:${bbb.brand_key}/${bbb.id}/slides/2.webp`);
});

test("the slide cache never bypasses authorization: another brand's user still gets 403 for a cached slide", async () => {
  const { app, bbb } = setup();
  assert.equal((await request(app).get(`/weekly-reports/${bbb.id}/slides/1`).set(client("BBB"))).status, 200);
  assert.equal((await request(app).get(`/weekly-reports/${bbb.id}/slides/1`).set(client("PTS"))).status, 403);
  assert.equal((await request(app).get(`/weekly-reports/${bbb.id}/slides/1`)).status, 401);
});

test("a missing slide object is a 404 for that slide only, other storage errors are 503", async () => {
  const ctx = makeApp();
  const r = ctx.repo.seed({ brand: "BBB", status: "PUBLISHED", slideCount: 1 });
  const slide = await ctx.repo.getSlide(r.id, 1);
  slide.image_storage_key = "missing/key";
  assert.equal((await request(ctx.app).get(`/weekly-reports/${r.id}/slides/1`).set(client("BBB"))).status, 404);

  const broken = makeApp({ storage: { ...fakeStorage(), getBuffer: async () => { throw new Error("boom"); } } });
  const r2 = broken.repo.seed({ brand: "BBB", status: "PUBLISHED", slideCount: 1 });
  const res = await request(broken.app).get(`/weekly-reports/${r2.id}/slides/1`).set(client("BBB"));
  assert.equal(res.status, 503);
  assert.ok(!/boom/.test(res.text), "internal error text must not leak");
});

test("an unexpected error returns a generic 500 with no internals", async () => {
  const ctx = makeApp();
  ctx.repo.listByBrand = async () => { throw new Error("SELECT * FROM secret_table failed at /srv/app"); };
  const res = await request(ctx.app).get("/weekly-reports").set(client("BBB"));
  assert.equal(res.status, 500);
  assert.ok(!/secret_table|\/srv/.test(res.text));
});
