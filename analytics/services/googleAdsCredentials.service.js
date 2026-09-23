const axios = require("axios");
const { encryptText, decryptText } = require("../shared/utils/crypto");
const GoogleAdsCredential = require("../shared/db/models/GoogleAdsCredential.mongo");
const GoogleOauthPending = require("../shared/db/models/GoogleOauthPending.mongo");
const { resolveBrandRef } = require("../shared/db/models/Tenant.mongo");

// Google Ads connector for the P&L page. Two ways in, one storage shape:
//   - OAuth ("Connect with Google"): startOauth exchanges the authorization
//     code for a refresh token server-side (needs the app's client secret,
//     so this can't happen in the browser) and parks it in
//     GoogleOauthPending; finalizeOauth reads that back once the brand has
//     typed in which customer id to connect, and persists it.
//   - Manual fallback: saveCredentials, for a brand that already has a
//     refresh token in hand and pastes it directly.
// Either way the result is one google_ads_credentials document per brand,
// encrypted with the shared PASSWORD_AES_KEY. Nothing here talks to the
// Google Ads API itself — the pipeline's Google Ads sync reads this
// document, pulls spend, and writes the daily rollup the P&L summary reads.

const MAX_TOKEN_LENGTH = 4096;
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
// Datum's OAuth client, not per-brand - same convention as META_APP_ID and
// the pipeline's GOOGLE_ADS_CLIENT_ID/SECRET (workers/pnl_worker.py), shared
// across both repos.
const GOOGLE_OAUTH_SCOPE = "https://www.googleapis.com/auth/adwords";

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
    authMethod: row.auth_method || "manual",
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

// Shared by saveCredentials (manual paste) and finalizeOauth: validates the
// customer id(s), encrypts the token, and upserts the one document per brand.
async function persistCredential({ key, customerId, loginCustomerId, token, updatedByEmail, authMethod }) {
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
        auth_method: authMethod,
        updated_by_email: updatedByEmail || null,
        captured_at: new Date(),
        last_error: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  return { success: true, status: toStatusShape(row) };
}

// Validates and stores a refresh token the brand pasted directly. Fallback
// for a brand that already has one; replaces any previous credential.
async function saveCredentials({ brandKey, customerId, loginCustomerId, token, updatedByEmail }) {
  const key = normalizeBrandKey(brandKey);
  if (!key) throw new Error("brandKey is required");
  return persistCredential({ key, customerId, loginCustomerId, token, updatedByEmail, authMethod: "manual" });
}

// ---- OAuth ("Connect with Google") -----------------------------------------

class OauthConfigError extends Error {}

// Authorization-code -> tokens. Needs the app's client secret, so this only
// ever runs server-side (mirrors the pipeline's own google_access_token()
// refresh-token exchange in workers/pnl_worker.py, one step later in the
// same OAuth app).
async function exchangeCodeForTokens(code, redirectUri) {
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new OauthConfigError("GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET are not configured on the backend.");
  }
  try {
    const response = await axios.post(GOOGLE_OAUTH_TOKEN_URL, {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    return response.data || {};
  } catch (error) {
    const message = error.response?.data?.error_description || error.response?.data?.error || error.message;
    throw new Error(`Google rejected the authorization code: ${message}`);
  }
}

// Step 1 of the picker: exchanges the code Google just redirected back with,
// and parks the refresh token against the brand - never sent to the browser.
// `prompt=consent` on the frontend's authorization URL guarantees Google
// hands back a refresh token every time (without it, a brand re-authorizing
// without first revoking access would get none).
async function startOauth({ brandKey, code, redirectUri, updatedByEmail }) {
  const key = normalizeBrandKey(brandKey);
  if (!key) throw new Error("brandKey is required");
  if (!code || !redirectUri) return { success: false, error: "code and redirect_uri are required." };

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code, redirectUri);
  } catch (error) {
    return { success: false, error: error.message };
  }

  if (!tokens.refresh_token) {
    return {
      success: false,
      error:
        "Google did not return a refresh token. This Google account may have already authorized Datum - " +
        "remove access at myaccount.google.com/permissions and try connecting again.",
    };
  }

  await GoogleOauthPending.findOneAndUpdate(
    { brand_id: key },
    {
      $set: {
        brand: await resolveBrandRef(key),
        brand_id: key,
        refresh_token_encrypted: encryptText(tokens.refresh_token),
        updated_by_email: updatedByEmail || null,
        created_at: new Date(),
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  return { success: true };
}

// Step 2 of the picker: the brand has typed in which customer id to connect;
// read back the refresh token parked by startOauth and persist the real
// credential. The pending document is removed either way.
async function finalizeOauth({ brandKey, customerId, loginCustomerId, updatedByEmail }) {
  const key = normalizeBrandKey(brandKey);
  if (!key) throw new Error("brandKey is required");

  const pending = await GoogleOauthPending.findOne({ brand_id: key }).lean();
  if (!pending) {
    return {
      success: false,
      error: 'This connect session has expired. Click "Connect with Google" again.',
    };
  }

  const refreshToken = decryptText(pending.refresh_token_encrypted);
  const result = await persistCredential({
    key,
    customerId,
    loginCustomerId,
    token: refreshToken,
    updatedByEmail,
    authMethod: "oauth",
  });
  await GoogleOauthPending.deleteOne({ brand_id: key });
  return result;
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
  startOauth,
  finalizeOauth,
  normalizeCustomerId,
  normalizeBrandKey,
  GOOGLE_OAUTH_SCOPE,
};
