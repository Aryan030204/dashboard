const mongoose = require("mongoose");
const schemas = require("./schemas");

// Separate connection for intent_sessions. Kept apart from the default
// connection (`alerts`) so the existing Session model and alerts data are not
// touched. Created lazily, so SQS mode never opens it.
let intentConnection = null;
let intentModels = null;

function getIntentModels() {
  if (intentModels) return intentModels;

  const uri = process.env.INTENT_MONGO_URI;
  if (!uri) {
    throw new Error("INTENT_MONGO_URI is required when INTENT_EVENT_INGESTION=mongo");
  }

  intentConnection = mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 10,
  });

  intentModels = {
    Event: intentConnection.model("Event", schemas.eventSchema),
    ClickEvent: intentConnection.model("ClickEvent", schemas.clickEventSchema),
    ActorCursor: intentConnection.model("ActorCursor", schemas.actorCursorSchema),
    SessionHistory: intentConnection.model("SessionHistory", schemas.sessionHistorySchema),
    SlugCache: intentConnection.model("SlugCache", schemas.slugCacheSchema),
  };
  return intentModels;
}

module.exports = { getIntentModels };
