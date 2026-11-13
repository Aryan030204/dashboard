const { ensureLogger } = require("../logger");

// Fireflies GraphQL client. One request per import, always to this fixed endpoint (never to a user-supplied URL).
// Fields were checked against docs.fireflies.ai (Transcript and Summary schema pages): `summary.action_items` is a
// single String, `date` is epoch milliseconds, `participants` is a list of emails.
const FIREFLIES_GRAPHQL_URL = "https://api.fireflies.ai/graphql";

const TRANSCRIPT_QUERY = `query Transcript($id: String!) {
  transcript(id: $id) {
    id
    title
    date
    dateString
    organizer_email
    participants
    meeting_attendees { displayName email name }
    transcript_url
    summary { overview action_items }
  }
}`;

// kind: NOT_FOUND | ACCESS_DENIED | RATE_LIMITED | API_ERROR. `retryable` tells the import worker whether another
// attempt can help. The message is safe to store and show: it never contains the key, the request or the raw reply.
class FirefliesError extends Error {
  constructor(kind, message, { retryable = false, retryAfterMs = null, status = null, firefliesCode = null } = {}) {
    super(message);
    this.name = "FirefliesError";
    this.kind = kind;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
    this.firefliesCode = firefliesCode;
  }
}

const ACCESS_DENIED_CODES = new Set(["auth_failed", "forbidden", "not_in_team", "account_cancelled", "require_elevated_privilege", "paid_required"]);
const RETRYABLE_CODES = new Set(["request_timeout", "invariant_violation"]);

function firstError(body) {
  const err = body && Array.isArray(body.errors) ? body.errors[0] : null;
  if (!err) return null;
  const code = String(err.code || (err.extensions && err.extensions.code) || "").toLowerCase();
  return { code, extensions: err.extensions || {} };
}

function retryAfterFrom(res, parsedError) {
  const header = res && res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
  const seconds = Number(header);
  if (header && Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  // The error body carries the moment the limit lifts as epoch milliseconds.
  const at = Number(parsedError && parsedError.extensions && parsedError.extensions.metadata && parsedError.extensions.metadata.retryAfter);
  if (Number.isFinite(at) && at > 1e12) return Math.max(0, at - Date.now());
  return null;
}

function classify(res, body) {
  const status = res.status;
  const err = firstError(body);
  const code = err ? err.code : "";

  if (status === 429 || code === "too_many_requests") {
    return new FirefliesError("RATE_LIMITED", "Fireflies is rate limiting requests.", {
      retryable: true, retryAfterMs: retryAfterFrom(res, err), status, firefliesCode: code || null,
    });
  }
  if (code === "object_not_found" || status === 404) {
    return new FirefliesError("NOT_FOUND", "Fireflies could not find this meeting.", { status, firefliesCode: code || null });
  }
  if (ACCESS_DENIED_CODES.has(code) || status === 401 || status === 403) {
    return new FirefliesError("ACCESS_DENIED", "Fireflies refused access for the connected account.", { status, firefliesCode: code || null });
  }
  if (RETRYABLE_CODES.has(code) || status === 408 || status >= 500) {
    return new FirefliesError("API_ERROR", "Fireflies had a temporary problem.", { retryable: true, status, firefliesCode: code || null });
  }
  return new FirefliesError("API_ERROR", "Fireflies could not return this meeting.", { status, firefliesCode: code || null });
}

function toDate(transcript) {
  const epoch = Number(transcript.date);
  if (Number.isFinite(epoch) && epoch > 0) {
    const d = new Date(epoch);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (transcript.dateString) {
    const d = new Date(transcript.dateString);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function clean(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function toAttendees(transcript) {
  const out = [];
  const seen = new Set();
  const add = (name, email) => {
    const entry = { name: clean(name, 200), email: clean(email, 320) };
    if (!entry.name && !entry.email) return;
    const key = (entry.email || entry.name).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };
  for (const a of Array.isArray(transcript.meeting_attendees) ? transcript.meeting_attendees : []) {
    if (a) add(a.displayName || a.name, a.email);
  }
  for (const email of Array.isArray(transcript.participants) ? transcript.participants : []) add(null, email);
  return out.slice(0, 200);
}

// Only what Phase 1 needs: no transcript text, audio or video is ever requested.
function normalizeTranscript(transcript) {
  const summary = transcript.summary || {};
  return {
    transcriptId: String(transcript.id || ""),
    title: clean(transcript.title, 500) || "Untitled meeting",
    meetingDate: toDate(transcript),
    organizer: clean(transcript.organizer_email, 320),
    attendees: toAttendees(transcript),
    summary: clean(summary.overview, 20000),
    actionItemsText: typeof summary.action_items === "string" ? summary.action_items : null,
    transcriptUrl: clean(transcript.transcript_url, 1000),
  };
}

function buildFirefliesClient({ fetchImpl, timeoutMs = 15000, logger } = {}) {
  const log = ensureLogger(logger, "fireflies");
  const doFetch = fetchImpl || globalThis.fetch;

  return {
    // The plaintext key is only passed in for this call and only ever placed in the Authorization header.
    async fetchTranscript({ apiKey, transcriptId }) {
      if (typeof doFetch !== "function") throw new FirefliesError("API_ERROR", "No HTTP client is available.");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await doFetch(FIREFLIES_GRAPHQL_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query: TRANSCRIPT_QUERY, variables: { id: transcriptId } }),
          signal: controller.signal,
        });
      } catch (err) {
        const timedOut = err && err.name === "AbortError";
        log.warn("fireflies request failed before an answer", { transcript: transcriptId, timedOut });
        throw new FirefliesError("API_ERROR", timedOut ? "Fireflies did not answer in time." : "Fireflies could not be reached.", { retryable: true });
      } finally {
        clearTimeout(timer);
      }

      let body = null;
      try {
        body = await res.json();
      } catch (_err) {
        body = null;
      }

      const hasErrors = body && Array.isArray(body.errors) && body.errors.length > 0;
      if (!res.ok || hasErrors) {
        const failure = classify(res, body);
        log.warn("fireflies answered with an error", { transcript: transcriptId, status: res.status, kind: failure.kind, code: failure.firefliesCode, retryable: failure.retryable });
        throw failure;
      }
      const transcript = body && body.data && body.data.transcript;
      if (!transcript) {
        log.warn("fireflies returned no transcript", { transcript: transcriptId, status: res.status });
        throw new FirefliesError("NOT_FOUND", "Fireflies could not find this meeting.", { status: res.status });
      }
      return normalizeTranscript(transcript);
    },
  };
}

module.exports = { buildFirefliesClient, FirefliesError, FIREFLIES_GRAPHQL_URL, TRANSCRIPT_QUERY };
