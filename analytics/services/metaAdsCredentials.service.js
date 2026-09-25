const axios = require("axios");
const { encryptText, decryptText } = require("../shared/utils/crypto");
const MetaAdsCredential = require("../shared/db/models/MetaAdsCredential.mongo");
const MetaOauthPending = require("../shared/db/models/MetaOauthPending.mongo");
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

// Dedupes and normalizes a list of raw ad account ids (checkbox picker sends
// an array; the manual-paste fallback used to send one). Blanks dropped,
// order preserved - mirrors normalizeCustomerIds in
// googleAdsCredentials.service.js.
function normalizeAdAccountIds(rawList) {
  const list = Array.isArray(rawList) ? rawList : rawList ? [rawList] : [];
  const seen = new Set();
  const ids = [];
  for (const raw of list) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) continue;
    const id = normalizeAdAccountId(trimmed);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
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

async function saveCredentials({ brandKey, adAccountIds, accessToken, updatedByEmail, tokenType }) {
  const key = normalizeBrandKey(brandKey);
  if (!key) throw new Error("brandKey is required");
  const ids = normalizeAdAccountIds(adAccountIds);
  if (ids.length === 0 || !accessToken) {
    return { success: false, error: "At least one ad account ID and an access token are both required." };
  }

  const normalizedTokenType = normalizeTokenType(tokenType);

  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop -- small list, sequential is fine
    const verification = await verifyToken(id, accessToken);
    if (!verification.valid) {
      return { success: false, error: `Meta rejected these credentials for ${id}: ${verification.error}` };
    }
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
        ad_account_ids: ids,
        // Deprecated single field, kept for the pipeline's current
        // single-account sync - see the schema comment.
        ad_account_id: ids[0],
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

function toAdAccountIds(row) {
  return Array.isArray(row.ad_account_ids) && row.ad_account_ids.length
    ? row.ad_account_ids
    : row.ad_account_id
      ? [row.ad_account_id]
      : [];
}

async function getCredentials(brandKey) {
  const key = normalizeBrandKey(brandKey);
  if (!key) return null;
  const row = await MetaAdsCredential.findOne({ brand_id: key }).lean();
  if (!row) return null;
  const adAccountIds = toAdAccountIds(row);
  return {
    adAccountIds,
    adAccountId: adAccountIds[0] || null,
    accessToken: decryptText(row.access_token_encrypted),
    expiresAt: row.token_expires_at,
  };
}

async function getStatus(brandKey) {
  const key = normalizeBrandKey(brandKey);
  if (!key) return { connected: false };
  const row = await MetaAdsCredential.findOne({ brand_id: key }).lean();
  if (!row) return { connected: false };
  const adAccountIds = toAdAccountIds(row);
  return {
    connected: true,
    adAccountIds,
    adAccountId: adAccountIds[0] || null, // back-compat for older frontend builds
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

// ---- OAuth ("Continue with Meta") ------------------------------------------
// Mirrors googleAdsCredentials.service.js's startOauth/finalizeOauth: the
// authorization-code exchange needs the app secret, so it only ever runs
// server-side, and the resulting token is parked (encrypted) in
// MetaOauthPending rather than sent back to the browser. The brand still
// needs to say which of the ad account(s) the login covered to connect - the
// Facebook Login for Business dialog's asset picker doesn't narrow it to one
// for us the way Google's customer id field does.

// Authorization code -> System-business access token. Needs the app secret
// (mirrors tryExchangeForLongLivedToken's fb_exchange_token call, one step
// earlier in the same OAuth app).
async function exchangeCodeForToken(code, redirectUri) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("META_APP_ID / META_APP_SECRET are not configured on the backend.");
  }
  try {
    const response = await axios.get(`https://graph.facebook.com/${apiVersion()}/oauth/access_token`, {
      params: {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      },
      timeout: 10000,
    });
    return response.data || {};
  } catch (error) {
    const message = error.response?.data?.error?.message || error.message || "Meta rejected the authorization code";
    throw new Error(`Meta rejected the authorization code: ${message}`);
  }
}

// Step 1 of the picker: exchanges the code Meta just redirected back with,
// lists the ad account(s) the resulting token can see (so the frontend can
// show a picker), and parks the token against the brand - never sent to the
// browser.
async function startOauth({ brandKey, code, redirectUri, updatedByEmail }) {
  const key = normalizeBrandKey(brandKey);
  if (!key) throw new Error("brandKey is required");
  if (!code || !redirectUri) return { success: false, error: "code and redirect_uri are required." };

  let tokenResponse;
  try {
    tokenResponse = await exchangeCodeForToken(code, redirectUri);
  } catch (error) {
    return { success: false, error: error.message };
  }

  const accessToken = tokenResponse.access_token;
  if (!accessToken) {
    return { success: false, error: "Meta did not return an access token." };
  }

  const listResult = await listAdAccounts(accessToken);
  if (!listResult.success) {
    return { success: false, error: `Meta rejected the token: ${listResult.error}` };
  }
  if (listResult.accounts.length === 0) {
    return {
      success: false,
      error: "No ad accounts were shared during that Meta login. Try again and pick at least one ad account.",
    };
  }

  await MetaOauthPending.findOneAndUpdate(
    { brand_id: key },
    {
      $set: {
        brand: await resolveBrandRef(key),
        brand_id: key,
        access_token_encrypted: encryptText(accessToken),
        updated_by_email: updatedByEmail || null,
        created_at: new Date(),
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  return { success: true, accounts: listResult.accounts };
}

// Step 2 of the picker: the brand has picked which ad account(s) to connect;
// read back the token parked by startOauth and persist the real credential
// the same way saveCredentials does for a pasted System User token - a
// "Continue with Meta" login scoped to a Facebook Login for Business
// configuration hands back the same kind of non-expiring System-business
// token, so it's stored the same way (token_type "system_user", no exchange).
// The pending document is removed either way.
async function finalizeOauth({ brandKey, adAccountIds, updatedByEmail }) {
  const key = normalizeBrandKey(brandKey);
  if (!key) throw new Error("brandKey is required");
  const ids = normalizeAdAccountIds(adAccountIds);
  if (ids.length === 0) return { success: false, error: "ad_account_ids is required." };

  const pending = await MetaOauthPending.findOne({ brand_id: key }).lean();
  if (!pending) {
    return {
      success: false,
      error: 'This connect session has expired. Click "Continue with Meta" again.',
    };
  }

  const accessToken = decryptText(pending.access_token_encrypted);
  const result = await saveCredentials({
    brandKey: key,
    adAccountIds: ids,
    accessToken,
    tokenType: "system_user",
    updatedByEmail,
  });
  await MetaOauthPending.deleteOne({ brand_id: key });
  return result;
}

module.exports = {
  listAdAccounts,
  saveCredentials,
  getCredentials,
  getStatus,
  recordError,
  deleteCredentials,
  startOauth,
  finalizeOauth,
};
