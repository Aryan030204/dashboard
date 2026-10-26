// Exercises the real SQL against a MySQL 8 server. Skipped unless WR_TEST_DB_HOST is set, e.g.:
//   docker run -d --name wr-mysql -e MYSQL_ROOT_PASSWORD=pw -e MYSQL_DATABASE=wr -p 33310:3306 mysql:8
//   WR_TEST_DB_HOST=127.0.0.1 WR_TEST_DB_PORT=33310 WR_TEST_DB_USER=root WR_TEST_DB_PASSWORD=pw WR_TEST_DB_NAME=wr npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { buildReportsRepo } = require("../src/services/reportsRepo");

const env = process.env;
const enabled = Boolean(env.WR_TEST_DB_HOST);
const opts = { skip: enabled ? false : "set WR_TEST_DB_HOST to run the MySQL tests" };

let pool;
let repo;

test("setup: apply the real migration", opts, async () => {
  pool = mysql.createPool({
    host: env.WR_TEST_DB_HOST, port: Number(env.WR_TEST_DB_PORT || 3306), user: env.WR_TEST_DB_USER,
    password: env.WR_TEST_DB_PASSWORD, database: env.WR_TEST_DB_NAME, multipleStatements: true, timezone: "Z",
  });
  await pool.query("DROP TABLE IF EXISTS weekly_report_events, weekly_report_slides, weekly_reports");
  for (const file of ["001-create-weekly-reports.sql", "002-add-progress-columns.sql", "003-add-storage-purge.sql", "004-allow-pdf-source.sql"]) {
    await pool.query(fs.readFileSync(path.join(__dirname, "..", "migrations", file), "utf8"));
  }
  repo = buildReportsRepo(pool);
});

async function newReport(brand, week = "Week 1") {
  const { id, version } = await repo.createReport({ brandKey: brand, title: "T", reportingWeek: week, sourceType: "pptx", uploadedBy: "u1" });
  await repo.releaseForProcessing(id, brand, { sourceKey: `${brand}/${id}/source/presentation.pptx`, sizeBytes: 10, sha256: "a".repeat(64) });
  return { id, version };
}
async function makeReady(id, slides = 2) {
  await repo.complete(id, Array.from({ length: slides }, (_, i) => ({ number: i + 1, imageKey: `k/${id}/${i + 1}`, thumbKey: `t/${id}/${i + 1}`, width: 10, height: 5 })));
}

test("versions count up per brand and week, even under concurrent uploads", opts, async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => repo.createReport({ brandKey: "BBB", title: "T", reportingWeek: "Race", sourceType: "pptx", uploadedBy: "u" })));
  const versions = results.map((r) => r.version).sort((a, b) => a - b);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6]);
  const other = await repo.createReport({ brandKey: "PTS", title: "T", reportingWeek: "Race", sourceType: "pptx", uploadedBy: "u" });
  assert.equal(other.version, 1);
});

test("a row stays unclaimable until the source is stored, then exactly one worker claims it", opts, async () => {
  await pool.query("DELETE FROM weekly_reports");
  const { id } = await repo.createReport({ brandKey: "BBB", title: "T", reportingWeek: "W", sourceType: "pptx", uploadedBy: "u" });
  assert.equal(await repo.claimNext("w1"), null, "still uploading: not claimable");
  await repo.releaseForProcessing(id, "BBB", { sourceKey: "BBB/x", sizeBytes: 1, sha256: "b".repeat(64) });
  const [a, b] = await Promise.all([repo.claimNext("w1"), repo.claimNext("w2")]);
  assert.equal([a, b].filter(Boolean).length, 1, "SKIP LOCKED: only one worker gets the job");
  assert.equal((a || b).id, id);
  assert.equal(await repo.claimNext("w3"), null);
});

test("complete stores slides and sets READY; getSlide returns keys", opts, async () => {
  const { id } = await newReport("BBB", "Complete");
  await repo.claimNext("w");
  await makeReady(id, 3);
  const r = await repo.findById(id);
  assert.equal(r.status, "READY");
  assert.equal(r.slide_count, 3);
  assert.equal((await repo.getSlide(id, 2)).image_storage_key, `k/${id}/2`);
  assert.equal(await repo.getSlide(id, 4), null);
});

test("publish changes only the target: many presentations can be published together, per brand", opts, async () => {
  await pool.query("DELETE FROM weekly_reports");
  const w1v1 = await newReport("BBB", "Week 1"); await makeReady(w1v1.id);
  const w1v2 = await newReport("BBB", "Week 1"); await makeReady(w1v2.id);
  const w2 = await newReport("BBB", "Week 2"); await makeReady(w2.id);
  const pts = await newReport("PTS", "Week 1"); await makeReady(pts.id);
  for (const r of [pts]) await repo.publish(r.id, "PTS", "u");
  for (const r of [w1v1, w1v2, w2]) await repo.publish(r.id, "BBB", "u");
  const published = await repo.listByBrand("BBB", { publishedOnly: true });
  assert.deepEqual(published.map((r) => r.id).sort(), [w1v1.id, w1v2.id, w2.id].sort());
  assert.ok(published.every((r) => r.status === "PUBLISHED"));
  assert.equal((await repo.findById(pts.id)).status, "PUBLISHED", "other brand untouched");
  await repo.unpublish(w1v1.id, "BBB");
  assert.equal((await repo.listByBrand("BBB", { publishedOnly: true })).length, 2);
  assert.equal((await repo.listByBrand("BBB")).length, 3, "elevated list includes unpublished versions");
});

test("progress columns: queued on release, converting on claim, counts while saving, cleared on complete", opts, async () => {
  await pool.query("DELETE FROM weekly_reports");
  const { id } = await newReport("BBB", "Progress");
  assert.equal((await repo.findById(id)).stage, "QUEUED");
  await repo.claimNext("w");
  assert.equal((await repo.findById(id)).stage, "CONVERTING");
  await repo.setProgress(id, { stage: "SAVING_SLIDES", slidesTotal: 15, slidesDone: 7 });
  const mid = await repo.findById(id);
  assert.deepEqual([mid.stage, mid.slides_total, mid.slides_done], ["SAVING_SLIDES", 15, 7]);
  await makeReady(id, 15);
  const done = await repo.findById(id);
  assert.deepEqual([done.status, done.stage, done.slides_total, done.slides_done], ["READY", null, 15, 15]);
  await repo.setProgress(id, { stage: "SAVING_SLIDES", slidesTotal: 1, slidesDone: 0 });
  assert.equal((await repo.findById(id)).slides_total, 15, "progress is ignored once the report is not processing");
});

test("publish, unpublish and delete refuse the wrong brand and the wrong state", opts, async () => {
  await pool.query("DELETE FROM weekly_reports");
  const a = await newReport("BBB", "S1"); await makeReady(a.id);
  await assert.rejects(repo.publish(a.id, "PTS", "u"), (e) => e.status === 404);
  await assert.rejects(repo.unpublish(a.id, "BBB"), (e) => e.status === 409);
  await repo.publish(a.id, "BBB", "u");
  await assert.rejects(repo.softDelete(a.id, "BBB"), (e) => e.status === 409, "cannot delete a live report");
  await assert.rejects(repo.softDelete(a.id, "PTS"), (e) => e.status === 409);
  await repo.unpublish(a.id, "BBB");
  await repo.softDelete(a.id, "BBB");
  assert.equal(await repo.findById(a.id), null);
  assert.equal(await repo.isDeleted(a.id), true);
});

test("PROCESSING and FAILED rows cannot be published", opts, async () => {
  await pool.query("DELETE FROM weekly_reports");
  const p = await newReport("BBB", "X1");
  await assert.rejects(repo.publish(p.id, "BBB", "u"), (e) => e.status === 409);
  await repo.markFailed(p.id, "CONVERSION_FAILED", "nope");
  assert.equal((await repo.findById(p.id)).status, "FAILED");
  await assert.rejects(repo.publish(p.id, "BBB", "u"), (e) => e.status === 409);
});

test("failStale fails reports locked past the timeout and leaves fresh ones alone", opts, async () => {
  await pool.query("DELETE FROM weekly_reports");
  const old = await repo.createReport({ brandKey: "BBB", title: "T", reportingWeek: "Old", sourceType: "pptx", uploadedBy: "u" });
  const fresh = await repo.createReport({ brandKey: "BBB", title: "T", reportingWeek: "Fresh", sourceType: "pptx", uploadedBy: "u" });
  await pool.query("UPDATE weekly_reports SET locked_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE id = ?", [old.id]);
  assert.equal(await repo.failStale(10 * 60 * 1000), 1);
  assert.equal((await repo.findById(old.id)).status, "FAILED");
  assert.equal((await repo.findById(old.id)).error_code, "PROCESSING_TIMEOUT");
  assert.equal((await repo.findById(fresh.id)).status, "PROCESSING");
});

test("cancel hides a processing report; files can be purged now only if nothing holds it", opts, async () => {
  await pool.query("DELETE FROM weekly_reports");
  const queued = await newReport("BBB", "Cancel queued"); // released, not claimed
  const held = await newReport("BBB", "Cancel held");
  const claimed = await repo.claimNext("worker-1");
  assert.equal(claimed.id, queued.id, "oldest job is claimed first");

  assert.deepEqual(await repo.cancel(held.id, "BBB"), { purgeNow: true }, "not claimed: files can go now");
  assert.deepEqual(await repo.cancel(queued.id, "BBB"), { purgeNow: false }, "held by a worker: wait");
  assert.equal(await repo.findById(held.id), null);
  assert.equal(await repo.findById(queued.id), null);
});

test("cancel refuses other brands, finished reports and already-cancelled reports", opts, async () => {
  await pool.query("DELETE FROM weekly_reports");
  const proc = await newReport("BBB", "Cancel rules");
  await assert.rejects(repo.cancel(proc.id, "PTS"), (e) => e.status === 404, "other brand");
  const done = await newReport("BBB", "Cancel done"); await makeReady(done.id);
  await assert.rejects(repo.cancel(done.id, "BBB"), (e) => e.status === 409, "not processing");
  await repo.cancel(proc.id, "BBB");
  await assert.rejects(repo.cancel(proc.id, "BBB"), (e) => e.status === 404, "already cancelled");
});

test("a cancelled report is never claimed by a worker", opts, async () => {
  await pool.query("DELETE FROM weekly_reports");
  const a = await newReport("BBB", "Never claimed");
  await repo.cancel(a.id, "BBB");
  assert.equal(await repo.claimNext("w"), null);
});

test("purge queue: deleted/cancelled reports with files left, skipping any a worker still holds", opts, async () => {
  await pool.query("DELETE FROM weekly_reports");
  const gone = await newReport("BBB", "Purge a"); await makeReady(gone.id);
  await repo.softDelete(gone.id, "BBB");
  const cancelledHeld = await newReport("BBB", "Purge b");
  await repo.claimNext("w1"); // a worker picks up cancelledHeld (the only report still processing)
  await repo.cancel(cancelledHeld.id, "BBB");

  assert.deepEqual((await repo.claimPurgeBatch(10)).map((r) => r.id), [gone.id], "held report is not offered yet");
  await repo.releaseLock(cancelledHeld.id);
  assert.deepEqual((await repo.claimPurgeBatch(10)).map((r) => r.id).sort(), [gone.id, cancelledHeld.id].sort());

  await repo.markPurged(gone.id);
  assert.deepEqual((await repo.claimPurgeBatch(10)).map((r) => r.id), [cancelledHeld.id]);
  await repo.markPurged(cancelledHeld.id);
  assert.deepEqual(await repo.claimPurgeBatch(10), []);
});

test("a report with an upload still in flight is not offered for purging until it is released", opts, async () => {
  await pool.query("DELETE FROM weekly_reports");
  const { id } = await repo.createReport({ brandKey: "BBB", title: "T", reportingWeek: "Uploading", sourceType: "pptx", uploadedBy: "u" });
  assert.deepEqual(await repo.cancel(id, "BBB"), { purgeNow: false });
  assert.deepEqual(await repo.claimPurgeBatch(10), []);
  await repo.releaseForProcessing(id, "BBB", { sourceKey: "BBB/x", sizeBytes: 1, sha256: "c".repeat(64) });
  assert.deepEqual((await repo.claimPurgeBatch(10)).map((r) => r.id), [id]);
});


test("createReport de-duplicates titles per brand, case-insensitively, and leaves the week alone", opts, async () => {
  await pool.query("DELETE FROM weekly_reports");
  const mk = (brandKey, title, reportingWeek) =>
    repo.createReport({ brandKey, title, reportingWeek, sourceType: "pptx", uploadedBy: "u" });
  assert.equal((await mk("BBB", "Weekly Review", "Week 1")).title, "Weekly Review");
  assert.equal((await mk("BBB", "weekly review", "Week 1")).title, "weekly review (1)");
  assert.equal((await mk("BBB", "Weekly Review", "Week 2")).title, "Weekly Review (2)");
  assert.equal((await mk("PTS", "Weekly Review", "Week 1")).title, "Weekly Review", "other brand is separate");
  const [rows] = await pool.query("SELECT reporting_week, version FROM weekly_reports WHERE brand_key = 'BBB' ORDER BY id");
  assert.deepEqual(rows.map((r) => [r.reporting_week, r.version]), [["Week 1", 1], ["Week 1", 2], ["Week 2", 1]]);
});

test("five uploads of the same title at once all get different titles and versions", opts, async () => {
  await pool.query("DELETE FROM weekly_reports");
  const made = await Promise.all(
    Array.from({ length: 5 }, () => repo.createReport({ brandKey: "BBB", title: "Race", reportingWeek: "Week 9", sourceType: "pptx", uploadedBy: "u" })),
  );
  assert.deepEqual(made.map((m) => m.title).sort(), ["Race", "Race (1)", "Race (2)", "Race (3)", "Race (4)"]);
  assert.deepEqual(made.map((m) => m.version).sort(), [1, 2, 3, 4, 5]);
});

test("findDuplicates reports the title clash, the name it would get, and the week count", opts, async () => {
  await pool.query("DELETE FROM weekly_reports");
  await repo.createReport({ brandKey: "BBB", title: "Quarterly", reportingWeek: "Week 7", sourceType: "pptx", uploadedBy: "u" });
  await repo.createReport({ brandKey: "BBB", title: "Other", reportingWeek: "week 7", sourceType: "pptx", uploadedBy: "u" });
  assert.deepEqual(await repo.findDuplicates("BBB", { title: "quarterly", reportingWeek: "Week 7" }), { titleExists: true, suggestedTitle: "quarterly (1)", weekCount: 2 });
  assert.deepEqual(await repo.findDuplicates("BBB", { title: "Brand new", reportingWeek: "Week 8" }), { titleExists: false, suggestedTitle: "Brand new", weekCount: 0 });
  assert.deepEqual(await repo.findDuplicates("PTS", { title: "Quarterly", reportingWeek: "Week 7" }), { titleExists: false, suggestedTitle: "Quarterly", weekCount: 0 });
});

test("deleted and cancelled presentations free their title and no longer count for the week", opts, async () => {
  await pool.query("DELETE FROM weekly_reports");
  const a = await repo.createReport({ brandKey: "BBB", title: "Temp", reportingWeek: "Week 3", sourceType: "pptx", uploadedBy: "u" });
  await repo.cancel(a.id, "BBB");
  assert.deepEqual(await repo.findDuplicates("BBB", { title: "Temp", reportingWeek: "Week 3" }), { titleExists: false, suggestedTitle: "Temp", weekCount: 0 });
  assert.equal((await repo.createReport({ brandKey: "BBB", title: "Temp", reportingWeek: "Week 3", sourceType: "pptx", uploadedBy: "u" })).title, "Temp");
});

test("a PDF source type can be stored (migration 004), alongside pptx and ppt", opts, async () => {
  await pool.query("DELETE FROM weekly_reports");
  for (const sourceType of ["pdf", "pptx", "ppt"]) {
    const { id } = await repo.createReport({ brandKey: "BBB", title: `Doc ${sourceType}`, reportingWeek: "Week 5", sourceType, uploadedBy: "u" });
    assert.equal((await repo.findById(id)).source_type, sourceType);
  }
  await assert.rejects(
    repo.createReport({ brandKey: "BBB", title: "Bad", reportingWeek: "Week 5", sourceType: "docx", uploadedBy: "u" }),
    "other types are still refused by the database",
  );
});

test("teardown", opts, async () => {
  await pool.end();
});
