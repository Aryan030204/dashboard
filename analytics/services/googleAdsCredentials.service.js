const axios = require("axios");
const { encryptText, decryptText } = require("../shared/utils/crypto");
const GoogleAdsCredential = require("../shared/db/models/GoogleAdsCredential.mongo");
const GoogleOauthPending = require("../shared/db/models/GoogleOauthPending.mongo");
const { resolveBrandRef } = require("../shared/db/models/Tenant.mongo");
const { triggerPnlBackfill } = require("../shared/utils/pipelineClient");

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
const GOOGLE_ADS_BASE_URL = "https://googleads.googleapis.com";
// Same env var + default as the pipeline's own Google Ads calls
// (workers/pnl_worker.py) - keep them in lockstep.
const GOOGLE_ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v25";
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

// Dedupes and validates a list of raw customer ids (checkbox picker sends an
// array; the manual-paste fallback still sends one). Any id that isn't 10
// digits fails the whole batch, same as the single-id path used to.
function normalizeCustomerIds(rawList) {
  const list = Array.isArray(rawList) ? rawList : [rawList];
  const seen = new Set();
  const ids = [];
  for (const raw of list) {
    const id = normalizeCustomerId(raw);
    if (!id) continue;
    if (id.length !== 10) return { error: `"${raw}" is not a valid customer id (must be 10 digits).` };
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0) return { error: "At least one customer_id is required (digits only, dashes optional)." };
  return { ids };
}

function maskToken(token) {
  const value = String(token || "");
  return value.length > 6 ? `…${value.slice(-6)}` : "…";
}

function toStatusShape(row) {
  if (!row) return { connected: false };
  const customerIds = Array.isArray(row.customer_ids) && row.customer_ids.length
    ? row.customer_ids
    : row.customer_id
      ? [row.customer_id]
      : [];
  return {
    connected: true,
    customerIds,
    customerId: customerIds[0] || null, // back-compat for older frontend builds
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
async function persistCredential({ key, customerIds, loginCustomerId, token, updatedByEmail, authMethod }) {
  const { ids, error } = normalizeCustomerIds(customerIds);
  if (error) return { success: false, error };

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
        customer_ids: ids,
        // Deprecated single field, kept for the pipeline's current
        // single-account sync - see the schema comment.
        customer_id: ids[0],
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

  // Pull the last 30 days of Google spend into the P&L worker now instead of
  // waiting for its nightly schedule to notice the new credentials. Awaited
  // only so the connect response can tell the brand a rebuild is running -
  // it never throws, so it still can't fail the connect itself.
  const sync = await triggerPnlBackfill(key);

  return { success: true, status: { ...toStatusShape(row), sync } };
}

// Validates and stores a refresh token the brand pasted directly. Fallback
// for a brand that already has one; replaces any previous credential.
async function saveCredentials({ brandKey, customerIds, loginCustomerId, token, updatedByEmail }) {
  const key = normalizeBrandKey(brandKey);
  if (!key) throw new Error("brandKey is required");
  return persistCredential({ key, customerIds, loginCustomerId, token, updatedByEmail, authMethod: "manual" });
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

// Refresh-token -> short-lived access token, for the two calls below only
// (listing accounts right after connecting). Same grant the pipeline's own
// google_access_token() uses one step later in workers/pnl_worker.py.
async function refreshAccessToken(refreshToken) {
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new OauthConfigError("GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET are not configured on the backend.");
  }
  const response = await axios.post(GOOGLE_OAUTH_TOKEN_URL, {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const accessToken = response.data?.access_token;
  if (!accessToken) throw new Error("Google token refresh returned no access token.");
  return accessToken;
}

// Backs the account picker: every customer id (and manager account) the
// login can see, then a light self-query per id for a display name/currency
// so the checkbox list isn't just bare numbers. Best-effort per id - one
// account the query fails for (e.g. no serving data yet) is dropped rather
// than failing the whole list, since the id itself is still connectable.
async function listAccessibleCustomers(refreshToken) {
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) return { success: false, error: "GOOGLE_ADS_DEVELOPER_TOKEN is not configured on the backend." };

  let accessToken;
  try {
    accessToken = await refreshAccessToken(refreshToken);
  } catch (error) {
    return { success: false, error: error.message };
  }

  const headers = { Authorization: `Bearer ${accessToken}`, "developer-token": developerToken };

  let resourceNames;
  try {
    const response = await axios.get(
      `${GOOGLE_ADS_BASE_URL}/${GOOGLE_ADS_API_VERSION}/customers:listAccessibleCustomers`,
      { headers, timeout: 15000 },
    );
    resourceNames = response.data?.resourceNames || [];
  } catch (error) {
    const message = error.response?.data?.error?.message || error.message || "Could not list Google Ads accounts";
    return { success: false, error: message };
  }

  const ids = resourceNames.map((name) => normalizeCustomerId(name.split("/").pop())).filter(Boolean);
  const query =
    "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer LIMIT 1";

  const accounts = await Promise.all(
    ids.map(async (id) => {
      try {
        const response = await axios.post(
          `${GOOGLE_ADS_BASE_URL}/${GOOGLE_ADS_API_VERSION}/customers/${id}/googleAds:search`,
          { query },
          { headers, timeout: 15000 },
        );
        const customer = response.data?.results?.[0]?.customer;
        return {
          id,
          name: customer?.descriptiveName || id,
          currency: customer?.currencyCode || null,
          isManager: Boolean(customer?.manager),
        };
      } catch {
        // Id is still valid/connectable - just show it without the extras.
        return { id, name: id, currency: null, isManager: null };
      }
    }),
  );

  return { success: true, accounts };
}

// Step 1 of the picker: exchanges the code Google just redirected back with,
// lists the account(s) the resulting refresh token can see (so the frontend
// can show a checkbox picker), and parks the token against the brand - never
// sent to the browser. `prompt=consent` on the frontend's authorization URL
// guarantees Google hands back a refresh token every time (without it, a
// brand re-authorizing without first revoking access would get none).
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

  // Best-effort: the refresh token is already safely parked above either
  // way, so a listing failure (e.g. developer token not yet approved) just
  // means the frontend falls back to letting the brand type a customer id,
  // not a failed connect.
  const listResult = await listAccessibleCustomers(tokens.refresh_token);
  return {
    success: true,
    accounts: listResult.success ? listResult.accounts : [],
    listError: listResult.success ? null : listResult.error,
  };
}

// Step 2 of the picker: the brand has picked which customer id(s) to
// connect; read back the refresh token parked by startOauth and persist the
// real credential. The pending document is removed either way.
async function finalizeOauth({ brandKey, customerIds, loginCustomerId, updatedByEmail }) {
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
    customerIds,
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
