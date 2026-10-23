// Chunked uploads: the browser reaches this service through a Vercel function that rejects request
// bodies over ~4.5 MB, so decks are sent in small chunks and assembled on the server.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const { buildUploadSessions } = require("../src/services/uploadSessions");
const { makeApp, author, client, gatewayHeaders, validPptx, macroPptx, fakeStorage } = require("./helpers");

const CHUNK = 64; // tiny, so small test files still need several chunks

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(300, 0x41), Buffer.from("\n%%EOF\n")]);

// A fresh temp folder per test so "nothing left behind" can be asserted exactly.
function setup(extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wr-chunk-test-"));
  const stored = new Map();
  const storage = { ...fakeStorage(), async putFile(key, filePath) { stored.set(key, fs.readFileSync(filePath)); } };
  const config = { uploadChunkBytes: CHUNK, uploadTmpDir: tmp, ...extra };
  const ctx = makeApp({ config, storage });
  const leftovers = () => fs.readdirSync(tmp).filter((n) => n.startsWith("wr-upload-"));
  return { ...ctx, tmp, stored, leftovers, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

const start = (ctx, body, headers = author("BBB")) => request(ctx.app).post("/weekly-reports/uploads").set(headers).send(body);
const put = (ctx, id, index, buf, headers = author("BBB")) =>
  request(ctx.app).put(`/weekly-reports/uploads/${id}/chunks/${index}`).set(headers).set("Content-Type", "application/octet-stream").send(buf);
const complete = (ctx, id, headers = author("BBB")) => request(ctx.app).post(`/weekly-reports/uploads/${id}/complete`).set(headers);

const slices = (buf) => {
  const out = [];
  for (let i = 0; i < buf.length; i += CHUNK) out.push(buf.subarray(i, i + CHUNK));
  return out;
};

async function sendAll(ctx, buf, name, fields = {}) {
  const begin = await start(ctx, { filename: name, size: buf.length, title: fields.title ?? "Quarterly Deck", reporting_week: fields.week ?? "Week 43" });
  assert.equal(begin.status, 201, JSON.stringify(begin.body));
  const chunks = slices(buf);
  for (let i = 0; i < chunks.length; i += 1) {
    const res = await put(ctx, begin.body.upload_id, i, chunks[i]);
    assert.equal(res.status, 200, `chunk ${i}: ${JSON.stringify(res.body)}`);
  }
  return begin.body;
}

// ---- the happy path ----------------------------------------------------------------------------
test("a deck sent in chunks is assembled, validated and stored exactly like a normal upload", async () => {
  const ctx = setup();
  const file = validPptx();
  assert.ok(file.length > CHUNK, "the fixture must need more than one chunk");

  const begin = await sendAll(ctx, file, "deck.pptx");
  assert.equal(begin.chunk_size, CHUNK);
  assert.equal(begin.total_chunks, Math.ceil(file.length / CHUNK));

  const res = await complete(ctx, begin.upload_id);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.equal(res.body.status, "PROCESSING");
  assert.equal(res.body.brand_key, "BBB");
  assert.equal(res.body.source_type, "pptx");
  assert.equal(res.body.title, "Quarterly Deck");
  assert.equal(res.body.reporting_week, "Week 43");

  const key = [...ctx.stored.keys()][0];
  assert.match(key, /^BBB\/\d+\/source\/presentation\.pptx$/);
  assert.ok(ctx.stored.get(key).equals(file), "the stored file is byte-for-byte what was sent");
  assert.deepEqual(ctx.leftovers(), [], "the temporary copy is removed after completion");
  assert.ok(ctx.audit.events.some((e) => e.action === "REPORT_UPLOADED"));
  ctx.done();
});

test("a PDF works through the same flow", async () => {
  const ctx = setup();
  const begin = await sendAll(ctx, PDF, "deck.pdf");
  const res = await complete(ctx, begin.upload_id);
  assert.equal(res.status, 202);
  assert.equal(res.body.source_type, "pdf");
  assert.ok([...ctx.stored.values()][0].equals(PDF));
  ctx.done();
});

test("a file that fits in one chunk still works", async () => {
  const ctx = setup({ uploadChunkBytes: 1024 * 1024 });
  const file = validPptx();
  const begin = await start(ctx, { filename: "small.pptx", size: file.length, title: "Tiny", reporting_week: "Week 1" });
  assert.equal(begin.body.total_chunks, 1);
  assert.equal((await put(ctx, begin.body.upload_id, 0, file)).status, 200);
  assert.equal((await complete(ctx, begin.body.upload_id)).status, 202);
  ctx.done();
});

test("duplicate-title handling applies to chunked uploads too", async () => {
  const ctx = setup();
  const first = await sendAll(ctx, validPptx(), "a.pptx", { title: "Same Name" });
  await complete(ctx, first.upload_id);
  const second = await sendAll(ctx, validPptx(), "b.pptx", { title: "Same Name" });
  const res = await complete(ctx, second.upload_id);
  assert.equal(res.body.title, "Same Name (1)");
  assert.equal(res.body.title_adjusted, true);
  ctx.done();
});

// ---- a misbehaving or unlucky client -------------------------------------------------------------
test("chunks must arrive in order; the error says which one is expected, and the upload can still finish", async () => {
  const ctx = setup();
  const file = validPptx();
  const chunks = slices(file);
  const begin = await start(ctx, { filename: "d.pptx", size: file.length, title: "T", reporting_week: "W" });
  const id = begin.body.upload_id;

  const skipped = await put(ctx, id, 1, chunks[1]);
  assert.equal(skipped.status, 409);
  assert.equal(skipped.body.code, "CHUNK_OUT_OF_ORDER");
  assert.match(skipped.body.error, /Expected chunk 0/);

  for (let i = 0; i < chunks.length; i += 1) assert.equal((await put(ctx, id, i, chunks[i])).status, 200);
  assert.equal((await complete(ctx, id)).status, 202);
  ctx.done();
});

test("re-sending the chunk that was just accepted is acknowledged and does not corrupt the file", async () => {
  const ctx = setup();
  const file = validPptx();
  const chunks = slices(file);
  const begin = await start(ctx, { filename: "d.pptx", size: file.length, title: "T", reporting_week: "W" });
  const id = begin.body.upload_id;

  assert.equal((await put(ctx, id, 0, chunks[0])).status, 200);
  const again = await put(ctx, id, 0, chunks[0]); // the first answer "got lost", so the browser retries
  assert.equal(again.status, 200);
  assert.equal(again.body.next_index, 1);
  const conflict = await put(ctx, id, 0, Buffer.alloc(chunks[0].length, 0x7a)); // same index, different bytes
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "CHUNK_CONFLICT");

  for (let i = 1; i < chunks.length; i += 1) await put(ctx, id, i, chunks[i]);
  assert.equal((await complete(ctx, id)).status, 202);
  assert.ok([...ctx.stored.values()][0].equals(file), "assembled once, in order, with no duplicate bytes");
  ctx.done();
});

test("chunk sizes are checked: a short middle chunk, a wrong last chunk and an empty chunk are refused", async () => {
  const ctx = setup();
  const file = validPptx();
  const chunks = slices(file);
  const begin = await start(ctx, { filename: "d.pptx", size: file.length, title: "T", reporting_week: "W" });
  const id = begin.body.upload_id;

  const short = await put(ctx, id, 0, chunks[0].subarray(0, CHUNK - 1));
  assert.equal(short.status, 400);
  assert.equal(short.body.code, "BAD_CHUNK_SIZE");
  assert.equal((await put(ctx, id, 0, Buffer.alloc(0))).status, 400);

  for (let i = 0; i < chunks.length - 1; i += 1) await put(ctx, id, i, chunks[i]);
  const last = chunks.length - 1;
  assert.equal((await put(ctx, id, last, Buffer.concat([chunks[last], Buffer.from("extra")]))).status, 400, "more than was declared");
  assert.equal((await put(ctx, id, last, chunks[last])).status, 200);
  ctx.done();
});

test("a chunk larger than the allowed size is refused before it is buffered", async () => {
  const ctx = setup();
  const file = validPptx();
  const begin = await start(ctx, { filename: "d.pptx", size: file.length, title: "T", reporting_week: "W" });
  const res = await put(ctx, begin.body.upload_id, 0, Buffer.alloc(CHUNK * 10));
  assert.equal(res.status, 413);
  assert.equal(res.body.code, "PAYLOAD_TOO_LARGE");
  ctx.done();
});

test("completing early is refused (409) and the upload can be finished afterwards", async () => {
  const ctx = setup();
  const file = validPptx();
  const chunks = slices(file);
  const begin = await start(ctx, { filename: "d.pptx", size: file.length, title: "T", reporting_week: "W" });
  const id = begin.body.upload_id;

  await put(ctx, id, 0, chunks[0]);
  const early = await complete(ctx, id);
  assert.equal(early.status, 409);
  assert.equal(early.body.code, "INCOMPLETE_UPLOAD");
  assert.equal(ctx.repo._reports.length, 0, "nothing was created from a partial file");

  for (let i = 1; i < chunks.length; i += 1) await put(ctx, id, i, chunks[i]);
  assert.equal((await complete(ctx, id)).status, 202);
  ctx.done();
});

// ---- the same checks as a normal upload -----------------------------------------------------------
test("starting an upload checks the declared file: type, size and the form fields", async () => {
  const ctx = setup();
  const ok = { filename: "d.pptx", size: 100, title: "T", reporting_week: "W" };

  const wrongType = await start(ctx, { ...ok, filename: "notes.docx" });
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.body.error, "Only .pptx, .ppt or .pdf files are supported.");

  const tooBig = await start(ctx, { ...ok, size: 51 * 1024 * 1024 });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.code, "FILE_TOO_LARGE");

  assert.equal((await start(ctx, { ...ok, size: 0 })).status, 400);
  assert.equal((await start(ctx, { ...ok, title: "" })).status, 400);
  assert.equal((await start(ctx, { ...ok, reporting_week: "" })).status, 400);
  assert.equal((await start(ctx, { ...ok, size: "100" })).status, 400, "size must be a number");
  assert.deepEqual(ctx.leftovers(), [], "a refused start leaves nothing on disk");
  ctx.done();
});

test("the real content is still checked at the end: junk, macro files and wrong types are rejected and cleaned up", async () => {
  const cases = [
    ["junk named .pptx", Buffer.alloc(300, 0x41), "deck.pptx", 415, "UNSUPPORTED_FILE_TYPE"],
    ["macro-enabled pptx", macroPptx(), "deck.pptx", 415, "MACRO_ENABLED_NOT_ALLOWED"],
    ["text named .pdf", Buffer.alloc(300, 0x41), "deck.pdf", 415, "UNSUPPORTED_FILE_TYPE"],
  ];
  for (const [label, buf, name, status, code] of cases) {
    const ctx = setup();
    const begin = await sendAll(ctx, buf, name);
    const res = await complete(ctx, begin.upload_id);
    assert.equal(res.status, status, label);
    assert.equal(res.body.code, code, label);
    assert.equal(ctx.repo._reports.length, 0, `${label}: nothing created`);
    assert.equal(ctx.stored.size, 0, `${label}: nothing stored`);
    assert.deepEqual(ctx.leftovers(), [], `${label}: temporary file removed`);
    ctx.done();
  }
});

test("if storing the source in S3 fails the upload ends FAILED, the caller gets 503 and the temp copy is removed", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wr-chunk-test-"));
  const ctx = makeApp({ config: { uploadChunkBytes: CHUNK, uploadTmpDir: tmp }, storage: fakeStorage({ failPut: true }) });
  const begin = await sendAll(ctx, validPptx(), "deck.pptx");
  const res = await complete(ctx, begin.upload_id);
  assert.equal(res.status, 503);
  assert.equal(ctx.repo._reports[0].status, "FAILED");
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith("wr-upload-")), []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- who may do what ------------------------------------------------------------------------------
test("only elevated users can use any of the upload endpoints", async () => {
  const ctx = setup();
  const c = client("BBB");
  assert.equal((await start(ctx, { filename: "d.pptx", size: 10, title: "T", reporting_week: "W" }, c)).status, 403);
  assert.equal((await put(ctx, "abc", 0, Buffer.from("x"), c)).status, 403);
  assert.equal((await complete(ctx, "abc", c)).status, 403);
  assert.equal((await request(ctx.app).delete("/weekly-reports/uploads/abc").set(c)).status, 403);
  const allScope = gatewayHeaders({ brand: "BBB", role: "viewer", permissions: ["all"] });
  assert.equal((await start(ctx, { filename: "d.pptx", size: 10, title: "T", reporting_week: "W" }, allScope)).status, 403);
  assert.equal((await request(ctx.app).post("/weekly-reports/uploads").send({})).status, 401, "unsigned requests are refused");
  ctx.done();
});

test("an upload belongs to the brand and user that started it; anyone else just gets 'not found'", async () => {
  const ctx = setup();
  const file = validPptx();
  const begin = await start(ctx, { filename: "d.pptx", size: file.length, title: "T", reporting_week: "W" });
  const id = begin.body.upload_id;
  const chunk = slices(file)[0];

  const otherBrand = author("PTS");
  const otherUser = author("BBB", { userId: "someone-else" });
  for (const who of [otherBrand, otherUser]) {
    assert.equal((await put(ctx, id, 0, chunk, who)).status, 404);
    assert.equal((await complete(ctx, id, who)).status, 404);
    assert.equal((await request(ctx.app).delete(`/weekly-reports/uploads/${id}`).set(who)).status, 404);
  }
  assert.equal((await put(ctx, id, 0, chunk)).status, 200, "the owner is unaffected");
  assert.equal((await put(ctx, "0".repeat(32), 0, chunk)).status, 404, "an unknown id looks the same");
  ctx.done();
});

test("a brand in the body or query that differs from the signed brand is refused", async () => {
  const ctx = setup();
  const body = { filename: "d.pptx", size: 100, title: "T", reporting_week: "W" };
  assert.equal((await start(ctx, { ...body, brand_key: "PTS" })).status, 400);
  const res = await request(ctx.app).post("/weekly-reports/uploads?brand_key=PTS").set(author("BBB")).send(body);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "BRAND_MISMATCH");
  ctx.done();
});

// ---- cancel, limits, expiry -----------------------------------------------------------------------
test("cancelling removes what was received and the upload id stops working", async () => {
  const ctx = setup();
  const file = validPptx();
  const chunks = slices(file);
  const begin = await start(ctx, { filename: "d.pptx", size: file.length, title: "T", reporting_week: "W" });
  const id = begin.body.upload_id;
  await put(ctx, id, 0, chunks[0]);
  assert.equal(ctx.leftovers().length, 1);

  assert.equal((await request(ctx.app).delete(`/weekly-reports/uploads/${id}`).set(author("BBB"))).status, 204);
  assert.deepEqual(ctx.leftovers(), []);
  assert.equal((await put(ctx, id, 1, chunks[1])).status, 404);
  assert.equal((await complete(ctx, id)).status, 404);
  ctx.done();
});

test("a user can only have a few uploads in progress at once", async () => {
  const ctx = setup({ maxUploadSessionsPerUser: 2 });
  const body = { filename: "d.pptx", size: 100, title: "T", reporting_week: "W" };
  const a = await start(ctx, body);
  await start(ctx, body);
  const third = await start(ctx, body);
  assert.equal(third.status, 429);
  assert.equal(third.body.code, "TOO_MANY_UPLOADS");
  assert.equal((await start(ctx, body, author("BBB", { userId: "another-admin" }))).status, 201, "limits are per user");
  await request(ctx.app).delete(`/weekly-reports/uploads/${a.body.upload_id}`).set(author("BBB"));
  assert.equal((await start(ctx, body)).status, 201, "cancelling frees a slot");
  ctx.done();
});

test("an idle upload expires and its folder is deleted", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wr-chunk-test-"));
  let clock = 1_000_000;
  const config = { uploadChunkBytes: CHUNK, uploadTmpDir: tmp, uploadSessionTtlMs: 60_000, maxUploadSessionsPerUser: 3, maxUploadSessions: 20, maxUploadBytes: 50 * 1024 * 1024 };
  const sessions = buildUploadSessions({ config, now: () => clock });
  const ctx = makeApp({ config, sessions });

  const begin = await start(ctx, { filename: "d.pptx", size: 100, title: "T", reporting_week: "W" });
  assert.equal(fs.readdirSync(tmp).length, 1);

  clock += 30_000;
  assert.equal(await sessions.sweep(), 0, "still fresh");
  clock += 31_000;
  assert.equal(await sessions.sweep(), 1, "idle for more than the TTL");
  assert.deepEqual(fs.readdirSync(tmp), []);
  assert.equal((await put(ctx, begin.body.upload_id, 0, Buffer.alloc(CHUNK))).status, 404);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("activity keeps an upload alive, and folders left behind by a previous run are cleaned up", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wr-chunk-test-"));
  let clock = Date.now();
  const config = { uploadChunkBytes: CHUNK, uploadTmpDir: tmp, uploadSessionTtlMs: 60_000, maxUploadSessionsPerUser: 3, maxUploadSessions: 20, maxUploadBytes: 50 * 1024 * 1024 };
  const sessions = buildUploadSessions({ config, now: () => clock });
  const ctx = makeApp({ config, sessions });

  const file = validPptx();
  const chunks = slices(file);
  const begin = await start(ctx, { filename: "d.pptx", size: file.length, title: "T", reporting_week: "W" });
  for (let i = 0; i < chunks.length; i += 1) {
    clock += 45_000; // each chunk arrives within the TTL of the previous one, though the total exceeds it
    assert.equal((await put(ctx, begin.body.upload_id, i, chunks[i])).status, 200);
    await sessions.sweep();
  }
  assert.equal((await complete(ctx, begin.body.upload_id)).status, 202);

  // A folder from a crashed run: old, with no session in memory.
  const stale = path.join(tmp, "wr-upload-stale");
  fs.mkdirSync(stale);
  const old = new Date(clock - 10 * 60_000);
  fs.utimesSync(stale, old, old);
  clock += 120_000;
  fs.mkdirSync(path.join(tmp, "unrelated-folder"));
  assert.equal(await sessions.cleanupOrphans(), 1);
  assert.ok(!fs.existsSync(stale));
  assert.ok(fs.existsSync(path.join(tmp, "unrelated-folder")), "only wr-upload-* folders are touched");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("malformed JSON is a 400, not a server error", async () => {
  const ctx = setup();
  const res = await request(ctx.app).post("/weekly-reports/uploads").set(author("BBB")).set("Content-Type", "application/json").send("{ not json");
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_JSON");
  ctx.done();
});

test("the old single-request multipart upload still works", async () => {
  const ctx = setup();
  const res = await request(ctx.app)
    .post("/weekly-reports")
    .set(author("BBB"))
    .field("title", "Old Way")
    .field("reporting_week", "Week 9")
    .attach("file", validPptx(), "deck.pptx");
  assert.equal(res.status, 202);
  assert.equal(res.body.title, "Old Way");
  ctx.done();
});
