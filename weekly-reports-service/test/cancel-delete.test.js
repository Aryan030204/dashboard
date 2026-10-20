// Delete removes the files from S3; cancel stops a job that is still processing and removes
// everything: the record, a running conversion, and every file already written to S3.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { buildPurger } = require("../src/services/purger");
const { makeApp, author, client, fakeStorage } = require("./helpers");

test("delete also removes the report's files from S3 and records that", async () => {
  const ctx = makeApp();
  const r = ctx.repo.seed({ brand: "BBB", status: "UNPUBLISHED", week: "D1" });
  ctx.storage.objects.set(`BBB/${r.id}/source/presentation.pptx`, Buffer.from("x"));
  ctx.storage.objects.set(`BBB/${r.id}/slides/001.webp`, Buffer.from("x"));
  ctx.storage.objects.set("BBB/999/slides/001.webp", Buffer.from("another report"));

  assert.equal((await request(ctx.app).delete(`/weekly-reports/${r.id}`).set(author("BBB"))).status, 204);
  assert.deepEqual(ctx.storage.state.removedPrefixes, [`BBB/${r.id}/`]);
  assert.equal(ctx.storage.objects.has(`BBB/${r.id}/source/presentation.pptx`), false);
  assert.equal(ctx.storage.objects.has(`BBB/${r.id}/slides/001.webp`), false);
  assert.equal(ctx.storage.objects.has("BBB/999/slides/001.webp"), true, "another report's files are untouched");
  assert.ok(ctx.repo._reports.find((x) => x.id === r.id).storage_purged_at, "marked as purged");
  assert.equal(ctx.audit.events.find((e) => e.action === "REPORT_DELETED").metadata.files_removed, true);
});

test("if S3 cannot delete the files the report is still deleted, and the cleanup sweep finishes the job later", async () => {
  const ctx = makeApp({ storage: fakeStorage({ failRemove: true }) });
  const r = ctx.repo.seed({ brand: "BBB", status: "FAILED", week: "D2" });
  const res = await request(ctx.app).delete(`/weekly-reports/${r.id}`).set(author("BBB"));
  assert.equal(res.status, 204);
  assert.ok(!/s3 delete failed/.test(res.text), "internal error text must not leak");
  assert.equal(ctx.repo._reports.find((x) => x.id === r.id).storage_purged_at, null, "not marked as purged");
  assert.equal(ctx.audit.events.find((e) => e.action === "REPORT_DELETED").metadata.files_removed, false);

  // S3 comes back: the worker's sweep removes the files and marks them purged.
  ctx.storage.state.failRemove = false;
  const purger = buildPurger({ repo: ctx.repo, storage: ctx.storage });
  assert.deepEqual(await purger.sweep(), { found: 1, purged: 1 });
  assert.ok(ctx.repo._reports.find((x) => x.id === r.id).storage_purged_at);
  assert.deepEqual(await purger.sweep(), { found: 0, purged: 0 }, "nothing left to do");
});

test("the sweep also cleans up reports that were deleted before this feature existed", async () => {
  const ctx = makeApp();
  const old = ctx.repo.seed({ brand: "BBB", status: "READY", week: "Old" });
  ctx.repo._reports.find((x) => x.id === old.id).deleted_at = new Date(); // deleted earlier, files left behind
  ctx.storage.objects.set(`BBB/${old.id}/slides/001.webp`, Buffer.from("x"));
  const purger = buildPurger({ repo: ctx.repo, storage: ctx.storage });
  assert.deepEqual(await purger.sweep(), { found: 1, purged: 1 });
  assert.equal(ctx.storage.objects.size, 0);
});

test("cancel on a queued upload: gone from the list at once and its files are deleted", async () => {
  const ctx = makeApp();
  const queued = ctx.repo.seed({ brand: "BBB", status: "PROCESSING", week: "C1" });
  ctx.repo._reports.find((x) => x.id === queued.id).locked_at = null; // not claimed by a worker
  ctx.storage.objects.set(`BBB/${queued.id}/source/presentation.pptx`, Buffer.from("x"));

  const res = await request(ctx.app).post(`/weekly-reports/${queued.id}/cancel`).set(author("BBB"));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { cancelled: true, files_removed: true });
  assert.equal(ctx.storage.objects.size, 0);
  const list = await request(ctx.app).get("/weekly-reports").set(author("BBB"));
  assert.ok(!list.body.reports.some((x) => x.id === queued.id));
  assert.ok(ctx.audit.events.some((e) => e.action === "REPORT_CANCELLED" && e.reportId === queued.id));
});

test("cancel while a worker is converting: hidden at once, files removed only after the worker lets go", async () => {
  const ctx = makeApp();
  const busy = ctx.repo.seed({ brand: "BBB", status: "PROCESSING", week: "C2" });
  Object.assign(ctx.repo._reports.find((x) => x.id === busy.id), { locked_at: new Date(), locked_by: "worker-1" });
  ctx.storage.objects.set(`BBB/${busy.id}/slides/001.webp`, Buffer.from("x"));

  const res = await request(ctx.app).post(`/weekly-reports/${busy.id}/cancel`).set(author("BBB"));
  assert.deepEqual(res.body, { cancelled: true, files_removed: false });
  assert.equal(ctx.storage.objects.size, 1, "files stay while the worker could still write more");
  const purger = buildPurger({ repo: ctx.repo, storage: ctx.storage });
  assert.deepEqual(await purger.sweep(), { found: 0, purged: 0 }, "the sweep leaves a report a worker still holds");

  await ctx.repo.releaseLock(busy.id); // the worker noticed the cancellation and stopped
  assert.deepEqual(await purger.sweep(), { found: 1, purged: 1 });
  assert.equal(ctx.storage.objects.size, 0);
});

test("cancel is only for reports that are still processing", async () => {
  const ctx = makeApp();
  for (const status of ["READY", "PUBLISHED", "UNPUBLISHED", "FAILED"]) {
    const r = ctx.repo.seed({ brand: "BBB", status, week: `C-${status}` });
    const res = await request(ctx.app).post(`/weekly-reports/${r.id}/cancel`).set(author("BBB"));
    assert.equal(res.status, 409, status);
    assert.equal(res.body.code, "INVALID_STATE");
  }
});

test("a client cannot cancel, and nobody can cancel another brand's report", async () => {
  const ctx = makeApp();
  const mine = ctx.repo.seed({ brand: "BBB", status: "PROCESSING", week: "C3" });
  const theirs = ctx.repo.seed({ brand: "PTS", status: "PROCESSING", week: "C3" });
  assert.equal((await request(ctx.app).post(`/weekly-reports/${mine.id}/cancel`).set(client("BBB"))).status, 403);
  assert.equal((await request(ctx.app).post(`/weekly-reports/${theirs.id}/cancel`).set(author("BBB"))).status, 403);
  assert.equal(ctx.repo._reports.find((x) => x.id === theirs.id).deleted_at, null, "the other brand's report is untouched");
});

test("a report that is deleted or cancelled can never be reached again", async () => {
  const ctx = makeApp();
  const r = ctx.repo.seed({ brand: "BBB", status: "PROCESSING", week: "C4" });
  ctx.repo._reports.find((x) => x.id === r.id).locked_at = null;
  await request(ctx.app).post(`/weekly-reports/${r.id}/cancel`).set(author("BBB"));
  assert.equal((await request(ctx.app).get(`/weekly-reports/${r.id}`).set(author("BBB"))).status, 404);
  assert.equal((await request(ctx.app).post(`/weekly-reports/${r.id}/cancel`).set(author("BBB"))).status, 404);
  assert.equal((await request(ctx.app).post(`/weekly-reports/${r.id}/publish`).set(author("BBB"))).status, 404);
});

test("the S3 prefix guard refuses anything that is not exactly <brand>/<id>/", async () => {
  // Real storage object: needs no AWS call to validate a prefix.
  const { buildStorage } = require("../src/services/storage");
  const storage = buildStorage({ bucket: "test", region: "ap-south-1" });
  assert.equal(storage.reportPrefix("BBB", 12), "BBB/12/");
  assert.equal(storage.reportPrefix("URBAN HINDU", 3), "URBAN HINDU/3/");
  for (const [brand, id] of [["", 1], ["BBB", 0], ["BBB", -1], ["BBB", "x"], ["../x", 1], ["A/B", 1], [null, 1]]) {
    assert.throws(() => storage.reportPrefix(brand, id), /invalid report storage prefix/, `${brand}/${id}`);
  }
  for (const bad of ["", "/", "BBB/", "BBB/12", "BBB/x/", "BBB/12/slides/", "../1/", "BBB/../1/"]) {
    await assert.rejects(storage.removePrefix(bad), /refusing to delete/, bad);
  }
});
