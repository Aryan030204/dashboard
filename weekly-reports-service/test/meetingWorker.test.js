// The worker side: the loop in src/worker.js claims one due import, processes it, and recovers abandoned ones.
// This reproduces that cycle with the same repo and service calls, so queue handling and retries are covered.
const test = require("node:test");
const assert = require("node:assert/strict");
const { GOOD_URL, makeMeetingService, fakeFireflies, sampleMeeting, ffError } = require("./meetingHelpers");

const principal = { user_id: "mgr1", brand_key: "BBB" };
const request = (ctx, url = GOOD_URL) => ctx.service.requestImport({ principal, brandKey: "BBB", firefliesUrl: url });

// One worker pass over the import queue, exactly as worker.js does it.
async function pass(ctx, workerId = "w1") {
  await ctx.repo.recoverStale(ctx.config.fireflies.staleMs, ctx.config.fireflies.maxAttempts);
  const job = await ctx.repo.claimNextImport(workerId);
  if (!job) return null;
  return { job, outcome: await ctx.service.processImport(job) };
}

test("a queued job is picked up and becomes IMPORTED", async () => {
  const ctx = await makeMeetingService();
  const { import_id } = await request(ctx);
  assert.equal(ctx.repo._imports[0].status, "QUEUED");
  const done = await pass(ctx);
  assert.equal(done.outcome.status, "IMPORTED");
  assert.equal((await ctx.repo.findImport(import_id, "BBB")).status, "IMPORTED");
  assert.equal(await pass(ctx), null, "nothing left to do");
});

test("an empty queue is a quiet no-op", async () => {
  const ctx = await makeMeetingService();
  assert.equal(await pass(ctx), null);
});

test("jobs are handled one at a time, oldest first, and each exactly once", async () => {
  const ctx = await makeMeetingService({
    firefliesClient: fakeFireflies([sampleMeeting({ transcriptId: "AAAAAAAA1111" }), sampleMeeting({ transcriptId: "BBBBBBBB2222" })]),
  });
  const a = await request(ctx, "https://app.fireflies.ai/view/AAAAAAAA1111");
  const b = await request(ctx, "https://app.fireflies.ai/view/BBBBBBBB2222");
  const first = await pass(ctx);
  const second = await pass(ctx);
  assert.deepEqual([first.job.id, second.job.id], [a.import_id, b.import_id]);
  assert.equal(await pass(ctx), null);
  assert.equal(ctx.firefliesClient.calls.length, 2);
});

test("two workers racing for the same job: only one gets it", async () => {
  const ctx = await makeMeetingService();
  await request(ctx);
  const [one, two] = await Promise.all([ctx.repo.claimNextImport("w1"), ctx.repo.claimNextImport("w2")]);
  assert.equal([one, two].filter(Boolean).length, 1);
});

test("a retryable error puts the job back on the queue, and it is picked up again only once it is due", async () => {
  const ctx = await makeMeetingService({ firefliesClient: fakeFireflies([ffError("API_ERROR", { retryable: true }), sampleMeeting()]) });
  await request(ctx);
  assert.equal((await pass(ctx)).outcome.status, "RETRY");
  assert.equal(await pass(ctx), null, "not due yet");
  ctx.repo._imports[0].next_attempt_at = Date.now() - 1;
  assert.equal((await pass(ctx)).outcome.status, "IMPORTED");
});

test("a permanent error stops retrying for good", async () => {
  const ctx = await makeMeetingService({ firefliesClient: fakeFireflies([ffError("NOT_FOUND")]) });
  await request(ctx);
  assert.equal((await pass(ctx)).outcome.status, "NOT_FOUND");
  ctx.repo._imports[0].next_attempt_at = 0;
  assert.equal(await pass(ctx), null);
  assert.equal(ctx.firefliesClient.calls.length, 1);
});

test("retries stop after the maximum number of attempts", async () => {
  const ctx = await makeMeetingService({ firefliesClient: fakeFireflies([ffError("RATE_LIMITED", { retryable: true })]) });
  await request(ctx);
  let last;
  for (let i = 0; i < 6; i += 1) {
    ctx.repo._imports[0].next_attempt_at = 0;
    const done = await pass(ctx);
    if (!done) break;
    last = done.outcome.status;
  }
  assert.equal(last, "FETCH_FAILED");
  assert.equal(ctx.firefliesClient.calls.length, ctx.config.fireflies.maxAttempts);
});

test("restart safety: a job left FETCHING by a crashed worker is requeued and then finished", async () => {
  const ctx = await makeMeetingService();
  await request(ctx);
  const crashed = await ctx.repo.claimNextImport("dead-worker"); // claimed, then the worker died: no outcome recorded
  assert.equal(crashed.attempts, 1);
  assert.equal(await pass(ctx), null, "still within the stale window, so nobody else touches it");

  ctx.repo._imports[0].locked_at = Date.now() - ctx.config.fireflies.staleMs - 10;
  const recovered = await pass(ctx);
  assert.equal(recovered.outcome.status, "IMPORTED");
  assert.equal(recovered.job.attempts, 2);
});

test("a job that keeps killing its worker is failed instead of looping forever", async () => {
  const ctx = await makeMeetingService();
  await request(ctx);
  for (let i = 0; i < ctx.config.fireflies.maxAttempts; i += 1) {
    ctx.repo._imports[0].next_attempt_at = 0;
    await ctx.repo.claimNextImport("dead-worker");
    ctx.repo._imports[0].locked_at = Date.now() - ctx.config.fireflies.staleMs - 10;
    await ctx.repo.recoverStale(ctx.config.fireflies.staleMs, ctx.config.fireflies.maxAttempts);
  }
  const row = ctx.repo._imports[0];
  assert.equal(row.status, "FETCH_FAILED");
  assert.equal(row.error_code, "IMPORT_FAILED");
  assert.equal(await pass(ctx), null);
});

test("processImport never throws, even if recording the outcome fails (the job is recovered later)", async () => {
  const ctx = await makeMeetingService({ firefliesClient: fakeFireflies([ffError("NOT_FOUND")]) });
  await request(ctx);
  const job = await ctx.repo.claimNextImport("w1");
  ctx.repo.finishImport = async () => { throw new Error("database is down"); };
  const outcome = await ctx.service.processImport(job);
  assert.equal(outcome.status, "UNRECORDED");
  assert.equal(ctx.repo._imports[0].status, "FETCHING", "left for recoverStale");
});

test("an import problem cannot stop the worker: every failure comes back as an outcome", async () => {
  const outcomes = [];
  for (const failure of [ffError("NOT_FOUND"), ffError("ACCESS_DENIED"), ffError("RATE_LIMITED", { retryable: true }), new Error("boom")]) {
    const ctx = await makeMeetingService({ firefliesClient: fakeFireflies([failure]) });
    await request(ctx);
    outcomes.push((await pass(ctx)).outcome.status);
  }
  assert.deepEqual(outcomes, ["NOT_FOUND", "ACCESS_DENIED", "RETRY", "RETRY"]);
});
