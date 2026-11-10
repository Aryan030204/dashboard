// The optional description (about 100 words) is author-only: stored on upload, editable by authors,
// and never present in anything a client can read.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { makeApp, author, client, validPptx } = require("./helpers");

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

function upload(ctx, fields = {}, headers = author("BBB")) {
  const req = request(ctx.app).post("/weekly-reports").set(headers)
    .attach("file", validPptx(), "deck.pptx")
    .field("title", fields.title ?? "Weekly Review")
    .field("reporting_week", fields.week ?? "43");
  if (fields.description !== undefined) req.field("description", fields.description);
  return req;
}

test("an author upload stores the description and the author view returns it", async () => {
  const ctx = makeApp();
  const res = await upload(ctx, { description: "  Strong week for bundles.  " });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.equal(res.body.description, "Strong week for bundles.");
  const list = await request(ctx.app).get("/weekly-reports").set(author("BBB"));
  assert.equal(list.body.reports[0].description, "Strong week for bundles.");
});

test("the description is optional: omitted or blank is stored as null", async () => {
  const ctx = makeApp();
  const none = await upload(ctx, { title: "A" });
  assert.equal(none.status, 202);
  assert.equal(none.body.description, null);
  const blank = await upload(ctx, { title: "B", description: "   " });
  assert.equal(blank.status, 202);
  assert.equal(blank.body.description, null);
});

test("exactly 100 words is accepted, 101 is rejected", async () => {
  const ctx = makeApp();
  assert.equal((await upload(ctx, { title: "A", description: words(100) })).status, 202);
  const over = await upload(ctx, { title: "B", description: words(101) });
  assert.equal(over.status, 400);
  assert.equal(ctx.repo._reports.length, 1, "a rejected description must not create a report");
});

test("clients (preview permission) never receive the description, in the list or by id", async () => {
  const ctx = makeApp();
  const row = ctx.repo.seed({ brand: "BBB", status: "PUBLISHED", description: "internal note" });
  const list = await request(ctx.app).get("/weekly-reports").set(client("BBB"));
  assert.equal(list.status, 200);
  assert.equal(list.body.reports.length, 1);
  assert.equal("description" in list.body.reports[0], false);
  const one = await request(ctx.app).get(`/weekly-reports/${row.id}`).set(client("BBB"));
  assert.equal(one.status, 200);
  assert.equal("description" in one.body, false);
  assert.ok(!JSON.stringify([list.body, one.body]).includes("internal note"));
});

test("a client cannot upload with a description or edit one", async () => {
  const ctx = makeApp();
  const row = ctx.repo.seed({ brand: "BBB", status: "PUBLISHED" });
  assert.equal((await upload(ctx, { description: "x" }, client("BBB"))).status, 403);
  const edit = await request(ctx.app).post(`/weekly-reports/${row.id}/description`).set(client("BBB")).send({ description: "x" });
  assert.equal(edit.status, 403);
  assert.equal(row.description, null);
});

test("an author can set, change and clear the description", async () => {
  const ctx = makeApp();
  const row = ctx.repo.seed({ brand: "BBB", status: "READY" });
  const post = (description) => request(ctx.app).post(`/weekly-reports/${row.id}/description`).set(author("BBB")).send({ description });

  const set = await post("First note");
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.description, "First note");
  assert.equal((await post("Changed")).body.description, "Changed");
  assert.equal((await post("")).body.description, null);
  assert.equal(ctx.audit.events.filter((e) => e.action === "REPORT_DESCRIPTION_UPDATED").length, 3);
});

test("editing validates the word limit and requires the field", async () => {
  const ctx = makeApp();
  const row = ctx.repo.seed({ brand: "BBB", status: "READY" });
  const url = `/weekly-reports/${row.id}/description`;
  assert.equal((await request(ctx.app).post(url).set(author("BBB")).send({ description: words(101) })).status, 400);
  assert.equal((await request(ctx.app).post(url).set(author("BBB")).send({})).status, 400);
  assert.equal(row.description, null);
});

test("an author of another brand cannot edit this brand's description", async () => {
  const ctx = makeApp();
  const row = ctx.repo.seed({ brand: "BBB", status: "READY", description: "keep" });
  const res = await request(ctx.app).post(`/weekly-reports/${row.id}/description`).set(author("PTS")).send({ description: "hijack" });
  assert.ok([403, 404].includes(res.status), `status ${res.status}`);
  assert.equal(row.description, "keep");
});

test("editing an unknown report is a 404", async () => {
  const ctx = makeApp();
  const res = await request(ctx.app).post("/weekly-reports/9999/description").set(author("BBB")).send({ description: "x" });
  assert.equal(res.status, 404);
});

test("chunked upload carries the description through to the report", async () => {
  const ctx = makeApp();
  const file = validPptx();
  const begin = await request(ctx.app).post("/weekly-reports/uploads").set(author("BBB"))
    .send({ filename: "d.pptx", size: file.length, title: "Chunked", reporting_week: "44", description: "From chunks" });
  assert.equal(begin.status, 201, JSON.stringify(begin.body));
  const size = begin.body.chunk_size;
  for (let i = 0; i < begin.body.total_chunks; i += 1) {
    const res = await request(ctx.app).put(`/weekly-reports/uploads/${begin.body.upload_id}/chunks/${i}`)
      .set(author("BBB")).set("Content-Type", "application/octet-stream").send(file.subarray(i * size, (i + 1) * size));
    assert.equal(res.status, 200);
  }
  const done = await request(ctx.app).post(`/weekly-reports/uploads/${begin.body.upload_id}/complete`).set(author("BBB"));
  assert.equal(done.status, 202, JSON.stringify(done.body));
  assert.equal(done.body.description, "From chunks");

  const tooLong = await request(ctx.app).post("/weekly-reports/uploads").set(author("BBB"))
    .send({ filename: "d.pptx", size: 10, title: "T", reporting_week: "1", description: words(101) });
  assert.equal(tooLong.status, 400);
});
