const { ensureLogger } = require("../logger");

// MongoDB is used only for the Fireflies connection config (Meeting Pointers). It is optional: with no
// WR_MONGO_URI nothing connects, and a connection problem never stops the API or the conversion worker.
// mongoose is required lazily so the rest of the service (and its tests) do not need it.
async function connectMongo(config, logger) {
  const log = ensureLogger(logger, "mongo");
  if (!config.mongo || !config.mongo.uri) {
    log.info("WR_MONGO_URI is not set: Fireflies connection storage is unavailable (Weekly Reports is unaffected)");
    return null;
  }
  try {
    const mongoose = require("mongoose");
    await mongoose.connect(config.mongo.uri, { dbName: config.mongo.dbName, serverSelectionTimeoutMS: 8000 });
    // The URI can contain credentials, so only the database name is logged.
    log.info("connected to MongoDB", { db: config.mongo.dbName });
    return mongoose;
  } catch (err) {
    log.error("could not connect to MongoDB: Fireflies connection storage is unavailable", { db: config.mongo.dbName, error: { name: err && err.name, message: err && err.message && String(err.message).replace(/mongodb(\+srv)?:\/\/\S+/gi, "mongodb://[hidden]") } });
    return null;
  }
}

module.exports = { connectMongo };
