// Duplicate handling on upload.
//   Same TITLE : warn first; if the admin uploads anyway the server saves it as "Title (1)", "(2)"...
//   Same WEEK  : warn first; if the admin uploads anyway nothing about the title or week changes.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { uniqueTitle } = require("../src/services/uniqueTitle");
const { makeApp, author, client, validPptx } = require("./helpers");

const upload = (ctx, fields = {}, brand = "BBB") =>
  request(ctx.app)
    .post("/weekly-reports")
    .set(author(brand))
    .field("title", fields.title ?? "Weekly Review")
    .field("reporting_week", fields.week ?? "Week 43")
    .attach("file", validPptx(), "deck.pptx");

const check = (ctx, title, week, brand = "BBB") =>
  request(ctx.app).get("/weekly-reports/check").query({ title, reporting_week: week }).set(author(brand));

// ---- the title helper on its own ---------------------------------------------------------------
test("uniqueTitle keeps a free title, otherwise adds (1), (2)... and never exceeds the limit", async () => {
  const taken = new Set(["A", "A (1)", "A (2)"]);
  const isTaken = async (t) => taken.has(t);
  assert.equal(await uniqueTitle(isTaken, "Free"), "Free");
  assert.equal(await uniqueTitle(isTaken, "A"), "A (3)");
  const long = "x".repeat(200);
  const out = await uniqueTitle(async (t) => t === long, long, 200);
  assert.equal(out.length, 200);
  assert.ok(out.endsWith(" (1)"));
});

// ---- the warning check -------------------------------------------------------------------------
test("check: nothing exists yet, so no warnings", async () => {
  const ctx = makeApp();
  const res = await check(ctx, "Weekly Review", "Week 43");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { title_exists: false, suggested_title: "Weekly Review", week_exists: false, week_count: 0 });
});

test("check: an existing title warns and names the title it would be saved as", async () => {
  const ctx = makeApp();
  ctx.repo.seed({ brand: "BBB", title: "Weekly Review", week: "Week 40" });
  ctx.repo.seed({ brand: "BBB", title: "Weekly Review (1)", week: "Week 41" });
  const res = await check(ctx, "weekly review", "Week 43"); // different case still counts
  assert.equal(res.body.title_exists, true);
  assert.equal(res.body.suggested_title, "weekly review (2)");
  assert.equal(res.body.week_exists, false);
});

test("check: an existing week warns with how many presentations it already has", async () => {
  const ctx = makeApp();
  ctx.repo.seed({ brand: "BBB", title: "One", week: "Week 43" });
  ctx.repo.seed({ brand: "BBB", title: "Two", week: "week 43" });
  const res = await check(ctx, "Brand new title", "Week 43");
  assert.equal(res.body.title_exists, false);
  assert.equal(res.body.week_exists, true);
  assert.equal(res.body.week_count, 2);
});

test("check: other brands and deleted presentations never trigger a warning", async () => {
  const ctx = makeApp();
  ctx.repo.seed({ brand: "PTS", title: "Shared Name", week: "Week 43" });
  const gone = ctx.repo.seed({ brand: "BBB", title: "Shared Name", week: "Week 43" });
  gone.deleted_at = new Date();
  const res = await check(ctx, "Shared Name", "Week 43");
  assert.equal(res.body.title_exists, false);
  assert.equal(res.body.week_exists, false);
});

test("check: elevated users only, brand must match, and the inputs are validated", async () => {
  const ctx = makeApp();
  const q = { title: "T", reporting_week: "W" };
  assert.equal((await request(ctx.app).get("/weekly-reports/check").query(q).set(client("BBB"))).status, 403);
  assert.equal((await request(ctx.app).get("/weekly-reports/check").query({ ...q, brand_key: "PTS" }).set(author("BBB"))).status, 400);
  assert.equal((await request(ctx.app).get("/weekly-reports/check").query({ reporting_week: "W" }).set(author("BBB"))).status, 400);
  assert.equal((await request(ctx.app).get("/weekly-reports/check").query({ title: "T" }).set(author("BBB"))).status, 400);
  assert.equal((await request(ctx.app).get("/weekly-reports/check").query(q)).status, 401);
});

// ---- what upload does ------------------------------------------------------------------------
test("upload with a new title and week: saved exactly as typed", async () => {
  const ctx = makeApp();
  const res = await upload(ctx, { title: "Weekly Review", week: "Week 43" });
  assert.equal(res.status, 202);
  assert.equal(res.body.title, "Weekly Review");
  assert.equal(res.body.title_adjusted, false);
});

test("upload with a title that already exists: saved as (1), then (2); the week text is untouched", async () => {
  const ctx = makeApp();
  await upload(ctx, { title: "Weekly Review", week: "Week 43" });
  const second = await upload(ctx, { title: "Weekly Review", week: "Week 44" });
  const third = await upload(ctx, { title: "Weekly Review", week: "Week 45" });
  assert.equal(second.body.title, "Weekly Review (1)");
  assert.equal(second.body.title_adjusted, true);
  assert.equal(second.body.reporting_week, "Week 44");
  assert.equal(third.body.title, "Weekly Review (2)");
  assert.equal(third.body.reporting_week, "Week 45");
});

test("upload into a week that already has a presentation: allowed, title and week stay exactly as typed", async () => {
  const ctx = makeApp();
  await upload(ctx, { title: "First", week: "Week 43" });
  const res = await upload(ctx, { title: "Second", week: "Week 43" });
  assert.equal(res.status, 202);
  assert.equal(res.body.title, "Second");
  assert.equal(res.body.title_adjusted, false);
  assert.equal(res.body.reporting_week, "Week 43");
  assert.equal(res.body.version, 2, "kept as a separate version of the week, nothing replaced");
  assert.equal(ctx.repo._reports.filter((r) => r.reporting_week === "Week 43").length, 2);
});

test("same title AND same week: only the title gets the suffix, the week text is never changed", async () => {
  const ctx = makeApp();
  await upload(ctx, { title: "Weekly Review", week: "Week 43" });
  const res = await upload(ctx, { title: "Weekly Review", week: "Week 43" });
  assert.equal(res.body.title, "Weekly Review (1)");
  assert.equal(res.body.reporting_week, "Week 43");
  assert.equal(res.body.version, 2);
});

test("the same title in another brand is not a duplicate", async () => {
  const ctx = makeApp();
  await upload(ctx, { title: "Weekly Review" }, "BBB");
  const res = await upload(ctx, { title: "Weekly Review" }, "PTS");
  assert.equal(res.body.title, "Weekly Review");
  assert.equal(res.body.title_adjusted, false);
});

test("a deleted presentation frees its title", async () => {
  const ctx = makeApp();
  const first = await upload(ctx, { title: "Weekly Review" });
  ctx.repo._reports.find((r) => r.id === first.body.id).status = "FAILED"; // finished, so it can be deleted
  await request(ctx.app).delete(`/weekly-reports/${first.body.id}`).set(author("BBB"));
  const again = await upload(ctx, { title: "Weekly Review" });
  assert.equal(again.body.title, "Weekly Review");
});

test("the audit record notes the title that was asked for when it had to change", async () => {
  const ctx = makeApp();
  await upload(ctx, { title: "Weekly Review" });
  await upload(ctx, { title: "Weekly Review" });
  const events = ctx.audit.events.filter((e) => e.action === "REPORT_UPLOADED");
  assert.equal(events[0].metadata.requested_title, undefined);
  assert.equal(events[1].metadata.requested_title, "Weekly Review");
});

test("the suffixed title is kept within the 200 character limit", async () => {
  const ctx = makeApp();
  const long = "y".repeat(200);
  await upload(ctx, { title: long });
  const res = await upload(ctx, { title: long });
  assert.equal(res.body.title.length, 200);
  assert.ok(res.body.title.endsWith(" (1)"));
});
