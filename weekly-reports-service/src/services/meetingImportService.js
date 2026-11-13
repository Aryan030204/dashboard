const { httpError } = require("../errors");
const { ensureLogger, stopwatch } = require("../logger");
const { createAesCbc, CredentialCryptoError } = require("./aesCbc");
const { parseFirefliesUrl } = require("./firefliesUrl");
const { parseActionItems } = require("./actionItems");
const { FirefliesError } = require("./firefliesClient");

// The one place that knows how a Fireflies meeting gets into Datum. The HTTP routes call requestImport / the
// read methods; the worker calls processImport. A future Fireflies webhook should call requestImport too, so
// manual and automatic imports can never become two different systems.
//
// Import states: QUEUED -> FETCHING -> IMPORTED, or a failure state: NOT_FOUND, ACCESS_DENIED, DUPLICATE,
// FETCH_FAILED (INVALID_LINK exists in the enum; a bad link is refused up front with a 400 and creates no job).

const WORKER_ACTOR = "system:worker";

// Safe, stable text for what the user may see. Nothing from Fireflies' own reply is ever passed through.
const FAILURES = {
  NOT_FOUND: { status: "NOT_FOUND", code: "FIREFLIES_MEETING_NOT_FOUND", message: "Fireflies could not find this meeting, or the connected Fireflies account cannot see it." },
  ACCESS_DENIED: { status: "ACCESS_DENIED", code: "FIREFLIES_ACCESS_DENIED", message: "Fireflies refused access for the connected account. Ask an admin to check the Fireflies API key." },
  RATE_LIMITED: { status: "FETCH_FAILED", code: "FIREFLIES_RATE_LIMITED", message: "Fireflies is limiting requests right now. Try the import again later." },
  API_ERROR: { status: "FETCH_FAILED", code: "FIREFLIES_API_ERROR", message: "Fireflies could not return this meeting. Try again later." },
  NOT_CONFIGURED: { status: "FETCH_FAILED", code: "FIREFLIES_CONNECTION_NOT_CONFIGURED", message: "The Fireflies connection is not configured." },
  CREDENTIAL: { status: "FETCH_FAILED", code: "FIREFLIES_CREDENTIAL_UNREADABLE", message: "The stored Fireflies credential could not be read. Ask an admin to save the API key again." },
  ENCRYPTION: { status: "FETCH_FAILED", code: "FIREFLIES_ENCRYPTION_NOT_CONFIGURED", message: "Fireflies credential encryption is not configured on the server." },
  GENERIC: { status: "FETCH_FAILED", code: "IMPORT_FAILED", message: "The import failed. Try again later." },
};

function parseId(raw, code = "NOT_FOUND") {
  if (!/^\d{1,18}$/.test(String(raw))) throw httpError(404, code, "Not found.");
  return Number(raw);
}

// ---- DTOs: what leaves the service. No worker fields, no internal user ids, no storage or credential data. ----
function importDto(row) {
  return {
    id: Number(row.id),
    status: row.status,
    brand_key: row.brand_key,
    fireflies_transcript_id: row.fireflies_transcript_id,
    meeting_id: row.meeting_id === null || row.meeting_id === undefined ? null : Number(row.meeting_id),
    error_code: row.error_code || null,
    error_message: row.error_message || null,
    attempts: Number(row.attempts) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at || null,
  };
}

function pointerDto(p) {
  return {
    id: Number(p.id),
    source_key: p.source_key,
    original_text: p.original_text,
    refined_title: p.refined_title || null,
    refined_description: p.refined_description || null,
    assignee: p.assignee || null,
    due_date: p.due_date || null,
    priority: p.priority || null,
    category: p.category || null,
    labels: p.labels || null,
    review_state: p.review_state,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

function meetingDto(m, pointers) {
  return {
    id: Number(m.id),
    brand_key: m.brand_key,
    fireflies_transcript_id: m.fireflies_transcript_id,
    title: m.title,
    meeting_date: m.meeting_date || null,
    organizer: m.organizer || null,
    attendees: m.attendees || [],
    summary: m.summary || null,
    source_url: m.source_url || null,
    created_at: m.created_at,
    pointers: pointers.map(pointerDto),
  };
}

function integrationDto(record) {
  return {
    configured: Boolean(record),
    status: record ? record.status : "NOT_CONFIGURED",
    account_email: record ? record.account_email || null : null,
    updated_at: record ? record.updated_at || null : null,
  };
}

function buildMeetingImportService({ config, repo, connections, firefliesClient, audit, logger, random = Math.random }) {
  const log = ensureLogger(logger, "meeting-import");
  const A = audit.ACTIONS;
  const settings = config.fireflies;

  // The AES key comes from the server environment; a missing or malformed key disables only this feature.
  function aes() {
    try {
      return createAesCbc(settings.encryptionKey);
    } catch (err) {
      if (err instanceof CredentialCryptoError) {
        log.error("the Fireflies encryption key is missing or invalid (FIREFLIES_API_KEY_ENCRYPTION_KEY)", { code: err.code });
        throw httpError(503, "FIREFLIES_ENCRYPTION_NOT_CONFIGURED", "Fireflies credential encryption is not configured on the server.");
      }
      throw err;
    }
  }

  // ---- Fireflies connection (common account) ----------------------------------------------------
  async function getIntegration() {
    return integrationDto(await connections.get());
  }

  async function saveIntegration({ principal, apiKey, accountEmail }) {
    const cipher = aes();
    const { ciphertext, iv } = cipher.encrypt(apiKey); // the plaintext key goes no further than this line
    const { connection, created } = await connections.save({
      account_email: accountEmail || "",
      encrypted_api_key: ciphertext,
      encryption_iv: iv,
      encryption_algorithm: cipher.algorithm,
      status: "ACTIVE",
    });
    log.info(created ? "fireflies connection created" : "fireflies connection updated", { user: principal.user_id, brand: principal.brand_key });
    await audit.record({
      brandKey: principal.brand_key,
      actor: principal.user_id,
      action: created ? A.FIREFLIES_CONFIGURATION_CREATED : A.FIREFLIES_CONFIGURATION_UPDATED,
      entityType: "fireflies_connection",
      entityId: connection.id,
      after: { account_email: connection.account_email || null, status: connection.status },
    });
    return integrationDto(connection);
  }

  // ---- request side (HTTP) ----------------------------------------------------------------------
  async function requestImport({ principal, brandKey, firefliesUrl }) {
    const brand = principal.brand_key;
    if (String(brandKey || "").toUpperCase() !== brand) {
      throw httpError(400, "BRAND_MISMATCH", "The brand in the request does not match the current brand.");
    }
    const { transcriptId, sourceUrl } = parseFirefliesUrl(firefliesUrl);

    const record = await connections.get();
    if (!record || record.status !== "ACTIVE") {
      throw httpError(503, "FIREFLIES_CONNECTION_NOT_CONFIGURED", "The Fireflies connection is not configured yet. Ask an admin to add the Fireflies API key.");
    }

    const existing = await repo.findMeetingByTranscript(brand, transcriptId);
    if (existing) {
      log.info("import refused: the brand already has this meeting", { brand, transcript: transcriptId, meeting: Number(existing.id) });
      await audit.record({
        brandKey: brand, actor: principal.user_id, action: A.DUPLICATE_DETECTED, entityType: "meeting_record",
        entityId: existing.id, after: { fireflies_transcript_id: transcriptId },
      });
      const err = httpError(409, "DUPLICATE_MEETING", "This meeting has already been imported for this brand.");
      err.details = { meeting_id: Number(existing.id) };
      throw err;
    }

    let created;
    try {
      created = await repo.createImport({ brandKey: brand, transcriptId, sourceUrl, requestedBy: principal.user_id });
    } catch (err) {
      if (err && err.code === "DUPLICATE_MEETING") {
        await audit.record({
          brandKey: brand, actor: principal.user_id, action: A.DUPLICATE_DETECTED, entityType: "meeting_import",
          entityId: err.importId, after: { fireflies_transcript_id: transcriptId },
        });
        err.details = { import_id: err.importId };
      }
      throw err;
    }
    log.info("import queued", { brand, import: created.id, transcript: transcriptId, user: principal.user_id });
    await audit.record({
      brandKey: brand, actor: principal.user_id, action: A.IMPORT_REQUESTED, entityType: "meeting_import",
      entityId: created.id, after: { fireflies_transcript_id: transcriptId },
    });
    return { import_id: created.id, status: "QUEUED", brand_key: brand, fireflies_transcript_id: transcriptId };
  }

  async function getImport({ principal, id }) {
    const row = await repo.findImport(parseId(id, "IMPORT_NOT_FOUND"), principal.brand_key);
    if (!row) throw httpError(404, "IMPORT_NOT_FOUND", "Import not found.");
    return importDto(row);
  }

  async function getMeeting({ principal, id }) {
    const brand = principal.brand_key;
    const meeting = await repo.findMeeting(parseId(id, "MEETING_NOT_FOUND"), brand);
    if (!meeting) throw httpError(404, "MEETING_NOT_FOUND", "Meeting not found.");
    return meetingDto(meeting, await repo.listPointers(meeting.id, brand));
  }

  // ---- worker side ------------------------------------------------------------------------------
  function backoffMs(attempt, retryAfterMs) {
    const exponential = Math.min(settings.retryMaxMs, settings.retryBaseMs * 2 ** Math.max(0, attempt - 1));
    const jittered = Math.round(exponential * (0.8 + random() * 0.4));
    return Math.max(jittered, retryAfterMs || 0);
  }

  // Retryable problems go back to the queue with exponential backoff until the attempts are used up; permanent
  // problems end the import at once. Either way the reason shown to the user is one of the safe messages above.
  async function failOrRetry(job, failure, { retryable = false, retryAfterMs = null } = {}) {
    if (retryable && job.attempts < settings.maxAttempts) {
      const delayMs = backoffMs(job.attempts, retryAfterMs);
      await repo.scheduleRetry(job.id, job.brandKey, { delayMs, code: failure.code, message: failure.message });
      log.warn("import will be retried", { import: job.id, brand: job.brandKey, attempt: job.attempts, of: settings.maxAttempts, delayMs, code: failure.code });
      return { status: "RETRY", delayMs, code: failure.code };
    }
    await repo.finishImport(job.id, job.brandKey, { status: failure.status, code: failure.code, message: failure.message });
    log.warn("import failed", { import: job.id, brand: job.brandKey, status: failure.status, code: failure.code, attempts: job.attempts });
    await audit.record({
      brandKey: job.brandKey, actor: WORKER_ACTOR, action: A.IMPORT_FAILED, entityType: "meeting_import", entityId: job.id,
      after: { status: failure.status, code: failure.code, attempts: job.attempts },
    });
    return { status: failure.status, code: failure.code };
  }

  // Runs one claimed import. Never throws: whatever goes wrong is recorded on the job (or left FETCHING, in which
  // case the stale-job recovery picks it up), so the worker loop and the report conversions are never affected.
  async function processImport(job) {
    const elapsed = stopwatch();
    const ctx = { import: job.id, brand: job.brandKey, transcript: job.transcriptId, attempt: job.attempts };
    try {
      log.info("import started", ctx);
      await audit.record({
        brandKey: job.brandKey, actor: WORKER_ACTOR, action: A.IMPORT_STARTED, entityType: "meeting_import", entityId: job.id,
        after: { attempt: job.attempts },
      });

      const record = await connections.get();
      if (!record || record.status !== "ACTIVE") return await failOrRetry(job, FAILURES.NOT_CONFIGURED);

      let apiKey;
      try {
        apiKey = aes().decrypt(record.encrypted_api_key, record.encryption_iv);
      } catch (err) {
        const failure = err && err.code === "FIREFLIES_ENCRYPTION_NOT_CONFIGURED" ? FAILURES.ENCRYPTION : FAILURES.CREDENTIAL;
        return await failOrRetry(job, failure);
      }

      let meeting;
      try {
        meeting = await firefliesClient.fetchTranscript({ apiKey, transcriptId: job.transcriptId });
      } finally {
        apiKey = null; // the plaintext key only lived for this call
      }

      const pointers = parseActionItems(meeting.actionItemsText);
      const result = await repo.completeImport({
        importId: job.id,
        brandKey: job.brandKey,
        connectionId: record.id,
        importedBy: job.requestedBy,
        meeting: { ...meeting, transcriptId: job.transcriptId, sourceUrl: job.sourceUrl },
        pointers,
      });

      if (result.duplicate) {
        await repo.finishImport(job.id, job.brandKey, {
          status: "DUPLICATE", code: "DUPLICATE_MEETING", message: "This meeting has already been imported for this brand.", meetingId: result.meetingId,
        });
        log.info("import ended as a duplicate", { ...ctx, meeting: result.meetingId });
        await audit.record({
          brandKey: job.brandKey, actor: WORKER_ACTOR, action: A.DUPLICATE_DETECTED, entityType: "meeting_import", entityId: job.id,
          after: { meeting_id: result.meetingId },
        });
        return { status: "DUPLICATE", meetingId: result.meetingId };
      }

      log.info("import finished", { ...ctx, meeting: result.meetingId, pointers: pointers.length, ms: elapsed() });
      await audit.record({
        brandKey: job.brandKey, actor: WORKER_ACTOR, action: A.IMPORT_SUCCEEDED, entityType: "meeting_import", entityId: job.id,
        after: { meeting_id: result.meetingId, pointers: pointers.length },
      });
      return { status: "IMPORTED", meetingId: result.meetingId, pointers: pointers.length };
    } catch (err) {
      try {
        if (err && err.lostClaim) {
          log.warn("import was taken over or changed while it ran: leaving it as it is", ctx);
          return { status: "SKIPPED" };
        }
        if (err instanceof FirefliesError) {
          const failure = FAILURES[err.kind] || FAILURES.API_ERROR;
          return await failOrRetry(job, failure, { retryable: err.retryable, retryAfterMs: err.retryAfterMs });
        }
        // Mongo down, MySQL hiccup, a bug: logged in full (no secrets are ever in these errors), retried, then failed.
        log.error("import failed unexpectedly", { ...ctx, error: err });
        return await failOrRetry(job, FAILURES.GENERIC, { retryable: true });
      } catch (inner) {
        // Even recording the failure failed: the job stays FETCHING and recoverStale will deal with it.
        log.error("could not record the import outcome (the job will be recovered later)", { ...ctx, error: inner });
        return { status: "UNRECORDED" };
      }
    }
  }

  return { getIntegration, saveIntegration, requestImport, getImport, getMeeting, processImport, backoffMs };
}

module.exports = { buildMeetingImportService, importDto, meetingDto, pointerDto, integrationDto, FAILURES };
