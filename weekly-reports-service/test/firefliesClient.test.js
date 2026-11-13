// The Fireflies GraphQL client: fixed endpoint, Bearer key only in the header, errors mapped to safe kinds.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFirefliesClient, FirefliesError, FIREFLIES_GRAPHQL_URL, TRANSCRIPT_QUERY } = require("../src/services/firefliesClient");
const { createLogger } = require("../src/logger");
const { API_KEY, GOOD_ID } = require("./meetingHelpers");

// Minimal Response look-alike.
function reply(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => headers[String(name).toLowerCase()] ?? null }, json: async () => { if (body === undefined) throw new Error("no json"); return body; } };
}

function clientWith(fetchImpl, extra = {}) {
  return buildFirefliesClient({ fetchImpl, timeoutMs: 50, ...extra });
}

const transcript = (over = {}) => ({
  id: GOOD_ID, title: "Weekly Sync", date: Date.UTC(2026, 10, 3, 10, 0, 0), dateString: "2026-11-03T10:00:00.000Z",
  organizer_email: "host@example.com", participants: ["alice@example.com", "bob@example.com"],
  meeting_attendees: [{ displayName: "Alice A", email: "alice@example.com", name: "Alice" }],
  transcript_url: "https://app.fireflies.ai/view/x", summary: { overview: "We talked.", action_items: "- Do the thing" }, ...over,
});

test("a successful call returns only the normalised fields Phase 1 needs", async () => {
  const seen = [];
  const client = clientWith(async (url, init) => { seen.push({ url, init }); return reply(200, { data: { transcript: transcript() } }); });
  const out = await client.fetchTranscript({ apiKey: API_KEY, transcriptId: GOOD_ID });
  assert.equal(out.transcriptId, GOOD_ID);
  assert.equal(out.title, "Weekly Sync");
  assert.equal(out.organizer, "host@example.com");
  assert.equal(out.meetingDate.toISOString(), "2026-11-03T10:00:00.000Z");
  assert.equal(out.actionItemsText, "- Do the thing");
  assert.equal(out.summary, "We talked.");
  assert.deepEqual(out.attendees.map((a) => a.email), ["alice@example.com", "bob@example.com"], "attendees and participants are merged without duplicates");
  assert.deepEqual(Object.keys(out).sort(), ["actionItemsText", "attendees", "meetingDate", "organizer", "summary", "title", "transcriptId", "transcriptUrl"]);
  assert.equal(seen.length, 1, "exactly one API request per import");
});

test("the request goes to the fixed endpoint, with the key only in the Authorization header", async () => {
  let captured;
  const client = clientWith(async (url, init) => { captured = { url, init }; return reply(200, { data: { transcript: transcript() } }); });
  await client.fetchTranscript({ apiKey: API_KEY, transcriptId: GOOD_ID });
  assert.equal(captured.url, "https://api.fireflies.ai/graphql");
  assert.equal(FIREFLIES_GRAPHQL_URL, "https://api.fireflies.ai/graphql");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.Authorization, `Bearer ${API_KEY}`);
  assert.ok(!captured.init.body.includes(API_KEY), "the key is not in the request body");
  assert.deepEqual(JSON.parse(captured.init.body).variables, { id: GOOD_ID });
});

test("the query asks only for what Phase 1 stores: no transcript text, audio or video", () => {
  for (const forbidden of ["sentences", "audio_url", "video_url", "speakers", "analytics"]) {
    assert.ok(!TRANSCRIPT_QUERY.includes(forbidden), `query must not request ${forbidden}`);
  }
  assert.ok(TRANSCRIPT_QUERY.includes("action_items"));
});

test("object_not_found and an empty transcript are NOT_FOUND (permanent)", async () => {
  const notFound = clientWith(async () => reply(200, { errors: [{ message: "Not found", code: "object_not_found", extensions: { code: "object_not_found", status: 404 } }] }));
  await assert.rejects(() => notFound.fetchTranscript({ apiKey: API_KEY, transcriptId: GOOD_ID }), (e) => e instanceof FirefliesError && e.kind === "NOT_FOUND" && e.retryable === false);
  const empty = clientWith(async () => reply(200, { data: { transcript: null } }));
  await assert.rejects(() => empty.fetchTranscript({ apiKey: API_KEY, transcriptId: GOOD_ID }), (e) => e.kind === "NOT_FOUND");
  const http404 = clientWith(async () => reply(404, {}));
  await assert.rejects(() => http404.fetchTranscript({ apiKey: API_KEY, transcriptId: GOOD_ID }), (e) => e.kind === "NOT_FOUND");
});

test("auth and permission problems are ACCESS_DENIED (permanent)", async () => {
  for (const [status, code] of [[401, "auth_failed"], [403, "forbidden"], [403, "not_in_team"], [403, "account_cancelled"], [403, "paid_required"], [403, "require_elevated_privilege"], [401, ""]]) {
    const client = clientWith(async () => reply(status, { errors: [{ message: "x", code }] }));
    await assert.rejects(() => client.fetchTranscript({ apiKey: API_KEY, transcriptId: GOOD_ID }), (e) => e.kind === "ACCESS_DENIED" && e.retryable === false, `${status} ${code}`);
  }
});

test("too_many_requests is RATE_LIMITED and retryable, honouring Retry-After (seconds)", async () => {
  const client = clientWith(async () => reply(429, { errors: [{ message: "slow down", code: "too_many_requests" }] }, { "retry-after": "12" }));
  await assert.rejects(() => client.fetchTranscript({ apiKey: API_KEY, transcriptId: GOOD_ID }), (e) => e.kind === "RATE_LIMITED" && e.retryable === true && e.retryAfterMs === 12000);
});

test("RATE_LIMITED falls back to the retryAfter moment (epoch ms) in the error body", async () => {
  const at = Date.now() + 20000;
  const client = clientWith(async () => reply(200, { errors: [{ message: "x", code: "too_many_requests", extensions: { code: "too_many_requests", metadata: { retryAfter: at } } }] }));
  await assert.rejects(() => client.fetchTranscript({ apiKey: API_KEY, transcriptId: GOOD_ID }), (e) => e.kind === "RATE_LIMITED" && e.retryAfterMs > 15000 && e.retryAfterMs <= 20000);
});

test("5xx, request_timeout and network failures are retryable API_ERROR", async () => {
  const cases = [
    clientWith(async () => reply(502, {})),
    clientWith(async () => reply(500, undefined)), // body is not JSON
    clientWith(async () => reply(200, { errors: [{ message: "x", code: "request_timeout" }] })),
    clientWith(async () => reply(200, { errors: [{ message: "x", code: "invariant_violation" }] })),
    clientWith(async () => { throw new TypeError("fetch failed"); }),
  ];
  for (const client of cases) {
    await assert.rejects(() => client.fetchTranscript({ apiKey: API_KEY, transcriptId: GOOD_ID }), (e) => e.kind === "API_ERROR" && e.retryable === true);
  }
});

test("a request that takes too long is aborted and is retryable", async () => {
  const client = clientWith((url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }));
  await assert.rejects(() => client.fetchTranscript({ apiKey: API_KEY, transcriptId: GOOD_ID }), (e) => e.kind === "API_ERROR" && e.retryable === true && /in time/.test(e.message));
});

test("other client errors (bad arguments) are permanent API_ERROR", async () => {
  const client = clientWith(async () => reply(400, { errors: [{ message: "bad", code: "invalid_arguments" }] }));
  await assert.rejects(() => client.fetchTranscript({ apiKey: API_KEY, transcriptId: GOOD_ID }), (e) => e.kind === "API_ERROR" && e.retryable === false);
});

test("error messages are fixed text: nothing from Fireflies' reply and never the key", async () => {
  const client = clientWith(async () => reply(200, { errors: [{ message: `leaky detail ${API_KEY} <script>`, code: "forbidden" }] }));
  await assert.rejects(() => client.fetchTranscript({ apiKey: API_KEY, transcriptId: GOOD_ID }), (e) => !e.message.includes("leaky") && !e.message.includes(API_KEY) && !JSON.stringify(e).includes(API_KEY));
});

test("the key and Fireflies' raw reply never reach the logs", async () => {
  const lines = [];
  const previous = process.env.WEEKLY_REPORTS_LOG_LEVEL;
  process.env.WEEKLY_REPORTS_LOG_LEVEL = "debug";
  try {
    const logger = createLogger("fireflies", { sink: { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) } });
    const bodies = [
      reply(200, { errors: [{ message: `secret ${API_KEY} body`, code: "forbidden" }] }),
      reply(429, { errors: [{ message: "x", code: "too_many_requests" }] }),
      reply(200, { data: { transcript: null } }),
    ];
    for (const body of bodies) {
      const client = clientWith(async () => body, { logger });
      await assert.rejects(() => client.fetchTranscript({ apiKey: API_KEY, transcriptId: GOOD_ID }));
    }
    const failing = clientWith(async () => { throw new Error(`connect failed for Bearer ${API_KEY}`); }, { logger });
    await assert.rejects(() => failing.fetchTranscript({ apiKey: API_KEY, transcriptId: GOOD_ID }));
  } finally {
    if (previous === undefined) delete process.env.WEEKLY_REPORTS_LOG_LEVEL;
    else process.env.WEEKLY_REPORTS_LOG_LEVEL = previous;
  }
  assert.ok(lines.length >= 4, "the failures were logged");
  const text = lines.join("\n");
  assert.ok(!text.includes(API_KEY), "the API key must not appear in any log line");
  assert.ok(!text.includes("Bearer"), "the Authorization header must not appear in any log line");
  assert.ok(!text.includes("secret"), "the raw Fireflies reply must not appear in any log line");
});
