const { normalizeIntentBody } = require("./normalize");
const { buildEventDoc, buildClickDoc } = require("./documents");
const { toStoreLocalOccurredAt } = require("./timezone");
const { withActorLock } = require("./actorLock");
const { createSessionState } = require("./sessionState");
const { createMongoSink } = require("./sinks/mongo");
const { enrichFromSlugCache, resolveProductId } = require("./productResolution");
const {
  SCHEMA_VERSION,
  buildEventMessage,
  buildClickMessage,
  buildSessionSnapshotMessage,
  messageBytes,
} = require("./messageContract");

const SQS_MESSAGE_LIMIT_BYTES = 256 * 1024;

function outboxRow(message, at) {
  return {
    message_id: `${message.type}:${message.message_key}`,
    brand_id: message.brand_id,
    type: message.type,
    schema_version: SCHEMA_VERSION,
    payload: message,
    status: "pending",
    attempts: 0,
    created_at: at,
    updated_at: at,
  };
}

function tooLargeError(messageId, bytes, limit) {
  const err = new Error(`intent message ${messageId} is ${bytes} bytes, over the ${limit} byte limit`);
  err.status = 413;
  return err;
}

// Producer-side ingestion for SQS mode. Builds the same state as the Mongo path
// (same normalize, session timing, cursor, events/click_events, session_history,
// ATC dedupe index) and records the contract messages in intent_outbox, all in
// one Mongo transaction. Nothing is sent to SQS here; the relay does that later.
//
// Mongo transactions need a replica set (Atlas or a replica-set deployment).
function createOutboxIngestor({
  getModels,
  getBrandTimezone,
  sessionTimeoutMs,
  negativeGapToleranceMs,
  logger,
  startSession,
  now = () => new Date(),
  sqsMessageLimitBytes = SQS_MESSAGE_LIMIT_BYTES,
}) {
  let wired = null;

  function wire() {
    if (!wired) {
      const models = getModels();
      wired = {
        models,
        sink: createMongoSink(models),
        state: createSessionState({
          models,
          getBrandTimezone,
          sessionTimeoutMs,
          negativeGapToleranceMs,
          logger,
        }),
        openSession: startSession || (() => models.Event.db.startSession()),
      };
    }
    return wired;
  }

  async function attempt(session, brand, parsed) {
    const { kind, e, when, actorId } = parsed;
    const { models, sink, state } = wire();
    const opts = { session };

    const timing = await state.resolveSessionTiming(brand, actorId, when, opts);
    const displayOccurredAt = toStoreLocalOccurredAt(when, getBrandTimezone(brand));

    let doc;
    let upserted;
    let collection;
    let message;

    if (kind === "click") {
      doc = buildClickDoc({ brand, e, actorId, when, timing, displayOccurredAt });
      upserted = await sink.upsertClick(doc, opts);
      collection = "click_events";
      message = buildClickMessage(doc);
    } else {
      await enrichFromSlugCache(models, brand, e);
      const sessionId = timing.session_id;
      const productId = resolveProductId(brand, sessionId, e);

      if (e.event_name === "product_added_to_cart" && sessionId && productId) {
        doc = buildEventDoc({
          brand,
          e,
          sessionId,
          actorId,
          when,
          productIdOverride: productId,
          timing,
          displayOccurredAt,
        });
        upserted = await sink.upsertEvent(
          { brand_id: brand, session_id: sessionId, event_name: e.event_name, "raw.product_id": productId },
          doc,
          opts,
        );
      } else {
        doc = buildEventDoc({
          brand,
          e,
          sessionId,
          actorId,
          when,
          productIdOverride: null,
          timing,
          displayOccurredAt,
        });
        upserted = await sink.upsertEvent({ event_id: e.event_id }, doc, opts);
      }
      collection = "events";
      message = buildEventMessage(doc);
    }

    if (!upserted) {
      return { status: "duplicate", kind, event_id: e.event_id, outbox: [] };
    }

    const closed = await state.commitSessionCursor(
      brand,
      actorId,
      timing,
      when,
      { collection, event_id: e.event_id },
      doc,
      { ...opts, strict: true },
    );

    const messages = [message];
    if (closed) {
      messages.push(buildSessionSnapshotMessage(closed, { sourceUpdatedAt: now() }));
    }

    const at = now();
    const rows = messages.map((m) => {
      const row = outboxRow(m, at);
      const bytes = messageBytes(m);
      if (bytes > sqsMessageLimitBytes) throw tooLargeError(row.message_id, bytes, sqsMessageLimitBytes);
      return row;
    });
    await models.IntentOutbox.insertMany(rows, { session, ordered: true });

    return {
      status: "accepted",
      kind,
      event_id: e.event_id,
      outbox: rows.map((r) => r.message_id),
    };
  }

  async function ingest(body, brand) {
    const parsed = normalizeIntentBody(body);
    const { actorId } = parsed;
    const { openSession } = wire();

    const runInTransaction = async () => {
      const session = await openSession();
      try {
        return await session.withTransaction(() => attempt(session, brand, parsed));
      } finally {
        await session.endSession();
      }
    };

    return actorId ? withActorLock(`${brand}|${actorId}`, runInTransaction) : runInTransaction();
  }

  return ingest;
}

module.exports = { createOutboxIngestor, SQS_MESSAGE_LIMIT_BYTES };
