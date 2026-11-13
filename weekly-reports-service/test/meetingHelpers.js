// In-memory stand-ins for the Meeting Pointers dependencies, same contract as the real ones (method names, brand
// predicates, state rules). The real SQL is exercised in meetingRepo.mysql.test.js. Existing helpers.js is untouched.
const { httpError } = require("../src/errors");
const { buildApp } = require("../src/app");
const { createLogger } = require("../src/logger");
const { buildMeetingImportService } = require("../src/services/meetingImportService");
const { buildFirefliesClient, FirefliesError } = require("../src/services/firefliesClient");
const { MEETING_ACTIONS } = require("../src/services/meetingAudit");
const { baseConfig, gatewayHeaders, fakeRepo, fakeStorage, fakeAudit } = require("./helpers");

// A throwaway 32-byte test key (64 hex chars). Never a real secret.
const TEST_AES_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const API_KEY = "ff-test-api-key-AbCdEf123456";
const GOOD_URL = "https://app.fireflies.ai/view/Weekly-Sync::01HZXABCDEFGH1234567890AB";
const GOOD_ID = "01HZXABCDEFGH1234567890AB";

const manager = (brand = "BBB", extra = {}) => gatewayHeaders({ brand, role: "brand_user", userId: "mgr1", permissions: ["meeting_pointers_manage"], ...extra });
const viewer = (brand = "BBB", extra = {}) => gatewayHeaders({ brand, role: "viewer", userId: "view1", permissions: ["meeting_pointers_view"], ...extra });
const nobody = (brand = "BBB") => gatewayHeaders({ brand, role: "viewer", userId: "nobody", permissions: ["weekly_report_preview"] });
const superAdmin = (brand = "BBB") => gatewayHeaders({ brand, role: "super_admin", userId: "root1", permissions: ["all"] });
const plainAuthor = (brand = "BBB") => gatewayHeaders({ brand, role: "author", userId: "author1", permissions: ["all"] }); // the gateway gives elevated roles "all"
const integrationOnly = (brand = "BBB") => gatewayHeaders({ brand, role: "brand_user", userId: "int1", permissions: ["meeting_integration_manage"] });
const allOnly = (brand = "BBB") => gatewayHeaders({ brand, role: "brand_user", userId: "all1", permissions: ["all"] });

function fakeMeetingRepo() {
  const meetings = [];
  const pointers = [];
  const imports = [];
  let seq = 0;
  const repo = {
    _meetings: meetings, _pointers: pointers, _imports: imports,
    async findMeetingByTranscript(brand, tid) {
      const m = meetings.find((x) => x.brand_key === brand && x.fireflies_transcript_id === tid);
      return m ? { ...m } : null;
    },
    async findActiveImport(brand, tid) {
      const i = imports.find((x) => x.brand_key === brand && x.fireflies_transcript_id === tid && ["QUEUED", "FETCHING"].includes(x.status));
      return i ? { ...i } : null;
    },
    async createImport({ brandKey, transcriptId, sourceUrl, requestedBy }) {
      const active = await repo.findActiveImport(brandKey, transcriptId);
      if (active) {
        const err = httpError(409, "DUPLICATE_MEETING", "This meeting is already being imported.");
        err.importId = Number(active.id);
        throw err;
      }
      const row = {
        id: ++seq, brand_key: brandKey, fireflies_transcript_id: transcriptId, source_url: sourceUrl, status: "QUEUED",
        error_code: null, error_message: null, attempts: 0, next_attempt_at: 0, locked_at: null, locked_by: null,
        meeting_id: null, requested_by: requestedBy, created_at: new Date(), updated_at: new Date(), finished_at: null,
      };
      imports.push(row);
      return { id: row.id };
    },
    async findImport(id, brand) {
      const i = imports.find((x) => x.id === id && x.brand_key === brand);
      return i ? { ...i } : null;
    },
    async findMeeting(id, brand) {
      const m = meetings.find((x) => x.id === id && x.brand_key === brand);
      return m ? { ...m } : null;
    },
    async listPointers(meetingId, brand) {
      return pointers.filter((p) => p.meeting_id === meetingId && p.brand_key === brand).map((p) => ({ ...p }));
    },
    async claimNextImport(workerId) {
      const row = imports.find((x) => x.status === "QUEUED" && x.next_attempt_at <= Date.now());
      if (!row) return null;
      Object.assign(row, { status: "FETCHING", locked_at: Date.now(), locked_by: workerId, attempts: row.attempts + 1 });
      return { id: row.id, brandKey: row.brand_key, transcriptId: row.fireflies_transcript_id, sourceUrl: row.source_url, requestedBy: row.requested_by, attempts: row.attempts };
    },
    async completeImport({ importId, brandKey, connectionId, importedBy, meeting, pointers: items }) {
      const job = imports.find((x) => x.id === importId && x.brand_key === brandKey);
      const existing = meetings.find((m) => m.brand_key === brandKey && m.fireflies_transcript_id === meeting.transcriptId);
      if (existing) return { duplicate: true, meetingId: existing.id };
      if (!job || job.status !== "FETCHING") throw Object.assign(new Error("import is no longer being fetched"), { lostClaim: true });
      const row = {
        id: ++seq, brand_key: brandKey, fireflies_connection_id: connectionId, fireflies_transcript_id: meeting.transcriptId, title: meeting.title,
        meeting_date: meeting.meetingDate, organizer: meeting.organizer, attendees: meeting.attendees, summary: meeting.summary,
        source_url: meeting.sourceUrl, imported_by: importedBy, created_at: new Date(), updated_at: new Date(),
      };
      meetings.push(row);
      for (const p of items) {
        pointers.push({
          id: ++seq, brand_key: brandKey, meeting_id: row.id, source_key: p.sourceKey, original_text: p.originalText, refined_title: null,
          refined_description: null, assignee: null, due_date: null, priority: null, category: null, labels: null,
          review_state: "PENDING_REVIEW", created_at: new Date(), updated_at: new Date(),
        });
      }
      Object.assign(job, { status: "IMPORTED", meeting_id: row.id, error_code: null, error_message: null, locked_at: null, locked_by: null, finished_at: new Date() });
      return { meetingId: row.id };
    },
    async finishImport(id, brandKey, { status, code, message, meetingId = null }) {
      const j = imports.find((x) => x.id === id && x.brand_key === brandKey && x.status === "FETCHING");
      if (j) Object.assign(j, { status, error_code: code, error_message: message, meeting_id: meetingId, locked_at: null, locked_by: null, finished_at: new Date() });
    },
    async scheduleRetry(id, brandKey, { delayMs, code, message }) {
      const j = imports.find((x) => x.id === id && x.brand_key === brandKey && x.status === "FETCHING");
      if (j) Object.assign(j, { status: "QUEUED", error_code: code, error_message: message, locked_at: null, locked_by: null, next_attempt_at: Date.now() + delayMs });
    },
    async recoverStale(staleMs, maxAttempts) {
      let failed = 0;
      let requeued = 0;
      for (const j of imports) {
        if (j.status !== "FETCHING" || j.locked_at > Date.now() - staleMs) continue;
        if (j.attempts >= maxAttempts) {
          Object.assign(j, { status: "FETCH_FAILED", error_code: "IMPORT_FAILED", locked_at: null, locked_by: null, finished_at: new Date() });
          failed += 1;
        } else {
          Object.assign(j, { status: "QUEUED", locked_at: null, locked_by: null, next_attempt_at: 0 });
          requeued += 1;
        }
      }
      return { failed, requeued };
    },
  };
  return repo;
}

function fakeConnections() {
  const state = { record: null, saves: 0 };
  return {
    state,
    available: true,
    async get() {
      return state.record ? { ...state.record } : null;
    },
    async save(fields) {
      const created = !state.record;
      state.saves += 1;
      state.record = { id: "64b0c0ffee00000000000001", created_at: new Date(), ...state.record, ...fields, updated_at: new Date() };
      return { connection: { ...state.record }, created };
    },
  };
}

function fakeMeetingAudit() {
  const events = [];
  return { ACTIONS: MEETING_ACTIONS, events, async record(e) { events.push(e); } };
}

// A Fireflies client double: each call takes the next scripted outcome (a value to return, or an Error to throw).
function fakeFireflies(script = []) {
  const queue = [...script];
  const calls = [];
  return {
    calls,
    push: (...items) => queue.push(...items),
    async fetchTranscript(args) {
      calls.push(args);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(args) : next;
    },
  };
}

const sampleMeeting = (over = {}) => ({
  transcriptId: GOOD_ID,
  title: "Weekly Sync",
  meetingDate: new Date("2026-11-03T10:00:00Z"),
  organizer: "host@example.com",
  attendees: [{ name: "Alice", email: "alice@example.com" }],
  summary: "We talked about pricing.",
  actionItemsText: "- Follow up with the client about pricing\n- Send the updated deck",
  transcriptUrl: "https://app.fireflies.ai/view/x",
  ...over,
});

const ffError = (kind, opts = {}) => new FirefliesError(kind, `${kind} (test)`, opts);

// Service wired to fakes. `connected` seeds an encrypted-looking record by really saving a key through the service.
async function makeMeetingService(opts = {}) {
  const base = baseConfig();
  const config = {
    ...base,
    fireflies: { ...base.fireflies, encryptionKey: TEST_AES_KEY, maxAttempts: 3, retryBaseMs: 10, retryMaxMs: 1000, staleMs: 1000, ...(opts.fireflies || {}) },
  };
  const repo = opts.repo || fakeMeetingRepo();
  const connections = opts.connections || fakeConnections();
  const audit = opts.audit || fakeMeetingAudit();
  const firefliesClient = opts.firefliesClient || fakeFireflies([sampleMeeting()]);
  const lines = [];
  // Captures every log line. Under `node --test` the logger is silent unless WEEKLY_REPORTS_LOG_LEVEL is set, so a test
  // that inspects `lines` sets it itself (and restores it).
  const logger = createLogger("test", { sink: { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) } });
  const service = buildMeetingImportService({ config, repo, connections, firefliesClient, audit, logger, random: () => 0.5 });
  if (opts.connected !== false) {
    await service.saveIntegration({ principal: { user_id: "root1", brand_key: "BBB" }, apiKey: API_KEY, accountEmail: "ops@example.com" });
    audit.events.length = 0;
  }
  return { service, repo, connections, audit, firefliesClient, config, lines };
}

async function makeMeetingApp(opts = {}) {
  const ctx = await makeMeetingService(opts);
  const weekly = fakeRepo();
  const app = buildApp({
    config: ctx.config, repo: weekly, storage: fakeStorage(), audit: fakeAudit(), meetings: ctx.service,
  });
  return { ...ctx, app, weekly };
}

module.exports = {
  TEST_AES_KEY, API_KEY, GOOD_URL, GOOD_ID, manager, viewer, nobody, superAdmin, plainAuthor, integrationOnly, allOnly,
  fakeMeetingRepo, fakeConnections, fakeMeetingAudit, fakeFireflies, sampleMeeting, ffError, makeMeetingService, makeMeetingApp,
  buildFirefliesClient, FirefliesError,
};
