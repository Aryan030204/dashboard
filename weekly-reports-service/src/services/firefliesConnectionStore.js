const { httpError } = require("../errors");

// The Fireflies connection store. The rest of the service only sees this small interface:
//   get()          -> the stored connection (encrypted fields included) or null
//   save(fields)   -> creates or replaces the single common connection; returns { connection, created }
// so tests use an in-memory fake and the service needs no MongoDB to run.
const COMMON_KEY = "common";

function toRecord(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    account_email: doc.account_email || "",
    encrypted_api_key: doc.encrypted_api_key,
    encryption_iv: doc.encryption_iv,
    encryption_algorithm: doc.encryption_algorithm,
    status: doc.status,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

// Stand-in used when Mongo is not configured: every call answers a clear 503 instead of crashing.
function unavailableStore() {
  const fail = () => {
    const err = httpError(503, "MEETING_STORE_UNAVAILABLE", "Fireflies connection storage is not available.");
    err.storeUnavailable = true;
    throw err;
  };
  return { available: false, get: async () => fail(), save: async () => fail() };
}

function buildFirefliesConnectionStore({ config } = {}) {
  if (!config || !config.mongo || !config.mongo.uri) return unavailableStore();
  // Required here (not at the top) so the model and mongoose load only when Mongo is actually configured.
  const Model = require("../models/FirefliesConnection");
  const mongoose = require("mongoose");
  const ensureReady = () => {
    if (mongoose.connection.readyState !== 1) {
      const err = httpError(503, "MEETING_STORE_UNAVAILABLE", "Fireflies connection storage is not available.");
      err.storeUnavailable = true;
      throw err;
    }
  };
  return {
    available: true,
    async get() {
      ensureReady();
      return toRecord(await Model.findOne({ connection_key: COMMON_KEY }).lean());
    },
    async save({ account_email, encrypted_api_key, encryption_iv, encryption_algorithm, status = "ACTIVE" }) {
      ensureReady();
      const existing = await Model.findOne({ connection_key: COMMON_KEY }).select("_id").lean();
      const doc = await Model.findOneAndUpdate(
        { connection_key: COMMON_KEY },
        { $set: { account_email, encrypted_api_key, encryption_iv, encryption_algorithm, status } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();
      return { connection: toRecord(doc), created: !existing };
    },
  };
}

module.exports = { buildFirefliesConnectionStore, unavailableStore };
