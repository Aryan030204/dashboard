const { encryptText } = require("../shared/utils/crypto");
const GoogleAdsCredential = require("../shared/db/models/GoogleAdsCredential.mongo");
const { resolveBrandRef } = require("../shared/db/models/Tenant.mongo");

// Google Ads connector for the P&L page: the merchant pastes their Google Ads
// customer id and a token, and it's stored (encrypted) against the brand in
// Mongo. Nothing here talks to Google — spend is pulled by the pipeline's
// Google Ads sync into the per-brand rollup table, and pnl.service reads
// that. So this service is storage only: save, status, delete.

const MAX_TOKEN_LENGTH = 4096;

function normalizeBrandKey(brandKey) {
  return String(brandKey || "").trim().toUpperCase();
}

function normalizeCustomerId(raw) {
  return String(raw || "").replace(/\D/g, "");
}

function maskToken(token) {
  const value = String(token || "");
  return value.length > 6 ? `…${value.slice(-6)}` : "…";
}

function toStatusShape(row) {
  if (!row) return { connected: false };
  return {
    connected: true,
    customerId: row.customer_id || null,
    loginCustomerId: row.login_customer_id || null,
    tokenSuffix: row.token_suffix || null,
    capturedAt: row.captured_at || null,
    updatedByEmail: row.updated_by_email || null,
    lastError: row.last_error || null,
  };
}

async function getStatus(brandKey) {
  const key = normalizeBrandKey(brandKey);
  if (!key) return toStatusShape(null);
  const row = await GoogleAdsCredential.findOne({ brand_id: key }).lean();
  return toStatusShape(row);
}

// Validates and stores what the merchant pasted. Replaces any previous token
// for the brand; the pipeline picks the new one up on its next sync.
async function saveCredentials({ brandKey, customerId, loginCustomerId, token, updatedByEmail }) {
  const key = normalizeBrandKey(brandKey);
  if (!key) throw new Error("brandKey is required");

  const customer = normalizeCustomerId(customerId);
  if (!customer) return { success: false, error: "customer_id is required (digits only, dashes optional)." };
  if (customer.length !== 10) return { success: false, error: "customer_id must be 10 digits, e.g. 123-456-7890." };

  const login = normalizeCustomerId(loginCustomerId);
  if (loginCustomerId && !login) return { success: false, error: "login_customer_id must be digits only." };

  const secret = String(token || "").trim();
  if (!secret) return { success: false, error: "token is required." };
  if (secret.length > MAX_TOKEN_LENGTH) return { success: false, error: "token is too long." };

  const row = await GoogleAdsCredential.findOneAndUpdate(
    { brand_id: key },
    {
      $set: {
        brand: await resolveBrandRef(key),
        brand_id: key,
        customer_id: customer,
        login_customer_id: login || null,
        token_encrypted: encryptText(secret),
        token_suffix: maskToken(secret),
        updated_by_email: updatedByEmail || null,
        captured_at: new Date(),
        last_error: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  return { success: true, status: toStatusShape(row) };
}

async function deleteCredentials(brandKey) {
  const key = normalizeBrandKey(brandKey);
  if (!key) return { success: false };
  await GoogleAdsCredential.deleteOne({ brand_id: key });
  return { success: true };
}

module.exports = {
  getStatus,
  saveCredentials,
  deleteCredentials,
  normalizeCustomerId,
  normalizeBrandKey,
};
