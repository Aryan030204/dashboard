// Exercises the real Meeting Pointers SQL against a MySQL 8 server. Skipped unless WR_TEST_DB_HOST is set, e.g.:
//   docker run -d --name wr-mysql -e MYSQL_ROOT_PASSWORD=pw -e MYSQL_DATABASE=wr -p 33310:3306 mysql:8
//   WR_TEST_DB_HOST=127.0.0.1 WR_TEST_DB_PORT=33310 WR_TEST_DB_USER=root WR_TEST_DB_PASSWORD=pw WR_TEST_DB_NAME=wr npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { buildMeetingRepo } = require("../src/services/meetingRepo");

const env = process.env;
const enabled = Boolean(env.WR_TEST_DB_HOST);
const opts = { skip: enabled ? false : "set WR_TEST_DB_HOST to run the MySQL tests" };

let pool;
let repo;

const ID = "01HZXABCDEFGH1234567890AB";
const meetingFor = (transcriptId = ID) => ({ transcriptId, title: "Weekly Sync", meetingDate: new Date("2026-11-03T10:00:00Z"), organizer: "h@x.com", attendees: [{ name: "A", email: "a@x.com" }], summary: "s", sourceUrl: "https://app.fireflies.ai/view/x" });
const items = [{ sourceKey: "aaa-1", originalText: "Do the first thing" }, { sourceKey: "bbb-1", originalText: "Do the second thing" }];

async function queued(brand = "BBB", transcriptId = ID) {
  const { id } = await repo.createImport({ brandKey: brand, transcriptId, sourceUrl: "https://app.fireflies.ai/view/x", requestedBy: "u1" });
  return id;
}

test("setup: apply the real migration", opts, async () => {
  pool = mysql.createPool({
    host: env.WR_TEST_DB_HOST, port: Number(env.WR_TEST_DB_PORT || 3306), user: env.WR_TEST_DB_USER,
    password: env.WR_TEST_DB_PASSWORD, database: env.WR_TEST_DB_NAME, multipleStatements: true, timezone: "Z",
  });
  await pool.query("DROP TABLE IF EXISTS meeting_pointer_events, meeting_pointers, meeting_imports, meeting_records");
  const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "006-create-meeting-pointers.sql"), "utf8");
  await pool.query(sql);
  await pool.query(sql); // safe to run twice
  repo = buildMeetingRepo(pool);
  assert.equal((await repo.checkSchema()).ok, true);
});

test("the happy path: QUEUED -> FETCHING -> IMPORTED writes the meeting and its pointers atomically", opts, async () => {
  const id = await queued();
  assert.equal((await repo.findImport(id, "BBB")).status, "QUEUED");
  const job = await repo.claimNextImport("w1");
  assert.equal(job.id, id);
  assert.equal(job.attempts, 1);
  assert.equal((await repo.findImport(id, "BBB")).status, "FETCHING");

  const done = await repo.completeImport({ importId: id, brandKey: "BBB", connectionId: "abc", importedBy: "u1", meeting: meetingFor(), pointers: items });
  assert.ok(done.meetingId);
  const imp = await repo.findImport(id, "BBB");
  assert.equal(imp.status, "IMPORTED");
  assert.equal(Number(imp.meeting_id), done.meetingId);
  const meeting = await repo.findMeeting(done.meetingId, "BBB");
  assert.equal(meeting.title, "Weekly Sync");
  assert.deepEqual(meeting.attendees, [{ name: "A", email: "a@x.com" }]);
  const pointers = await repo.listPointers(done.meetingId, "BBB");
  assert.deepEqual(pointers.map((p) => p.original_text), ["Do the first thing", "Do the second thing"]);
  assert.equal(pointers[0].review_state, "PENDING_REVIEW");
  assert.equal(pointers[0].refined_title, null);
});

test("the UNIQUE (brand_key, fireflies_transcript_id) key stops a second meeting for the same brand, and leaves nothing behind", opts, async () => {
  const id = await queued("BBB", "DUPLICATE0001");
  await repo.claimNextImport("w1");
  const first = await repo.completeImport({ importId: id, brandKey: "BBB", importedBy: "u1", meeting: meetingFor("DUPLICATE0001"), pointers: items });
  const again = await queued("BBB", "DUPLICATE0001"); // allowed: the first import is no longer active
  await repo.claimNextImport("w1");
  const dup = await repo.completeImport({ importId: again, brandKey: "BBB", importedBy: "u1", meeting: meetingFor("DUPLICATE0001"), pointers: items });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.meetingId, first.meetingId);
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM meeting_records WHERE fireflies_transcript_id = 'DUPLICATE0001'");
  assert.equal(Number(n), 1);
  const [[{ p }]] = await pool.query("SELECT COUNT(*) AS p FROM meeting_pointers WHERE meeting_id = ?", [first.meetingId]);
  assert.equal(Number(p), 2, "the rolled-back second attempt wrote no pointers");
  assert.equal((await repo.findImport(again, "BBB")).status, "FETCHING", "still the worker's to finish as DUPLICATE");
});

test("the same meeting can exist once per brand", opts, async () => {
  const a = await queued("BBB", "PERBRAND0001");
  await repo.claimNextImport("w");
  const b = await queued("PTS", "PERBRAND0001");
  await repo.claimNextImport("w");
  const ra = await repo.completeImport({ importId: a, brandKey: "BBB", importedBy: "u", meeting: meetingFor("PERBRAND0001"), pointers: [] });
  const rb = await repo.completeImport({ importId: b, brandKey: "PTS", importedBy: "u", meeting: meetingFor("PERBRAND0001"), pointers: [] });
  assert.notEqual(ra.meetingId, rb.meetingId);
});

test("two imports of the same meeting cannot be active at once (race-free), but can follow each other", opts, async () => {
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => repo.createImport({ brandKey: "BBB", transcriptId: "RACE00000001", sourceUrl: null, requestedBy: "u" })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results.filter((x) => x.status === "rejected")) {
    assert.equal(r.reason.code, "DUPLICATE_MEETING");
    assert.equal(r.reason.status, 409);
    assert.ok(r.reason.importId);
  }
  const winner = results.find((r) => r.status === "fulfilled").value.id;
  await repo.claimNextImport("w");
  await repo.finishImport(winner, "BBB", { status: "NOT_FOUND", code: "FIREFLIES_MEETING_NOT_FOUND", message: "nope" });
  const retry = await repo.createImport({ brandKey: "BBB", transcriptId: "RACE00000001", sourceUrl: null, requestedBy: "u" });
  assert.ok(retry.id > winner, "a failed import frees the slot");
});

test("ids are case-sensitive (binary collation)", opts, async () => {
  const lower = await repo.createImport({ brandKey: "BBB", transcriptId: "caseSensitive01", sourceUrl: null, requestedBy: "u" });
  const upper = await repo.createImport({ brandKey: "BBB", transcriptId: "CASESENSITIVE01", sourceUrl: null, requestedBy: "u" });
  assert.notEqual(lower.id, upper.id);
});

test("brand isolation in every read", opts, async () => {
  const id = await queued("BBB", "ISOLATION0001");
  await repo.claimNextImport("w");
  const done = await repo.completeImport({ importId: id, brandKey: "BBB", importedBy: "u", meeting: meetingFor("ISOLATION0001"), pointers: items });
  assert.equal(await repo.findImport(id, "PTS"), null);
  assert.equal(await repo.findMeeting(done.meetingId, "PTS"), null);
  assert.deepEqual(await repo.listPointers(done.meetingId, "PTS"), []);
  assert.equal(await repo.findMeetingByTranscript("PTS", "ISOLATION0001"), null);
  assert.ok(await repo.findMeetingByTranscript("BBB", "ISOLATION0001"));
});

test("claiming: only due QUEUED jobs, never the same job twice, oldest first", opts, async () => {
  await pool.query("DELETE FROM meeting_imports");
  const a = await queued("BBB", "CLAIM0000001");
  const b = await queued("BBB", "CLAIM0000002");
  const claims = await Promise.all([repo.claimNextImport("w1"), repo.claimNextImport("w2"), repo.claimNextImport("w3")]);
  const got = claims.filter(Boolean).map((c) => c.id).sort((x, y) => x - y);
  assert.deepEqual(got, [a, b]);
  assert.equal(await repo.claimNextImport("w4"), null);
});

test("a retry waits until it is due, and the attempt count survives", opts, async () => {
  await pool.query("DELETE FROM meeting_imports");
  const id = await queued("BBB", "RETRY00000001");
  await repo.claimNextImport("w");
  await repo.scheduleRetry(id, "BBB", { delayMs: 3600 * 1000, code: "FIREFLIES_RATE_LIMITED", message: "later" });
  const row = await repo.findImport(id, "BBB");
  assert.equal(row.status, "QUEUED");
  assert.equal(row.error_code, "FIREFLIES_RATE_LIMITED");
  assert.equal(await repo.claimNextImport("w"), null, "an hour away");
  await pool.query("UPDATE meeting_imports SET next_attempt_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE id = ?", [id]);
  const again = await repo.claimNextImport("w");
  assert.equal(again.id, id);
  assert.equal(again.attempts, 2);
});

test("stale FETCHING jobs are requeued, or failed once they used all attempts", opts, async () => {
  await pool.query("DELETE FROM meeting_imports");
  const fresh = await queued("BBB", "STALE00000001");
  const worn = await queued("BBB", "STALE00000002");
  await repo.claimNextImport("w");
  await repo.claimNextImport("w");
  await pool.query("UPDATE meeting_imports SET locked_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE id IN (?, ?)", [fresh, worn]);
  await pool.query("UPDATE meeting_imports SET attempts = 5 WHERE id = ?", [worn]);
  const out = await repo.recoverStale(300 * 1000, 5);
  assert.deepEqual(out, { failed: 1, requeued: 1 });
  assert.equal((await repo.findImport(fresh, "BBB")).status, "QUEUED");
  const failed = await repo.findImport(worn, "BBB");
  assert.equal(failed.status, "FETCH_FAILED");
  assert.equal(failed.error_code, "IMPORT_FAILED");
});

test("an import that is no longer FETCHING cannot be completed (the transaction rolls back)", opts, async () => {
  await pool.query("DELETE FROM meeting_imports");
  const id = await queued("BBB", "LOSTCLAIM001");
  // still QUEUED: not claimed by this worker
  await assert.rejects(
    () => repo.completeImport({ importId: id, brandKey: "BBB", importedBy: "u", meeting: meetingFor("LOSTCLAIM001"), pointers: items }),
    (err) => err.lostClaim === true,
  );
  assert.equal(await repo.findMeetingByTranscript("BBB", "LOSTCLAIM001"), null, "no meeting was left behind");
});

test("pointers: the same source key cannot appear twice for one meeting; deleting a meeting removes its pointers", opts, async () => {
  const id = await queued("BBB", "POINTER00001");
  await repo.claimNextImport("w");
  const done = await repo.completeImport({ importId: id, brandKey: "BBB", importedBy: "u", meeting: meetingFor("POINTER00001"), pointers: items });
  await assert.rejects(() => pool.query("INSERT INTO meeting_pointers (brand_key, meeting_id, source_key, original_text) VALUES ('BBB', ?, 'aaa-1', 'x')", [done.meetingId]), (e) => e.code === "ER_DUP_ENTRY");
  await pool.query("DELETE FROM meeting_records WHERE id = ?", [done.meetingId]);
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM meeting_pointers WHERE meeting_id = ?", [done.meetingId]);
  assert.equal(Number(n), 0);
});

test("the schema has no Todoist columns or tables", opts, async () => {
  const [rows] = await pool.query(
    "SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name LIKE 'meeting\\_%' AND (column_name LIKE '%todoist%' OR table_name LIKE '%todoist%')",
  );
  assert.deepEqual(rows, []);
});
