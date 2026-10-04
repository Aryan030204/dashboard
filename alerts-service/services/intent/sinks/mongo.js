// Storage sink for intent_sessions.*. Returns upsertedCount so the caller only
// advances the actor cursor when a new document was actually inserted.
function createMongoSink(models) {
  return {
    async upsertClick(doc) {
      const result = await models.ClickEvent.updateOne(
        { event_id: doc.event_id },
        { $setOnInsert: doc },
        { upsert: true },
      );
      return result.upsertedCount;
    },

    async upsertEvent(filter, doc) {
      const result = await models.Event.updateOne(
        filter,
        { $setOnInsert: doc },
        { upsert: true },
      );
      return result.upsertedCount;
    },
  };
}

module.exports = { createMongoSink };
