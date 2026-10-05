const { normalizeIntentBody } = require("./normalize");
const { buildEventDoc, buildClickDoc } = require("./documents");
const { toStoreLocalOccurredAt } = require("./timezone");
const { withActorLock } = require("./actorLock");
const { createSessionState } = require("./sessionState");
const { createMongoSink } = require("./sinks/mongo");
const { enrichFromSlugCache, resolveProductId } = require("./productResolution");

// Pipeline order (matches the Sessions Pipeline):
//   validate + normalize (no lock, no I/O)
//   → lock(brand|actor_id)
//   → read cursor, resolve session timing
//   → slug enrichment (page_viewed) → product id
//   → insert event/click (upsert, $setOnInsert)
//   → if inserted: close previous session, write session_history, commit cursor
//   → unlock
//
// getModels is called once, on the first ingest, so the intent_sessions
// connection is only opened when mongo mode actually receives traffic.
function createIntentIngestor({
  getModels,
  getBrandTimezone,
  sessionTimeoutMs,
  negativeGapToleranceMs,
  logger,
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
      };
    }
    return wired;
  }

  // Returns { inserted, kind }. Throws IntentValidationError for bad input and
  // any other error for infrastructure failures.
  async function ingest(body, brand) {
    const parsed = normalizeIntentBody(body);
    const { kind, e, when, actorId } = parsed;
    const { models, sink, state } = wire();

    const run = async () => {
      const timing = await state.resolveSessionTiming(brand, actorId, when);
      const displayOccurredAt = toStoreLocalOccurredAt(when, getBrandTimezone(brand));

      if (kind === "click") {
        const doc = buildClickDoc({ brand, e, actorId, when, timing, displayOccurredAt });
        const upserted = await sink.upsertClick(doc);
        if (upserted > 0) {
          await state.commitSessionCursor(
            brand,
            actorId,
            timing,
            when,
            { collection: "click_events", event_id: e.event_id },
            doc,
          );
        }
        return { inserted: upserted > 0, kind };
      }

      await enrichFromSlugCache(models, brand, e);

      const sessionId = timing.session_id;
      const productId = resolveProductId(brand, sessionId, e);

      let doc;
      let upserted;
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
          {
            brand_id: brand,
            session_id: sessionId,
            event_name: e.event_name,
            "raw.product_id": productId,
          },
          doc,
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
        upserted = await sink.upsertEvent({ event_id: e.event_id }, doc);
      }

      if (upserted > 0) {
        await state.commitSessionCursor(
          brand,
          actorId,
          timing,
          when,
          { collection: "events", event_id: e.event_id },
          doc,
        );
      }
      return { inserted: upserted > 0, kind };
    };

    return actorId ? withActorLock(`${brand}|${actorId}`, run) : run();
  }

  return ingest;
}

module.exports = { createIntentIngestor };
