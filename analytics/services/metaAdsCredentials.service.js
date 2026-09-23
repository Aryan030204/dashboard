const axios = require("axios");
const { encryptText, decryptText } = require("../shared/utils/crypto");
const MetaAdsCredential = require("../shared/db/models/MetaAdsCredential.mongo");
const MetaOauthLog = require("../shared/db/models/MetaOauthLog.mongo");
const { resolveBrandRef } = require("../shared/db/models/Tenant.mongo");

// Credentials live in Mongo (meta_ads_credentials, one document per brand),
// alongside the Google Ads ones and the brand's total_config, so the
// pipeline's P&L worker reads all three from one place.

function apiVersion() {
  return process.env.META_API_VERSION || "v21.0";
}

function normalizeBrandKey(brandKey) {
  return String(brandKey || "").trim().toUpperCase();
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

// Meta's OAuth dialog never asks which ad account the user means — the
// ads_read grant covers every account the logged-in user can see — so after
// the redirect we list them and let the brand pick one. Follows paging.next
// for a few pages; agencies routinely sit on more than one page of accounts.
const AD_ACCOUNT_STATUS_LABELS = {
  1: "Active",
  2: "Disabled",
  3: "Unsettled",
  7: "Pending risk review",
  8: "Pending settlement",
  9: "In grace period",
  100: "Pending closure",
  101: "Closed",
};

async function listAdAccounts(accessToken) {
  if (!accessToken) return { success: false, error: "access_token is required" };

  const accounts = [];
  let url = `https://graph.facebook.com/${apiVersion()}/me/adaccounts`;
  let params = { fields: "id,name,account_status,currency", limit: 100, access_token: accessToken };

  try {
    for (let page = 0; page < 5 && url; page += 1) {
      const response = await axios.get(url, { params, timeout: 10000 });
      const rows = Array.isArray(response.data?.data) ? response.data.data : [];
      for (const row of rows) {
        accounts.push({
          id: normalizeAdAccountId(row.id),
          name: row.name || row.id,
          currency: row.currency || null,
          accountStatus: row.account_status ?? null,
          accountStatusLabel: AD_ACCOUNT_STATUS_LABELS[row.account_status] || null,
        });
      }
      // paging.next is a fully-formed URL (token included), so drop our params.
      url = response.data?.paging?.next || null;
      params = undefined;
    }
    return { success: true, accounts };
  } catch (error) {
    const message = error.response?.data?.error?.message || error.message || "Could not list ad accounts";
    return { success: false, error: message };
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

function normalizeTokenType(rawType) {
  return rawType === "system_user" ? "system_user" : "user";
}

async function saveCredentials({ brandKey, adAccountId, accessToken, updatedByEmail, tokenType }) {
  const key = normalizeBrandKey(brandKey);
  if (!key) throw new Error("brandKey is required");
  if (!adAccountId || !accessToken) {
    return { success: false, error: "Ad account ID and access token are both required." };
  }

  const normalizedTokenType = normalizeTokenType(tokenType);

  const verification = await verifyToken(adAccountId, accessToken);
  if (!verification.valid) {
    return { success: false, error: `Meta rejected these credentials: ${verification.error}` };
  }

  // System User tokens are generated directly in Business Settings and are
  // already long-lived (typically "never expires") — they are not an OAuth
  // user token, so they never go through fb_exchange_token. Stored exactly
  // as pasted, byte-for-byte, so there is no risk of the exchange call
  // silently handing back something different.
  const exchanged = normalizedTokenType === "system_user"
    ? { accessToken, expiresAt: null }
    : await tryExchangeForLongLivedToken(accessToken);

  await MetaAdsCredential.findOneAndUpdate(
    { brand_id: key },
    {
      $set: {
        brand: await resolveBrandRef(key),
        brand_id: key,
        ad_account_id: normalizeAdAccountId(adAccountId),
        access_token_encrypted: encryptText(exchanged.accessToken),
        token_type: normalizedTokenType,
        token_expires_at: exchanged.expiresAt,
        last_verified_at: new Date(),
        last_error: null,
        updated_by_email: updatedByEmail || null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return { success: true };
}

async function getCredentials(brandKey) {
  const key = normalizeBrandKey(brandKey);
  if (!key) return null;
  const row = await MetaAdsCredential.findOne({ brand_id: key }).lean();
  if (!row) return null;
  return {
    adAccountId: row.ad_account_id,
    accessToken: decryptText(row.access_token_encrypted),
    expiresAt: row.token_expires_at,
  };
}

async function getStatus(brandKey) {
  const key = normalizeBrandKey(brandKey);
  if (!key) return { connected: false };
  const row = await MetaAdsCredential.findOne({ brand_id: key }).lean();
  if (!row) return { connected: false };
  return {
    connected: true,
    adAccountId: row.ad_account_id,
    tokenType: row.token_type || "user",
    expiresAt: row.token_expires_at || null,
    lastVerifiedAt: row.last_verified_at || null,
    lastError: row.last_error || null,
    updatedByEmail: row.updated_by_email || null,
    updatedAt: row.updated_at || null,
  };
}

// Records a live-call failure against the saved document (surfaced on the
// status endpoint) without touching the token itself. The pipeline's P&L
// worker writes the same field when its nightly spend pull fails.
async function recordError(brandKey, message) {
  const key = normalizeBrandKey(brandKey);
  if (!key) return;
  await MetaAdsCredential.updateOne(
    { brand_id: key },
    { $set: { last_error: String(message || "").slice(0, 500) } },
  );
}

async function deleteCredentials(brandKey) {
  const key = normalizeBrandKey(brandKey);
  if (!key) return { success: false };
  await MetaAdsCredential.deleteOne({ brand_id: key });
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
  listAdAccounts,
  saveCredentials,
  getCredentials,
  getStatus,
  recordError,
  deleteCredentials,
  saveOauthLog,
  getOauthLog,
};
