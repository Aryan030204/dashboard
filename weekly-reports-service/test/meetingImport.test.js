// The import service: request -> queued job -> worker processing -> meeting + raw pointers, with every failure path.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  API_KEY, GOOD_URL, GOOD_ID, makeMeetingService, fakeFireflies, fakeConnections, fakeMeetingRepo, sampleMeeting, ffError,
} = require("./meetingHelpers");

const principal = (brand = "BBB", user = "mgr1") => ({ user_id: user, brand_key: brand, role: "brand_user", permissions: ["meeting_pointers_manage"] });

async function queue(ctx, brand = "BBB", url = GOOD_URL) {
  return ctx.service.requestImport({ principal: principal(brand), brandKey: brand, firefliesUrl: url });
}
async function runOne(ctx) {
  const job = await ctx.repo.claimNextImport("worker-1");
  assert.ok(job, "a job should be due");
  return { job, outcome: await ctx.service.processImport(job) };
}

test("a valid link is queued asynchronously: Fireflies is not called while the request is handled", async () => {
  const ctx = await makeMeetingService();
  const out = await queue(ctx);
  assert.equal(out.status, "QUEUED");
  assert.equal(out.fireflies_transcript_id, GOOD_ID);
  assert.equal(ctx.firefliesClient.calls.length, 0);
  assert.equal(ctx.repo._imports[0].status, "QUEUED");
  assert.deepEqual(ctx.audit.events.map((e) => e.action), ["IMPORT_REQUESTED"]);
});

test("QUEUED -> FETCHING -> IMPORTED: the meeting and one raw pointer per action item are stored", async () => {
  const ctx = await makeMeetingService();
  const { import_id } = await queue(ctx);
  const claimed = await ctx.repo.claimNextImport("w1");
  assert.equal((await ctx.repo.findImport(import_id, "BBB")).status, "FETCHING");
  const outcome = await ctx.service.processImport(claimed);
  assert.equal(outcome.status, "IMPORTED");
  assert.equal(outcome.pointers, 2);

  const imp = await ctx.service.getImport({ principal: principal(), id: import_id });
  assert.equal(imp.status, "IMPORTED");
  assert.equal(imp.error_code, null);

  const meeting = await ctx.service.getMeeting({ principal: principal(), id: imp.meeting_id });
  assert.equal(meeting.title, "Weekly Sync");
  assert.equal(meeting.brand_key, "BBB");
  assert.equal(meeting.pointers.length, 2);
  const first = meeting.pointers[0];
  assert.equal(first.original_text, "Follow up with the client about pricing");
  assert.equal(first.review_state, "PENDING_REVIEW");
  for (const field of ["refined_title", "refined_description", "assignee", "due_date", "priority", "category", "labels"]) assert.equal(first[field], null, `${field} starts empty`);
  assert.deepEqual(ctx.audit.events.map((e) => e.action), ["IMPORT_REQUESTED", "IMPORT_STARTED", "IMPORT_SUCCEEDED"]);
});

test("the stored key is decrypted in memory only for the Fireflies call, and never persisted in plaintext", async () => {
  const ctx = await makeMeetingService();
  await queue(ctx);
  await runOne(ctx);
  assert.equal(ctx.firefliesClient.calls[0].apiKey, API_KEY, "the client received the decrypted key");
  const stored = ctx.connections.state.record;
  assert.equal(stored.encryption_algorithm, "AES-256-CBC");
  assert.ok(stored.encrypted_api_key && stored.encryption_iv);
  assert.ok(!("api_key" in stored) && !("plaintext_api_key" in stored));
  const everything = JSON.stringify({ stored, imports: ctx.repo._imports, meetings: ctx.repo._meetings, pointers: ctx.repo._pointers, audit: ctx.audit.events });
  assert.ok(!everything.includes(API_KEY), "the plaintext key appears in no stored record or audit event");
});

test("saving the key twice creates, then updates, the single connection (audited without the key)", async () => {
  const ctx = await makeMeetingService({ connected: false });
  const p = { user_id: "root1", brand_key: "BBB" };
  const first = await ctx.service.saveIntegration({ principal: p, apiKey: "first-key-123456", accountEmail: "a@x.com" });
  const second = await ctx.service.saveIntegration({ principal: p, apiKey: "second-key-654321" });
  assert.equal(first.configured, true);
  assert.equal(first.status, "ACTIVE");
  assert.equal(second.account_email, null);
  assert.deepEqual(ctx.audit.events.map((e) => e.action), ["FIREFLIES_CONFIGURATION_CREATED", "FIREFLIES_CONFIGURATION_UPDATED"]);
  assert.ok(!JSON.stringify([first, second, ctx.audit.events]).includes("first-key") && !JSON.stringify([first, second, ctx.audit.events]).includes("second-key"));
  assert.notEqual(ctx.connections.state.record.encrypted_api_key, "second-key-654321");
});

test("Fireflies cannot find the meeting -> NOT_FOUND with a safe message, no retry", async () => {
  const ctx = await makeMeetingService({ firefliesClient: fakeFireflies([ffError("NOT_FOUND")]) });
  const { import_id } = await queue(ctx);
  const { outcome } = await runOne(ctx);
  assert.equal(outcome.status, "NOT_FOUND");
  const imp = await ctx.service.getImport({ principal: principal(), id: import_id });
  assert.equal(imp.status, "NOT_FOUND");
  assert.equal(imp.error_code, "FIREFLIES_MEETING_NOT_FOUND");
  assert.ok(imp.error_message && !/test\)/.test(imp.error_message), "the message is the fixed safe text, not the raw error");
  assert.equal(ctx.firefliesClient.calls.length, 1);
  assert.equal(await ctx.repo.claimNextImport("w"), null, "a permanent failure is not retried");
  assert.ok(ctx.audit.events.some((e) => e.action === "IMPORT_FAILED"));
});

test("Fireflies refuses the account -> ACCESS_DENIED", async () => {
  const ctx = await makeMeetingService({ firefliesClient: fakeFireflies([ffError("ACCESS_DENIED")]) });
  const { import_id } = await queue(ctx);
  const { outcome } = await runOne(ctx);
  assert.equal(outcome.status, "ACCESS_DENIED");
  const imp = await ctx.service.getImport({ principal: principal(), id: import_id });
  assert.equal(imp.error_code, "FIREFLIES_ACCESS_DENIED");
});

test("a permanent Fireflies API error -> FETCH_FAILED at once", async () => {
  const ctx = await makeMeetingService({ firefliesClient: fakeFireflies([ffError("API_ERROR", { retryable: false })]) });
  const { import_id } = await queue(ctx);
  const { outcome } = await runOne(ctx);
  assert.equal(outcome.status, "FETCH_FAILED");
  assert.equal((await ctx.service.getImport({ principal: principal(), id: import_id })).error_code, "FIREFLIES_API_ERROR");
});

test("rate limiting is retried with a delay, honouring Retry-After, then succeeds", async () => {
  const ctx = await makeMeetingService({ firefliesClient: fakeFireflies([ffError("RATE_LIMITED", { retryable: true, retryAfterMs: 60000 }), sampleMeeting()]) });
  const { import_id } = await queue(ctx);
  const first = await runOne(ctx);
  assert.equal(first.outcome.status, "RETRY");
  assert.ok(first.outcome.delayMs >= 60000, "waits at least as long as Fireflies asked");
  const row = await ctx.repo.findImport(import_id, "BBB");
  assert.equal(row.status, "QUEUED");
  assert.equal(row.error_code, "FIREFLIES_RATE_LIMITED");
  assert.equal(await ctx.repo.claimNextImport("w"), null, "not claimable before next_attempt_at");

  ctx.repo._imports[0].next_attempt_at = 0; // time passes
  const second = await runOne(ctx);
  assert.equal(second.outcome.status, "IMPORTED");
  assert.equal((await ctx.repo.findImport(import_id, "BBB")).attempts, 2);
});

test("backoff grows exponentially, is capped, and never goes below Retry-After", async () => {
  const ctx = await makeMeetingService({ fireflies: { retryBaseMs: 1000, retryMaxMs: 5000 } });
  const b = ctx.service.backoffMs;
  assert.equal(b(1), 1000);
  assert.equal(b(2), 2000);
  assert.equal(b(3), 4000);
  assert.equal(b(4), 5000, "capped");
  assert.equal(b(10), 5000);
  assert.equal(b(1, 30000), 30000, "Retry-After wins when it is longer");
});

test("retryable errors are retried until the attempts run out, then the import is FETCH_FAILED", async () => {
  const ctx = await makeMeetingService({ firefliesClient: fakeFireflies([ffError("RATE_LIMITED", { retryable: true })]) }); // maxAttempts = 3
  const { import_id } = await queue(ctx);
  const outcomes = [];
  for (let i = 0; i < 3; i += 1) {
    ctx.repo._imports[0].next_attempt_at = 0;
    outcomes.push((await runOne(ctx)).outcome.status);
  }
  assert.deepEqual(outcomes, ["RETRY", "RETRY", "FETCH_FAILED"]);
  const imp = await ctx.service.getImport({ principal: principal(), id: import_id });
  assert.equal(imp.status, "FETCH_FAILED");
  assert.equal(imp.error_code, "FIREFLIES_RATE_LIMITED");
  assert.equal(imp.attempts, 3);
  assert.equal(ctx.firefliesClient.calls.length, 3);
});

test("a temporary Fireflies outage is retried and then succeeds", async () => {
  const ctx = await makeMeetingService({ firefliesClient: fakeFireflies([ffError("API_ERROR", { retryable: true }), sampleMeeting()]) });
  const { import_id } = await queue(ctx);
  assert.equal((await runOne(ctx)).outcome.status, "RETRY");
  ctx.repo._imports[0].next_attempt_at = 0;
  assert.equal((await runOne(ctx)).outcome.status, "IMPORTED");
  assert.equal((await ctx.service.getImport({ principal: principal(), id: import_id })).status, "IMPORTED");
});

test("an unexpected error (not from Fireflies) is retried, then failed with a generic code and no internals", async () => {
  const boom = fakeFireflies([() => { throw new Error("ECONNRESET mysql://user:pw@10.0.0.5/db"); }]);
  const ctx = await makeMeetingService({ firefliesClient: boom });
  const { import_id } = await queue(ctx);
  for (let i = 0; i < 3; i += 1) {
    ctx.repo._imports[0].next_attempt_at = 0;
    await runOne(ctx);
  }
  const imp = await ctx.service.getImport({ principal: principal(), id: import_id });
  assert.equal(imp.status, "FETCH_FAILED");
  assert.equal(imp.error_code, "IMPORT_FAILED");
  assert.ok(!JSON.stringify(imp).includes("mysql://"), "internal details are not exposed");
});

test("an invalid link is refused up front and creates no job", async () => {
  const ctx = await makeMeetingService();
  for (const url of ["https://evil.com/view/" + GOOD_ID, "nope", "http://app.fireflies.ai/view/" + GOOD_ID, "https://app.fireflies.ai/view/"]) {
    await assert.rejects(() => queue(ctx, "BBB", url), (e) => e.status === 400 && e.code === "INVALID_FIREFLIES_URL");
  }
  assert.equal(ctx.repo._imports.length, 0);
  assert.equal(ctx.firefliesClient.calls.length, 0);
});

test("without a configured Fireflies connection the request is refused (503) and nothing is queued", async () => {
  const ctx = await makeMeetingService({ connected: false });
  await assert.rejects(() => queue(ctx), (e) => e.status === 503 && e.code === "FIREFLIES_CONNECTION_NOT_CONFIGURED");
  assert.equal(ctx.repo._imports.length, 0);
});

test("a job whose connection disappeared meanwhile ends as FETCH_FAILED / not configured", async () => {
  const ctx = await makeMeetingService();
  await queue(ctx);
  ctx.connections.state.record = null;
  const { outcome } = await runOne(ctx);
  assert.equal(outcome.status, "FETCH_FAILED");
  assert.equal(ctx.repo._imports[0].error_code, "FIREFLIES_CONNECTION_NOT_CONFIGURED");
  assert.equal(ctx.firefliesClient.calls.length, 0);
});

test("a missing or invalid AES key: saving is refused (503) and a queued job fails without calling Fireflies", async () => {
  const ctx = await makeMeetingService({ fireflies: { encryptionKey: "" }, connected: false });
  await assert.rejects(
    () => ctx.service.saveIntegration({ principal: principal(), apiKey: API_KEY }),
    (e) => e.status === 503 && e.code === "FIREFLIES_ENCRYPTION_NOT_CONFIGURED",
  );
  assert.equal(ctx.connections.state.record, null, "nothing was stored");

  // A connection saved earlier, but the server key is now missing.
  const base = await makeMeetingService();
  const noKey = await makeMeetingService({ repo: base.repo, connections: base.connections, audit: base.audit, fireflies: { encryptionKey: "" }, connected: false });
  await queue(noKey);
  const { outcome } = await runOne(noKey);
  assert.equal(outcome.status, "FETCH_FAILED");
  assert.equal(noKey.repo._imports[0].error_code, "FIREFLIES_ENCRYPTION_NOT_CONFIGURED");
  assert.equal(noKey.firefliesClient.calls.length, 0);
});

test("a stored credential that cannot be decrypted (wrong AES key) fails the import safely", async () => {
  const base = await makeMeetingService();
  const other = await makeMeetingService({
    repo: base.repo, connections: base.connections, audit: base.audit, connected: false,
    fireflies: { encryptionKey: "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100" },
  });
  await queue(other);
  const { outcome } = await runOne(other);
  assert.equal(outcome.status, "FETCH_FAILED");
  assert.equal(other.repo._imports[0].error_code, "FIREFLIES_CREDENTIAL_UNREADABLE");
});

// ---- duplicates --------------------------------------------------------------------------------
test("importing the same meeting again for the same brand is a DUPLICATE_MEETING (409) and creates nothing", async () => {
  const ctx = await makeMeetingService();
  await queue(ctx);
  await runOne(ctx);
  await assert.rejects(() => queue(ctx), (e) => e.status === 409 && e.code === "DUPLICATE_MEETING" && e.details.meeting_id === ctx.repo._meetings[0].id);
  assert.equal(ctx.repo._meetings.length, 1);
  assert.equal(ctx.repo._pointers.length, 2);
  assert.equal(ctx.repo._imports.length, 1);
  assert.ok(ctx.audit.events.some((e) => e.action === "DUPLICATE_DETECTED"));
});

test("two requests for a meeting that is already queued: the second is refused and points at the running import", async () => {
  const ctx = await makeMeetingService();
  const first = await queue(ctx);
  await assert.rejects(() => queue(ctx), (e) => e.status === 409 && e.code === "DUPLICATE_MEETING" && e.details.import_id === first.import_id);
  assert.equal(ctx.repo._imports.length, 1);
});

test("a duplicate caught only at write time (a race) ends the job as DUPLICATE and writes no second meeting", async () => {
  const ctx = await makeMeetingService();
  await queue(ctx);
  const claimed = await ctx.repo.claimNextImport("w1");
  // Another worker/request imported the same meeting after the job was claimed.
  ctx.repo._meetings.push({ id: 900, brand_key: "BBB", fireflies_transcript_id: GOOD_ID, title: "Already here" });
  const outcome = await ctx.service.processImport(claimed);
  assert.equal(outcome.status, "DUPLICATE");
  assert.equal(outcome.meetingId, 900);
  assert.equal(ctx.repo._meetings.length, 1);
  const row = await ctx.repo.findImport(claimed.id, "BBB");
  assert.equal(row.status, "DUPLICATE");
  assert.equal(row.error_code, "DUPLICATE_MEETING");
  assert.equal(row.meeting_id, 900);
});

test("the same Fireflies meeting can be imported independently by two different brands", async () => {
  const ctx = await makeMeetingService();
  await queue(ctx, "BBB");
  await runOne(ctx);
  await queue(ctx, "PTS");
  await runOne(ctx);
  assert.equal(ctx.repo._meetings.length, 2);
  assert.deepEqual(ctx.repo._meetings.map((m) => m.brand_key).sort(), ["BBB", "PTS"]);
});

test("a failed import can be requested again (the failure is not an active import)", async () => {
  const ctx = await makeMeetingService({ firefliesClient: fakeFireflies([ffError("NOT_FOUND"), sampleMeeting()]) });
  await queue(ctx);
  await runOne(ctx);
  const again = await queue(ctx);
  assert.equal(again.status, "QUEUED");
  assert.equal((await runOne(ctx)).outcome.status, "IMPORTED");
});

test("an import with no action items still stores the meeting (zero pointers)", async () => {
  const ctx = await makeMeetingService({ firefliesClient: fakeFireflies([sampleMeeting({ actionItemsText: null })]) });
  await queue(ctx);
  const { outcome } = await runOne(ctx);
  assert.equal(outcome.status, "IMPORTED");
  assert.equal(outcome.pointers, 0);
  assert.equal(ctx.repo._meetings.length, 1);
});

test("if the job was taken over while it ran, the worker leaves it alone", async () => {
  const ctx = await makeMeetingService();
  await queue(ctx);
  const claimed = await ctx.repo.claimNextImport("w1");
  ctx.repo._imports[0].status = "FETCH_FAILED"; // e.g. recovered by the stale sweep meanwhile
  const outcome = await ctx.service.processImport(claimed);
  assert.equal(outcome.status, "SKIPPED");
  assert.equal(ctx.repo._meetings.length, 0);
});

// ---- isolation at the service level ------------------------------------------------------------
test("brand A cannot read brand B's import or meeting, and the target brand must match the signed brand", async () => {
  const ctx = await makeMeetingService();
  const { import_id } = await queue(ctx, "BBB");
  await runOne(ctx);
  const meetingId = ctx.repo._meetings[0].id;
  await assert.rejects(() => ctx.service.getImport({ principal: principal("PTS"), id: import_id }), (e) => e.status === 404);
  await assert.rejects(() => ctx.service.getMeeting({ principal: principal("PTS"), id: meetingId }), (e) => e.status === 404);
  await assert.rejects(
    () => ctx.service.requestImport({ principal: principal("PTS"), brandKey: "BBB", firefliesUrl: GOOD_URL }),
    (e) => e.status === 400 && e.code === "BRAND_MISMATCH",
  );
  for (const bad of ["abc", "1; DROP TABLE x", "-1", "99999999999999999999"]) {
    await assert.rejects(() => ctx.service.getImport({ principal: principal(), id: bad }), (e) => e.status === 404);
  }
});

test("log lines and audit records never contain the API key", async () => {
  const previous = process.env.WEEKLY_REPORTS_LOG_LEVEL;
  process.env.WEEKLY_REPORTS_LOG_LEVEL = "debug";
  try {
    const ctx = await makeMeetingService({ firefliesClient: fakeFireflies([ffError("RATE_LIMITED", { retryable: true }), ffError("ACCESS_DENIED")]) });
    await ctx.service.saveIntegration({ principal: principal(), apiKey: API_KEY });
    await queue(ctx);
    await runOne(ctx);
    ctx.repo._imports[0].next_attempt_at = 0;
    await runOne(ctx);
    assert.ok(ctx.lines.length > 5, "something was logged");
    assert.ok(!ctx.lines.join("\n").includes(API_KEY));
    assert.ok(!JSON.stringify(ctx.audit.events).includes(API_KEY));
  } finally {
    if (previous === undefined) delete process.env.WEEKLY_REPORTS_LOG_LEVEL;
    else process.env.WEEKLY_REPORTS_LOG_LEVEL = previous;
  }
});

test("the import and meeting responses expose no worker, credential or internal-user fields", async () => {
  const ctx = await makeMeetingService();
  const { import_id } = await queue(ctx);
  await runOne(ctx);
  const imp = await ctx.service.getImport({ principal: principal(), id: import_id });
  const meeting = await ctx.service.getMeeting({ principal: principal(), id: imp.meeting_id });
  for (const key of ["locked_by", "locked_at", "requested_by", "next_attempt_at", "source_url"]) assert.ok(!(key in imp), `import has no ${key}`);
  for (const key of ["imported_by", "fireflies_connection_id"]) assert.ok(!(key in meeting), `meeting has no ${key}`);
  assert.ok(!JSON.stringify([imp, meeting]).includes(API_KEY));
});

test("sanity: the fakes are independent (a second service starts empty)", async () => {
  const a = await makeMeetingService();
  const b = await makeMeetingService({ repo: fakeMeetingRepo(), connections: fakeConnections() });
  await queue(a);
  assert.equal(b.repo._imports.length, 0);
});
