const axios = require("axios");
const { sequelize } = require("../shared/db/mainSequelize");
const { encryptText, decryptText } = require("../shared/utils/crypto");
const MetaOauthLog = require("../shared/db/models/MetaOauthLog.mongo");
const { resolveBrandRef } = require("../shared/db/models/Tenant.mongo");

const MetaAdsCredential = sequelize.models.meta_ads_credentials;

function apiVersion() {
  return process.env.META_API_VERSION || "v21.0";
}

function normalizeAdAccountId(rawId) {
  const id = String(rawId || "").trim();
  return id.startsWith("act_") ? id : `act_${id}`;
}

// Verifies an ad account id + token pair actually works before we save it,
// so a brand gets immediate feedback instead of a silent failure later on
// the P&L page.
async function verifyToken(adAccountId, accessToken) {
  const url = `https://graph.facebook.com/${apiVersion()}/${normalizeAdAccountId(adAccountId)}`;
  try {
    await axios.get(url, {
      params: { fields: "id,name", access_token: accessToken },
      timeout: 10000,
    });
    return { valid: true };
  } catch (error) {
    const message = error.response?.data?.error?.message || error.message || "Verification failed";
    return { valid: false, error: message };
  }
}

// If a Meta developer app (META_APP_ID/META_APP_SECRET) is configured,
// exchange whatever token the brand pasted for a long-lived one (~60 days)
// via the app-level token exchange endpoint. System User tokens generated
// from Business Settings are already long-lived and Meta will reject the
// exchange for them — that's fine, we just keep the original token.
async function tryExchangeForLongLivedToken(accessToken) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) return { accessToken, expiresAt: null };

  try {
    const response = await axios.get(`https://graph.facebook.com/${apiVersion()}/oauth/access_token`, {
      params: {
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: accessToken,
      },
      timeout: 10000,
    });
    const { access_token: longLivedToken, expires_in: expiresIn } = response.data || {};
    if (!longLivedToken) return { accessToken, expiresAt: null };
    const expiresAt = expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000) : null;
    return { accessToken: longLivedToken, expiresAt };
  } catch {
    return { accessToken, expiresAt: null };
  }
}

async function saveCredentials({ brandKey, adAccountId, accessToken, updatedByEmail }) {
  if (!brandKey) throw new Error("brandKey is required");
  if (!adAccountId || !accessToken) {
    return { success: false, error: "Ad account ID and access token are both required." };
  }

  const verification = await verifyToken(adAccountId, accessToken);
  if (!verification.valid) {
    return { success: false, error: `Meta rejected these credentials: ${verification.error}` };
  }

  const exchanged = await tryExchangeForLongLivedToken(accessToken);

  await MetaAdsCredential.upsert({
    brand_key: brandKey,
    ad_account_id: normalizeAdAccountId(adAccountId),
    access_token_encrypted: encryptText(exchanged.accessToken),
    token_expires_at: exchanged.expiresAt,
    last_verified_at: new Date(),
    last_error: null,
    updated_by_email: updatedByEmail || null,
    updated_at: new Date(),
  });

  return { success: true };
}

async function getCredentials(brandKey) {
  if (!brandKey) return null;
  const row = await MetaAdsCredential.findOne({ where: { brand_key: brandKey } });
  if (!row) return null;
  return {
    adAccountId: row.ad_account_id,
    accessToken: decryptText(row.access_token_encrypted),
    expiresAt: row.token_expires_at,
  };
}

async function getStatus(brandKey) {
  if (!brandKey) return { connected: false };
  const row = await MetaAdsCredential.findOne({ where: { brand_key: brandKey } });
  if (!row) return { connected: false };
  return {
    connected: true,
    adAccountId: row.ad_account_id,
    expiresAt: row.token_expires_at,
    lastVerifiedAt: row.last_verified_at,
    lastError: row.last_error,
    updatedByEmail: row.updated_by_email,
    updatedAt: row.updated_at,
  };
}

// Records a live-call failure against the saved row (surfaced on the status
// endpoint) without touching the token itself.
async function recordError(brandKey, message) {
  if (!brandKey) return;
  await MetaAdsCredential.update(
    { last_error: String(message || "").slice(0, 500) },
    { where: { brand_key: brandKey } },
  );
}

async function deleteCredentials(brandKey) {
  if (!brandKey) return { success: false };
  await MetaAdsCredential.destroy({ where: { brand_key: brandKey } });
  return { success: true };
}

// ---- OAuth proof-of-concept log (Mongo) ------------------------------------
// The "Connect with Meta" flow parks the token it captures here, one row per
// brand, until it's wired into meta_ads_credentials above.

function maskToken(token) {
  const value = String(token || "");
  return value.length > 6 ? `…${value.slice(-6)}` : "…";
}

function toOauthLogShape(row) {
  return {
    brandKey: row.brand_id,
    tokenSuffix: maskToken(row.access_token),
    expiresIn: row.expires_in,
    capturedAt: row.captured_at,
    updatedByEmail: row.updated_by_email,
  };
}

async function saveOauthLog({ brandKey, accessToken, expiresIn, updatedByEmail }) {
  const row = await MetaOauthLog.findOneAndUpdate(
    { brand_id: brandKey },
    {
      $set: {
        brand: await resolveBrandRef(brandKey),
        brand_id: brandKey,
        access_token: accessToken,
        expires_in: expiresIn || null,
        updated_by_email: updatedByEmail || null,
        captured_at: new Date(),
      },
    },
    { upsert: true, new: true },
  ).lean();
  return toOauthLogShape(row);
}

async function getOauthLog(brandKey) {
  if (!brandKey) return null;
  const row = await MetaOauthLog.findOne({ brand_id: brandKey }).lean();
  return row ? toOauthLogShape(row) : null;
}

module.exports = {
  saveCredentials,
  getCredentials,
  getStatus,
  recordError,
  deleteCredentials,
  saveOauthLog,
  getOauthLog,
};
