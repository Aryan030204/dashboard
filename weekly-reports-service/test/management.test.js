// Upload validation, versioning and publish/unpublish/delete state rules.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { makeApp, author, client, validPptx, macroPptx, notAPresentationZip, fakeStorage } = require("./helpers");

const upload = (ctx, buf, name, fields = {}, headers = author("BBB")) => {
  let req = request(ctx.app).post("/weekly-reports").set(headers);
  const f = { title: "BBB Weekly Performance Review", reporting_week: "Week 42", ...fields };
  for (const [k, v] of Object.entries(f)) if (v !== undefined) req = req.field(k, v);
  return buf ? req.attach("file", buf, name) : req;
};

test("a valid pptx is accepted: 202, PROCESSING, saved under the signed brand, audit written", async () => {
  const ctx = makeApp();
  const res = await upload(ctx, validPptx(), "deck.pptx");
  assert.equal(res.status, 202);
  assert.equal(res.body.status, "PROCESSING");
  assert.equal(res.body.brand_key, "BBB");
  assert.equal(res.body.version, 1);
  assert.equal(res.body.source_type, "pptx");
  const stored = [...ctx.storage.objects.keys()][0];
  assert.match(stored, /^BBB\/\d+\/source\/presentation\.pptx$/);
  const actions = ctx.audit.events.map((e) => e.action);
  assert.deepEqual(actions, ["REPORT_UPLOADED"]);
  assert.equal(ctx.repo._reports[0].locked_at, null, "released for the worker once stored");
});

test("the brand always comes from the signed header, not from the form", async () => {
  const ctx = makeApp();
  const res = await upload(ctx, validPptx(), "deck.pptx", {}, author("PTS"));
  assert.equal(res.body.brand_key, "PTS");
});

test("uploading the same week again creates v2 and keeps v1", async () => {
  const ctx = makeApp();
  await upload(ctx, validPptx(), "a.pptx");
  const second = await upload(ctx, validPptx(), "b.pptx");
  assert.equal(second.body.version, 2);
  assert.equal(ctx.repo._reports.length, 2);
  assert.ok(ctx.audit.events.some((e) => e.action === "REPORT_VERSION_CREATED"));
  const other = await upload(ctx, validPptx(), "c.pptx", { reporting_week: "Week 43" });
  assert.equal(other.body.version, 1, "versions are per reporting week");
});

test("rejected files store nothing: wrong type, renamed file, macro, not a presentation, empty, corrupt", async () => {
  const cases = [
    ["notes.docx", Buffer.from("PK\u0003\u0004 a word document"), 415, "UNSUPPORTED_FILE_TYPE"],
    ["deck.pptx", Buffer.from("this is just text, renamed"), 415, "UNSUPPORTED_FILE_TYPE"],
    ["deck.ppt", Buffer.from("this is not an OLE file at all"), 415, "UNSUPPORTED_FILE_TYPE"],
    ["deck.pptx", macroPptx(), 415, "MACRO_ENABLED_NOT_ALLOWED"],
    ["deck.pptm", macroPptx(), 415, "UNSUPPORTED_FILE_TYPE"],
    ["deck.pptx", notAPresentationZip(), 422, "CORRUPT_FILE"],
    ["deck.pptx", Buffer.from("PK\u0003\u0004 truncated garbage"), 422, "CORRUPT_FILE"],
  ];
  for (const [name, buf, status, code] of cases) {
    const ctx = makeApp();
    const res = await upload(ctx, buf, name);
    assert.equal(res.status, status, name);
    assert.equal(res.body.code, code, name);
    assert.equal(ctx.repo._reports.length, 0, `${name}: nothing created`);
    assert.equal(ctx.storage.objects.size, 0, `${name}: nothing stored`);
  }
});

test("a file over the size limit is 413", async () => {
  const ctx = makeApp({ config: { maxUploadBytes: 2048 } });
  const big = Buffer.concat([validPptx(), Buffer.alloc(5000)]);
  const res = await upload(ctx, big, "deck.pptx");
  assert.equal(res.status, 413);
  assert.equal(res.body.code, "FILE_TOO_LARGE");
  assert.equal(ctx.repo._reports.length, 0);
});

test("a zip with too many entries is refused (zip-bomb guard)", async () => {
  const ctx = makeApp({ config: { maxZipEntries: 2 } });
  const res = await upload(ctx, validPptx(), "deck.pptx");
  assert.equal(res.status, 422);
});

test("missing file, title or week are 400 with a readable message", async () => {
  const ctx = makeApp();
  assert.equal((await upload(ctx, null, null)).body.code, "FILE_REQUIRED");
  const noTitle = await upload(ctx, validPptx(), "d.pptx", { title: "" });
  assert.equal(noTitle.status, 400);
  assert.match(noTitle.body.error, /title is required/i);
  const longWeek = await upload(ctx, validPptx(), "d.pptx", { reporting_week: "x".repeat(41) });
  assert.equal(longWeek.status, 400);
});

test("if storing the source fails the report ends FAILED and the caller gets 503", async () => {
  const ctx = makeApp({ storage: fakeStorage({ failPut: true }) });
  const res = await upload(ctx, validPptx(), "deck.pptx");
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "STORAGE_UNAVAILABLE");
  assert.ok(!/s3 down/.test(res.text));
  assert.equal(ctx.repo._reports[0].status, "FAILED");
  assert.equal(ctx.repo._reports[0].error_code, "UPLOAD_FAILED");
});

test("publish: only READY or UNPUBLISHED can be published; PROCESSING and FAILED return 409", async () => {
  const ctx = makeApp();
  for (const status of ["PROCESSING", "FAILED", "PUBLISHED"]) {
    const r = ctx.repo.seed({ brand: "BBB", status, week: `W-${status}` });
    const res = await request(ctx.app).post(`/weekly-reports/${r.id}/publish`).set(author("BBB"));
    assert.equal(res.status, 409, status);
    assert.equal(res.body.code, "INVALID_STATE");
  }
  const ready = ctx.repo.seed({ brand: "BBB", status: "READY", week: "W-ready" });
  const ok = await request(ctx.app).post(`/weekly-reports/${ready.id}/publish`).set(author("BBB"));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, "PUBLISHED");
});

test("publishing leaves every other presentation as it was, and audits only the publish", async () => {
  const ctx = makeApp();
  const a = ctx.repo.seed({ brand: "BBB", status: "PUBLISHED", week: "W1" });
  const other = ctx.repo.seed({ brand: "BBB", status: "PUBLISHED", week: "W0" });
  const b = ctx.repo.seed({ brand: "BBB", status: "READY", week: "W1" });
  await request(ctx.app).post(`/weekly-reports/${b.id}/publish`).set(author("BBB"));
  const status = (id) => ctx.repo._reports.find((r) => r.id === id).status;
  assert.equal(status(a.id), "PUBLISHED", "same week, earlier version: untouched");
  assert.equal(status(other.id), "PUBLISHED");
  assert.equal(status(b.id), "PUBLISHED");
  const actions = ctx.audit.events.map((e) => `${e.action}:${e.reportId}`);
  assert.deepEqual(actions, [`REPORT_PUBLISHED:${b.id}`]);
});

test("publishing in one brand never touches another brand's live report", async () => {
  const ctx = makeApp();
  const pts = ctx.repo.seed({ brand: "PTS", status: "PUBLISHED" });
  const bbb = ctx.repo.seed({ brand: "BBB", status: "READY" });
  await request(ctx.app).post(`/weekly-reports/${bbb.id}/publish`).set(author("BBB"));
  assert.equal(ctx.repo._reports.find((r) => r.id === pts.id).status, "PUBLISHED");
});

test("unpublish hides the report from clients immediately and republish brings it back", async () => {
  const ctx = makeApp();
  const r = ctx.repo.seed({ brand: "BBB", status: "PUBLISHED" });
  const listed = async () => (await request(ctx.app).get("/weekly-reports").set(client("BBB"))).body.reports.map((x) => x.id);
  assert.deepEqual(await listed(), [r.id]);
  assert.equal((await request(ctx.app).post(`/weekly-reports/${r.id}/unpublish`).set(author("BBB"))).status, 200);
  assert.deepEqual(await listed(), []);
  assert.equal((await request(ctx.app).post(`/weekly-reports/${r.id}/unpublish`).set(author("BBB"))).status, 409);
  assert.equal((await request(ctx.app).post(`/weekly-reports/${r.id}/publish`).set(author("BBB"))).status, 200);
});

test("delete: refused while PUBLISHED or PROCESSING, allowed otherwise, and the report disappears", async () => {
  const ctx = makeApp();
  const live = ctx.repo.seed({ brand: "BBB", status: "PUBLISHED", week: "A" });
  const busy = ctx.repo.seed({ brand: "BBB", status: "PROCESSING", week: "B" });
  const old = ctx.repo.seed({ brand: "BBB", status: "UNPUBLISHED", week: "C" });
  assert.equal((await request(ctx.app).delete(`/weekly-reports/${live.id}`).set(author("BBB"))).status, 409);
  assert.equal((await request(ctx.app).delete(`/weekly-reports/${busy.id}`).set(author("BBB"))).status, 409);
  assert.equal((await request(ctx.app).delete(`/weekly-reports/${old.id}`).set(author("BBB"))).status, 204);
  assert.equal((await request(ctx.app).get(`/weekly-reports/${old.id}`).set(author("BBB"))).status, 404);
  const list = await request(ctx.app).get("/weekly-reports").set(author("BBB"));
  assert.ok(!list.body.reports.some((r) => r.id === old.id));
  assert.ok(ctx.audit.events.some((e) => e.action === "REPORT_DELETED" && e.reportId === old.id));
});

test("an elevated user can preview a READY report's slides before publishing", async () => {
  const ctx = makeApp();
  const r = ctx.repo.seed({ brand: "BBB", status: "READY" });
  const res = await request(ctx.app).get(`/weekly-reports/${r.id}/slides/1`).set(author("BBB"));
  assert.equal(res.status, 200);
  const thumb = await request(ctx.app).get(`/weekly-reports/${r.id}/slides/1?size=thumb`).set(author("BBB"));
  assert.match(thumb.body.toString(), /thumbnails/);
});

test("the elevated list shows version history for the current brand only", async () => {
  const ctx = makeApp();
  ctx.repo.seed({ brand: "BBB", week: "W42", status: "UNPUBLISHED" });
  ctx.repo.seed({ brand: "BBB", week: "W42", status: "PUBLISHED" });
  ctx.repo.seed({ brand: "PTS", week: "W42", status: "PUBLISHED" });
  const res = await request(ctx.app).get("/weekly-reports").set(author("BBB"));
  assert.equal(res.body.reports.length, 2);
  assert.ok(res.body.reports.every((r) => r.brand_key === "BBB"));
});
