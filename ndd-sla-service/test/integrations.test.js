const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { selectGokwikMessage, extractAddress } = require("../src/integrations/gokwikMatcher");
const { buildGmailClient, buildRefreshTokenProvider } = require("../src/integrations/gmailClient");
const { buildEasycomClient, missingEasycomConfig } = require("../src/integrations/easycomClient");
const { toWall, wallToEpochMs, addHoursWall } = require("../src/lib/wall");
const { encryptText, decryptText } = require("../src/lib/crypto");
const { buildCredentials } = require("../src/services/credentials");

// ---- matcher ------------------------------------------------------------------------------------------------------
const rules = { sender: "Reports@GoKwik.test", subjectPattern: "^orders report", filenamePattern: "\\.csv$", pick: "first" };
const range = { fromWall: "2026-11-19 12:00:00", toWall: "2026-11-20 12:00:00" };
const msg = (over) => ({ id: "m", from: "GoKwik <reports@gokwik.test>", subject: "Orders Report 19 Nov", receivedMs: 1000, receivedWall: "2026-11-19 15:30:00", attachments: [{ id: "a", filename: "x.csv", size: 1 }], ...over });

test("matcher: sender (any case, with display name), subject regex, filename regex and time range must all match", () => {
  assert.equal(extractAddress("GoKwik <Reports@GoKwik.test>"), "reports@gokwik.test");
  assert.ok(selectGokwikMessage([msg()], rules, range));
  assert.equal(selectGokwikMessage([msg({ from: "evil@else.test" })], rules, range), null);
  assert.equal(selectGokwikMessage([msg({ subject: "Weekly digest" })], rules, range), null);
  assert.equal(selectGokwikMessage([msg({ attachments: [{ id: "a", filename: "x.pdf" }] })], rules, range), null);
  assert.equal(selectGokwikMessage([msg({ receivedWall: "2026-11-20 12:00:00" })], rules, range), null, "range end is exclusive");
  assert.equal(selectGokwikMessage([msg({ receivedWall: "2026-11-19 11:59:59" })], rules, range), null);
});

test("matcher: deterministic pick (first or latest, ties broken by id) and duplicates counted", () => {
  const a = msg({ id: "b", receivedMs: 5 });
  const b = msg({ id: "a", receivedMs: 5 });
  const c = msg({ id: "z", receivedMs: 9 });
  const first = selectGokwikMessage([c, a, b], rules, range);
  assert.equal(first.message.id, "a");
  assert.equal(first.duplicates, 2);
  assert.equal(selectGokwikMessage([a, b, c], { ...rules, pick: "latest" }, range).message.id, "z");
  assert.equal(selectGokwikMessage([a, b, c], rules, range).message.id, selectGokwikMessage([c, b, a], rules, range).message.id);
});

test("matcher: refuses to run with unconfigured sender/subject/filename and with an invalid regex", () => {
  assert.throws(() => selectGokwikMessage([], { sender: "", subjectPattern: "", filenamePattern: "" }, range), (e) => e.code === "GMAIL_CONFIG_MISSING");
  assert.throws(() => selectGokwikMessage([], { ...rules, subjectPattern: "(" }, range), (e) => e.code === "GMAIL_CONFIG_INVALID");
});

// ---- wall clock helpers -------------------------------------------------------------------------------------------
test("wall: IST conversions are independent of the host timezone and round-trip", () => {
  const ms = Date.UTC(2026, 10, 19, 6, 30, 0); // 12:00 IST
  assert.equal(toWall(ms, "Asia/Kolkata"), "2026-11-19 12:00:00");
  assert.equal(wallToEpochMs("2026-11-19 12:00:00", "Asia/Kolkata"), ms);
  assert.equal(toWall(Date.UTC(2026, 10, 19, 18, 30, 0), "Asia/Kolkata"), "2026-11-20 00:00:00"); // midnight rollover
  assert.equal(addHoursWall("2026-11-19 12:00:00", 24), "2026-11-20 12:00:00");
});

// ---- crypto / credentials -------------------------------------------------------------------------------------------
test("crypto: AES round trip with the shared key convention; wrong key fails; ciphertext differs per call", () => {
  const enc = encryptText("secret-token-1234", "k".repeat(32));
  assert.match(enc, /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.equal(decryptText(enc, "k".repeat(32)), "secret-token-1234");
  assert.notEqual(encryptText("secret-token-1234", "k".repeat(32)), enc);
  assert.throws(() => decryptText(enc, "x".repeat(32)));
});

test("credentials: stored encrypted, only the last 4 characters are kept in clear, and a missing one is a permanent error", async () => {
  const store = new Map();
  const pool = {
    async query(sql, args) {
      if (/^\s*INSERT/i.test(sql)) { store.set(`${args[0]}|${args[1]}`, { token_encrypted: args[2], token_suffix: args[3] }); return [{}]; }
      if (/^\s*SELECT token_encrypted/i.test(sql)) { const r = store.get(`${args[0]}|${args[1]}`); return [r ? [r] : []]; }
      return [[]];
    },
  };
  const creds = buildCredentials(pool, { aesKey: "k".repeat(32) });
  await creds.save("AJMAL", "EASYCOM", "tok_ABCDEFGH1234");
  const row = store.get("AJMAL|EASYCOM");
  assert.equal(row.token_suffix, "1234");
  assert.ok(!row.token_encrypted.includes("tok_ABCDEFGH"));
  assert.equal(await creds.getToken("AJMAL", "EASYCOM"), "tok_ABCDEFGH1234");
  await assert.rejects(creds.getToken("AJMAL", "GMAIL"), (e) => e.code === "GMAIL_CREDENTIAL_MISSING" && e.retryable === false);
  const wrongKey = buildCredentials(pool, { aesKey: "z".repeat(32) });
  await assert.rejects(wrongKey.getToken("AJMAL", "EASYCOM"), (e) => e.code === "EASYCOM_CREDENTIAL_UNREADABLE");
});

// ---- gmail client (mock HTTP) -------------------------------------------------------------------------------------
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Map() });

test("gmail client: lists messages, extracts nested attachments, and never sends a request without the bearer token", async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url: String(url), auth: opts.headers.Authorization });
    if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "m1" }] });
    return json({
      id: "m1", internalDate: "1763540000000",
      payload: { headers: [{ name: "From", value: "a@b.test" }, { name: "Subject", value: "Orders report" }],
        parts: [{ filename: "", parts: [{ filename: "o.csv", body: { attachmentId: "att9", size: 42 } }] }] },
    });
  };
  const client = buildGmailClient({ getAccessToken: async () => "TOKEN", fetchImpl });
  const out = await client.listCandidates({ sender: "a@b.test", afterEpochSec: 10, beforeEpochSec: 20 });
  assert.deepEqual(out[0].attachments, [{ id: "att9", filename: "o.csv", size: 42 }]);
  assert.equal(out[0].subject, "Orders report");
  assert.ok(seen.every((s) => s.auth === "Bearer TOKEN"));
  assert.match(seen[0].url, /after%3A10|after:10/);
});

test("gmail client: attachment goes to a file with its sha256, size limits are enforced, and errors are classified", async () => {
  const data = Buffer.from("a,b\n1,2\n");
  const fetchImpl = async () => json({ data: data.toString("base64url") });
  const client = buildGmailClient({ getAccessToken: async () => "T", fetchImpl });
  const dest = path.join(os.tmpdir(), `ndd-test-${process.pid}.csv`);
  const res = await client.downloadAttachment({ messageId: "m", attachmentId: "a", destPath: dest, maxBytes: 1000 });
  assert.equal(res.bytes, data.length);
  assert.equal(fs.readFileSync(dest, "utf8"), "a,b\n1,2\n");
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  fs.unlinkSync(dest);
  await assert.rejects(client.downloadAttachment({ messageId: "m", attachmentId: "a", destPath: dest, maxBytes: 3 }), (e) => e.code === "ATTACHMENT_TOO_LARGE");
  await assert.rejects(client.downloadAttachment({ messageId: "m", attachmentId: "a", destPath: dest, maxBytes: 3, expectedSize: 99 }), (e) => e.code === "ATTACHMENT_TOO_LARGE");

  const failing = (status) => buildGmailClient({ getAccessToken: async () => "T", fetchImpl: async () => json({}, status) });
  await assert.rejects(failing(401).listCandidates({ sender: "x", afterEpochSec: 1, beforeEpochSec: 2 }), (e) => e.code === "GMAIL_AUTH" && !e.retryable);
  await assert.rejects(failing(503).listCandidates({ sender: "x", afterEpochSec: 1, beforeEpochSec: 2 }), (e) => e.code === "GMAIL_UNAVAILABLE" && e.retryable);
});

test("gmail token provider: exchanges the refresh token once and caches the access token; missing OAuth client is a config error", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return json({ access_token: "AT", expires_in: 3600 }); };
  const get = buildRefreshTokenProvider({ getRefreshToken: async () => "RT", clientId: "id", clientSecret: "s", fetchImpl });
  assert.equal(await get(), "AT");
  assert.equal(await get(), "AT");
  assert.equal(calls, 1);
  await assert.rejects(buildRefreshTokenProvider({ getRefreshToken: async () => "RT", clientId: "", clientSecret: "" })(), (e) => e.code === "GMAIL_CONFIG_MISSING");
});

// ---- easycom client (mock HTTP) -----------------------------------------------------------------------------------
const ecConfig = (over = {}) => ({
  baseUrl: "https://easycom.test/api", endpoint: "shipments",
  auth: { mode: "header", headerName: "X-Key" },
  dateParams: { fromParam: "from", toParam: "to" },
  pagination: { mode: "page", pageSize: 2, pageSizeParam: "per", pageParam: "p", startPage: 1 },
  response: { itemsPath: "data.items" },
  fields: { reference: "ref", pickedAt: "meta.picked" },
  maxPages: 10, retries: 2, retryBaseMs: 1,
  ...over,
});
const collect = async (it) => { const out = []; for await (const p of it) out.push(p); return out; };

test("easycom: refuses to start until every unknown (URL, endpoint, auth, pagination, paths) is configured", () => {
  const missing = missingEasycomConfig({ baseUrl: "", endpoint: "", auth: {}, pagination: {}, response: {}, fields: {} });
  assert.ok(missing.includes("NDD_EASYCOM_BASE_URL") && missing.includes("NDD_EASYCOM_ENDPOINT") && missing.some((m) => /PAGINATION_MODE/.test(m)));
  assert.throws(() => buildEasycomClient({ config: { baseUrl: "" }, getToken: async () => "t" }), (e) => e.code === "EASYCOM_CONFIG_MISSING");
});

test("easycom page mode: walks pages until a short page, maps only the two configured fields, sends auth and date range", async () => {
  const pages = { 1: [{ ref: "A", meta: { picked: "x" }, junk: 1 }, { ref: "B" }], 2: [{ ref: "C", meta: { picked: "y" } }] };
  const urls = [];
  const fetchImpl = async (url, opts) => {
    urls.push({ u: new URL(url), key: opts.headers["X-Key"] });
    return json({ data: { items: pages[url.searchParams.get("p")] || [] } });
  };
  const client = buildEasycomClient({ config: ecConfig(), getToken: async () => "SECRET", fetchImpl });
  const out = await collect(client.fetchShipments({ from: "2026-11-18 12:00:00", to: "2026-11-19 15:00:00" }));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].items, [{ reference: "A", pickedAtRaw: "x" }, { reference: "B", pickedAtRaw: undefined }]);
  assert.ok(urls.every((x) => x.key === "SECRET"));
  assert.equal(urls[0].u.searchParams.get("from"), "2026-11-18 12:00:00");
  assert.equal(urls[0].u.searchParams.get("per"), "2");
  assert.equal(urls[1].u.searchParams.get("p"), "2");
});

test("easycom cursor and offset modes follow their own pagination rules", async () => {
  const cursorPages = { "": { d: [{ r: "A" }], next: "c2" }, c2: { d: [{ r: "B" }], next: null } };
  const cursorFetch = async (url) => json(cursorPages[url.searchParams.get("cur") || ""]);
  const cfgCursor = ecConfig({ auth: { mode: "none" }, pagination: { mode: "cursor", cursorParam: "cur", pageSize: 1 }, response: { itemsPath: "d", nextCursorPath: "next" }, fields: { reference: "r", pickedAt: "t" } });
  const got = await collect(buildEasycomClient({ config: cfgCursor, getToken: async () => "", fetchImpl: cursorFetch }).fetchShipments());
  assert.deepEqual(got.flatMap((p) => p.items.map((i) => i.reference)), ["A", "B"]);

  const offsets = [];
  const offsetFetch = async (url) => { const o = Number(url.searchParams.get("off")); offsets.push(o); return json({ d: o === 0 ? [{ r: "A" }, { r: "B" }] : [{ r: "C" }] }); };
  const cfgOff = ecConfig({ auth: { mode: "none" }, pagination: { mode: "offset", offsetParam: "off", pageSizeParam: "n", pageSize: 2 }, response: { itemsPath: "d" }, fields: { reference: "r", pickedAt: "t" } });
  await collect(buildEasycomClient({ config: cfgOff, getToken: async () => "", fetchImpl: offsetFetch }).fetchShipments());
  assert.deepEqual(offsets, [0, 2]);
});

test("easycom: transient errors are retried with backoff, auth errors are not, runaway pagination is cut off", async () => {
  let n = 0;
  const flaky = async () => { n += 1; return n < 3 ? json({}, 503) : json({ data: { items: [] } }); };
  await collect(buildEasycomClient({ config: ecConfig(), getToken: async () => "t", fetchImpl: flaky, sleepImpl: async () => {} }).fetchShipments());
  assert.equal(n, 3);

  let m = 0;
  const auth = async () => { m += 1; return json({}, 401); };
  await assert.rejects(collect(buildEasycomClient({ config: ecConfig(), getToken: async () => "t", fetchImpl: auth, sleepImpl: async () => {} }).fetchShipments()), (e) => e.code === "EASYCOM_AUTH" && !e.retryable);
  assert.equal(m, 1);

  const always503 = async () => json({}, 503);
  await assert.rejects(collect(buildEasycomClient({ config: ecConfig(), getToken: async () => "t", fetchImpl: always503, sleepImpl: async () => {} }).fetchShipments()), (e) => e.code === "EASYCOM_UNAVAILABLE" && e.retryable);

  const endless = async () => json({ data: { items: [{ ref: "A" }, { ref: "B" }] } });
  await assert.rejects(collect(buildEasycomClient({ config: ecConfig({ maxPages: 3 }), getToken: async () => "t", fetchImpl: endless }).fetchShipments()), (e) => e.code === "EASYCOM_TOO_MANY_PAGES");

  const wrongShape = async () => json({ nothing: true });
  await assert.rejects(collect(buildEasycomClient({ config: ecConfig(), getToken: async () => "t", fetchImpl: wrongShape }).fetchShipments()), (e) => e.code === "EASYCOM_BAD_RESPONSE");
});
