// The /meeting-pointers HTTP API: permissions, brand isolation, the Fireflies key never returned, asynchronous import.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const {
  API_KEY, GOOD_URL, GOOD_ID, manager, viewer, nobody, superAdmin, plainAuthor, integrationOnly, allOnly,
  makeMeetingApp,
} = require("./meetingHelpers");
const { gatewayHeaders, author } = require("./helpers");

const importBody = (extra = {}) => ({ fireflies_url: GOOD_URL, brand_key: "BBB", ...extra });
const post = (ctx, path, headers, body) => request(ctx.app).post(`/meeting-pointers${path}`).set(headers).send(body);
const get = (ctx, path, headers) => request(ctx.app).get(`/meeting-pointers${path}`).set(headers);

async function importAndRun(ctx, brand = "BBB") {
  const res = await post(ctx, "/import", manager(brand), importBody({ brand_key: brand }));
  assert.equal(res.status, 202, JSON.stringify(res.body));
  const job = await ctx.repo.claimNextImport("w1");
  await ctx.service.processImport(job);
  return res.body.import_id;
}

// ---- import: permissions and shape ---------------------------------------------------------------
test("a user with meeting_pointers_manage queues an import and gets 202 immediately (no Fireflies call)", async () => {
  const ctx = await makeMeetingApp();
  const res = await post(ctx, "/import", manager(), importBody());
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual(res.body, { import_id: 1, status: "QUEUED", brand_key: "BBB", fireflies_transcript_id: GOOD_ID });
  assert.equal(ctx.firefliesClient.calls.length, 0, "the HTTP request never waits on Fireflies");
});

test("authors (elevated, 'all' permission) can import; camelCase body names are accepted too", async () => {
  const ctx = await makeMeetingApp();
  assert.equal((await post(ctx, "/import", plainAuthor(), importBody())).status, 202);
  const ctx2 = await makeMeetingApp();
  assert.equal((await post(ctx2, "/import", author("BBB"), { firefliesUrl: GOOD_URL, brandKey: "BBB" })).status, 202);
});

test("import needs meeting_pointers_manage: view-only, unrelated and anonymous callers are refused", async () => {
  const ctx = await makeMeetingApp();
  assert.equal((await post(ctx, "/import", viewer(), importBody())).status, 403);
  assert.equal((await post(ctx, "/import", nobody(), importBody())).status, 403);
  assert.equal((await post(ctx, "/import", integrationOnly(), importBody())).status, 403);
  assert.equal((await request(ctx.app).post("/meeting-pointers/import").send(importBody())).status, 401);
  const forged = { ...manager(), "x-gw-sig": "0".repeat(64) };
  assert.equal((await post(ctx, "/import", forged, importBody())).status, 401);
  assert.equal(ctx.repo._imports.length, 0);
});

test("the target brand is required and must equal the signed brand", async () => {
  const ctx = await makeMeetingApp();
  const missing = await post(ctx, "/import", manager("BBB"), { fireflies_url: GOOD_URL });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "VALIDATION_ERROR");
  const other = await post(ctx, "/import", manager("BBB"), importBody({ brand_key: "PTS" }));
  assert.equal(other.status, 400);
  assert.equal(other.body.code, "BRAND_MISMATCH");
  const viaQuery = await request(ctx.app).post("/meeting-pointers/import?brand_key=PTS").set(manager("BBB")).send(importBody());
  assert.equal(viaQuery.status, 400);
  assert.equal(viaQuery.body.code, "BRAND_MISMATCH");
  assert.equal((await post(ctx, "/import", manager("BBB"), importBody({ brand_key: "bbb" }))).status, 202, "case does not matter");
  assert.equal(ctx.repo._imports.length, 1);
  assert.equal(ctx.repo._imports[0].brand_key, "BBB");
});

test("brand A cannot import into brand B, even with brand B's permissions header spoofed in the body", async () => {
  const ctx = await makeMeetingApp();
  const res = await post(ctx, "/import", manager("PTS"), { ...importBody({ brand_key: "BBB" }), brand_id: "BBB" });
  assert.equal(res.status, 400);
  assert.equal(ctx.repo._imports.length, 0);
});

test("invalid links, missing fields and wrong types are refused with a clear 400", async () => {
  const ctx = await makeMeetingApp();
  const bad = await post(ctx, "/import", manager(), importBody({ fireflies_url: "https://evil.com/view/" + GOOD_ID }));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "INVALID_FIREFLIES_URL");
  assert.equal((await post(ctx, "/import", manager(), { brand_key: "BBB" })).status, 400);
  assert.equal((await post(ctx, "/import", manager(), importBody({ fireflies_url: 123 }))).status, 400);
  assert.equal((await post(ctx, "/import", manager(), importBody({ fireflies_url: "" }))).status, 400);
  assert.equal(ctx.repo._imports.length, 0);
});

test("importing before the Fireflies connection exists answers 503 FIREFLIES_CONNECTION_NOT_CONFIGURED", async () => {
  const ctx = await makeMeetingApp({ connected: false });
  const res = await post(ctx, "/import", manager(), importBody());
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "FIREFLIES_CONNECTION_NOT_CONFIGURED");
});

test("a duplicate answers 409 DUPLICATE_MEETING and names the existing import or meeting", async () => {
  const ctx = await makeMeetingApp();
  const first = await post(ctx, "/import", manager(), importBody());
  const running = await post(ctx, "/import", manager(), importBody());
  assert.equal(running.status, 409);
  assert.equal(running.body.code, "DUPLICATE_MEETING");
  assert.equal(running.body.import_id, first.body.import_id);

  const job = await ctx.repo.claimNextImport("w");
  await ctx.service.processImport(job);
  const done = await post(ctx, "/import", manager(), importBody());
  assert.equal(done.status, 409);
  assert.equal(done.body.meeting_id, ctx.repo._meetings[0].id);
});

// ---- status and read -----------------------------------------------------------------------------
test("import status shows progress and the final meeting id, without internal fields", async () => {
  const ctx = await makeMeetingApp();
  const queued = await post(ctx, "/import", manager(), importBody());
  const before = await get(ctx, `/imports/${queued.body.import_id}`, manager());
  assert.equal(before.status, 200);
  assert.equal(before.body.status, "QUEUED");
  assert.equal(before.body.meeting_id, null);

  const job = await ctx.repo.claimNextImport("w");
  await ctx.service.processImport(job);
  const after = await get(ctx, `/imports/${queued.body.import_id}`, manager());
  assert.equal(after.body.status, "IMPORTED");
  assert.ok(after.body.meeting_id);
  assert.equal(after.body.error_code, null);
  for (const key of ["locked_by", "locked_at", "requested_by", "stack"]) assert.ok(!(key in after.body));
});

test("a failed import reports a stable code and a safe message (no stack, no Fireflies text)", async () => {
  const { fakeFireflies, ffError } = require("./meetingHelpers");
  const ctx = await makeMeetingApp({ firefliesClient: fakeFireflies([ffError("ACCESS_DENIED")]) });
  const id = await importAndRun(ctx);
  const res = await get(ctx, `/imports/${id}`, manager());
  assert.equal(res.body.status, "ACCESS_DENIED");
  assert.equal(res.body.error_code, "FIREFLIES_ACCESS_DENIED");
  assert.ok(res.body.error_message);
  assert.ok(!/stack|at |\.js/i.test(JSON.stringify(res.body)));
});

test("meeting_pointers_view reads a meeting with its raw pointers; the status endpoint needs manage", async () => {
  const ctx = await makeMeetingApp();
  const importId = await importAndRun(ctx);
  const meetingId = ctx.repo._meetings[0].id;

  const read = await get(ctx, `/meetings/${meetingId}`, viewer());
  assert.equal(read.status, 200);
  assert.equal(read.body.title, "Weekly Sync");
  assert.equal(read.body.pointers.length, 2);
  assert.equal(read.body.pointers[0].original_text, "Follow up with the client about pricing");
  assert.ok(!("imported_by" in read.body));

  assert.equal((await get(ctx, `/meetings/${meetingId}`, nobody())).status, 403);
  assert.equal((await get(ctx, `/meetings/${meetingId}`, manager())).status, 403, "manage alone does not grant reading");
  assert.equal((await get(ctx, `/imports/${importId}`, viewer())).status, 403);
});

// ---- tenant isolation ----------------------------------------------------------------------------
test("brand B cannot see brand A's meeting or import: both answer 404, as if they did not exist", async () => {
  const ctx = await makeMeetingApp();
  const importId = await importAndRun(ctx, "BBB");
  const meetingId = ctx.repo._meetings[0].id;

  for (const headers of [viewer("PTS"), plainAuthor("PTS"), superAdmin("PTS")]) {
    const res = await get(ctx, `/meetings/${meetingId}`, headers);
    assert.equal(res.status, 404);
    assert.ok(!JSON.stringify(res.body).includes("Weekly Sync"));
  }
  for (const headers of [manager("PTS"), plainAuthor("PTS")]) assert.equal((await get(ctx, `/imports/${importId}`, headers)).status, 404);
  assert.equal((await get(ctx, `/meetings/${meetingId}`, viewer("BBB"))).status, 200);
});

test("cross-brand ids cannot be guessed or smuggled in: odd ids are plain 404s and a brand query must match", async () => {
  const ctx = await makeMeetingApp();
  const importId = await importAndRun(ctx, "BBB");
  const meetingId = ctx.repo._meetings[0].id;
  for (const bad of ["abc", "1;2", "-1", "0x10", "99999999999999999999999"]) {
    assert.equal((await get(ctx, `/meetings/${bad}`, viewer("BBB"))).status, 404, bad);
    assert.equal((await get(ctx, `/imports/${bad}`, manager("BBB"))).status, 404, bad);
  }
  const smuggled = await request(ctx.app).get(`/meeting-pointers/meetings/${meetingId}?brand_key=BBB`).set(viewer("PTS"));
  assert.equal(smuggled.status, 400, "asking for BBB while signed in as PTS is rejected");
  assert.equal((await request(ctx.app).get(`/meeting-pointers/imports/${importId}?brand_id=BBB`).set(manager("PTS"))).status, 400);
});

test("the same meeting imported by two brands stays separate", async () => {
  const ctx = await makeMeetingApp();
  await importAndRun(ctx, "BBB");
  await importAndRun(ctx, "PTS");
  assert.equal(ctx.repo._meetings.length, 2);
  const [a, b] = ctx.repo._meetings;
  assert.equal((await get(ctx, `/meetings/${a.id}`, viewer("BBB"))).status, 200);
  assert.equal((await get(ctx, `/meetings/${a.id}`, viewer("PTS"))).status, 404);
  assert.equal((await get(ctx, `/meetings/${b.id}`, viewer("PTS"))).status, 200);
});

// ---- the Fireflies connection ---------------------------------------------------------------------
test("only admin/super_admin or an explicit meeting_integration_manage can read or save the Fireflies connection", async () => {
  const ctx = await makeMeetingApp({ connected: false });
  const body = { api_key: API_KEY, account_email: "ops@example.com" };
  // not allowed: authors (even with the gateway's "all"), "all" alone, manage/view holders, unrelated users
  for (const headers of [plainAuthor(), allOnly(), manager(), viewer(), nobody()]) {
    assert.equal((await get(ctx, "/integrations/fireflies", headers)).status, 403);
    assert.equal((await post(ctx, "/integrations/fireflies", headers, body)).status, 403);
  }
  assert.equal(ctx.connections.state.record, null, "nothing stored by refused callers");
  // allowed
  assert.equal((await post(ctx, "/integrations/fireflies", superAdmin(), body)).status, 200);
  assert.equal((await get(ctx, "/integrations/fireflies", integrationOnly())).status, 200);
});

test("saving the key encrypts it; the API never returns, echoes or stores it in plaintext", async () => {
  const ctx = await makeMeetingApp({ connected: false });
  const before = await get(ctx, "/integrations/fireflies", superAdmin());
  assert.deepEqual(before.body, { configured: false, status: "NOT_CONFIGURED", account_email: null, updated_at: null });

  const saved = await post(ctx, "/integrations/fireflies", superAdmin(), { api_key: API_KEY, account_email: "ops@example.com" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.configured, true);
  assert.equal(saved.body.status, "ACTIVE");
  assert.equal(saved.body.account_email, "ops@example.com");
  assert.ok(!JSON.stringify(saved.body).includes(API_KEY));

  const read = await get(ctx, "/integrations/fireflies", integrationOnly());
  assert.equal(read.body.configured, true);
  for (const key of ["api_key", "encrypted_api_key", "encryption_iv", "plaintext_api_key", "apiKey"]) assert.ok(!(key in read.body), `no ${key} in the response`);
  assert.ok(!JSON.stringify(read.body).includes(API_KEY));

  const stored = ctx.connections.state.record;
  assert.equal(stored.encryption_algorithm, "AES-256-CBC");
  assert.notEqual(stored.encrypted_api_key, API_KEY);
  assert.ok(!JSON.stringify(stored).includes(API_KEY));
  assert.ok(!JSON.stringify(ctx.audit.events).includes(API_KEY));
  assert.deepEqual(ctx.audit.events.map((e) => e.action), ["FIREFLIES_CONFIGURATION_CREATED"]);
});

test("validation errors for the key never echo what was submitted", async () => {
  const ctx = await makeMeetingApp({ connected: false });
  // Distinctive values, so "the response contains it" can only mean the value was echoed back.
  const withSpaces = "has spaces ZQX-secret-value";
  const tooShort = "zq-7x9";
  const badEmail = "not-an-email-QWV";
  for (const body of [{ api_key: withSpaces }, { api_key: tooShort }, {}, { api_key: 12345678 }, { api_key: API_KEY, account_email: badEmail }]) {
    const res = await post(ctx, "/integrations/fireflies", superAdmin(), body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const text = JSON.stringify(res.body);
    for (const echoed of ["ZQX-secret-value", tooShort, badEmail, API_KEY]) assert.ok(!text.includes(echoed), `the response must not echo ${echoed}`);
  }
  assert.equal(ctx.connections.state.record, null);
});

test("without a valid server-side AES key, saving is a 503 and nothing is stored", async () => {
  const ctx = await makeMeetingApp({ connected: false, fireflies: { encryptionKey: "not-a-valid-key" } });
  const res = await post(ctx, "/integrations/fireflies", superAdmin(), { api_key: API_KEY });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "FIREFLIES_ENCRYPTION_NOT_CONFIGURED");
  assert.equal(ctx.connections.state.record, null);
  assert.ok(!JSON.stringify(res.body).includes("not-a-valid-key"));
});

test("saving again replaces the single connection (no second account)", async () => {
  const ctx = await makeMeetingApp({ connected: false });
  await post(ctx, "/integrations/fireflies", superAdmin(), { api_key: "first-key-123456" });
  const first = ctx.connections.state.record.encrypted_api_key;
  await post(ctx, "/integrations/fireflies", superAdmin(), { api_key: "second-key-654321" });
  assert.notEqual(ctx.connections.state.record.encrypted_api_key, first);
  assert.equal(ctx.connections.state.saves, 2);
  assert.deepEqual(ctx.audit.events.map((e) => e.action), ["FIREFLIES_CONFIGURATION_CREATED", "FIREFLIES_CONFIGURATION_UPDATED"]);
});

test("when the connection store (MongoDB) is unavailable the API answers 503, not 500", async () => {
  const { httpError } = require("../src/errors");
  const broken = { available: false, get: async () => { throw httpError(503, "MEETING_STORE_UNAVAILABLE", "Fireflies connection storage is not available."); }, save: async () => { throw httpError(503, "MEETING_STORE_UNAVAILABLE", "x"); } };
  const ctx = await makeMeetingApp({ connections: broken, connected: false });
  assert.equal((await get(ctx, "/integrations/fireflies", superAdmin())).status, 503);
  const res = await post(ctx, "/import", manager(), importBody());
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "MEETING_STORE_UNAVAILABLE");
});

// ---- the rest of the service is unaffected --------------------------------------------------------
test("unknown /meeting-pointers paths are 404 and the Weekly Reports routes still work in the same app", async () => {
  const ctx = await makeMeetingApp();
  assert.equal((await get(ctx, "/nope", manager())).status, 404);
  assert.equal((await get(ctx, "/meetings", viewer())).status, 404, "there is no list endpoint in Phase 1");
  const weekly = await request(ctx.app).get("/weekly-reports").set(gatewayHeaders({ brand: "BBB", role: "author", userId: "author1" }));
  assert.equal(weekly.status, 200);
  assert.deepEqual(weekly.body, { reports: [] });
  assert.equal((await request(ctx.app).get("/health")).status, 200);
});

test("without the meetings service the /meeting-pointers routes do not exist and Weekly Reports behaves as before", async () => {
  const { makeApp } = require("./helpers");
  const { app } = makeApp();
  assert.equal((await request(app).get("/meeting-pointers/integrations/fireflies").set(superAdmin())).status, 404);
  assert.equal((await request(app).get("/weekly-reports").set(gatewayHeaders({ brand: "BBB", role: "author", userId: "a" }))).status, 200);
});
