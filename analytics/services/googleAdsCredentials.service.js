const axios = require("axios");
const { encryptText, decryptText } = require("../shared/utils/crypto");
const GoogleAdsOauthToken = require("../shared/db/models/GoogleAdsOauthToken.mongo");
const { resolveBrandRef } = require("../shared/db/models/Tenant.mongo");

// Google Ads connector for the P&L page. OAuth is the authorization-code flow
// with access_type=offline so we get a refresh token; the implicit flow Meta
// uses would only hand back a one-hour access token with no way to renew it.
//
// Env:
//   GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET  OAuth client (Web application type)
//   GOOGLE_ADS_DEVELOPER_TOKEN                        required for any Google Ads API call
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID                      optional MCC id when accounts are reached via a manager
//   GOOGLE_ADS_API_VERSION                            defaults to v25

const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

// Refresh the access token this many ms before Google says it expires.
const ACCESS_TOKEN_SKEW_MS = 60 * 1000;
const MAX_CUSTOMERS_TO_DESCRIBE = 25;

function apiVersion() {
  return process.env.GOOGLE_ADS_API_VERSION || "v25";
}

function adsBaseUrl() {
  return `https://googleads.googleapis.com/${apiVersion()}`;
}

function oauthClient() {
  return {
    clientId: process.env.GOOGLE_ADS_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET || "",
  };
}

function developerToken() {
  return process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "";
}

function normalizeCustomerId(raw) {
  return String(raw || "").replace(/\D/g, "");
}

function adsHeaders(accessToken, { loginCustomerId } = {}) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": developerToken(),
  };
  const login = normalizeCustomerId(loginCustomerId || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
  if (login) headers["login-customer-id"] = login;
  return headers;
}

// Google Ads API errors nest the useful message a few levels down.
function adsErrorMessage(error) {
  const data = error.response?.data;
  const body = Array.isArray(data) ? data[0] : data;
  const nested = body?.error?.details?.[0]?.errors?.[0]?.message;
  return (
    nested
    || body?.error?.message
    || body?.error_description
    || body?.error
    || error.message
    || "Google Ads request failed"
  );
}

function getOauthConfig() {
  const { clientId } = oauthClient();
  return {
    clientId,
    authUrl: OAUTH_AUTH_URL,
    scope: ADS_SCOPE,
    developerTokenConfigured: Boolean(developerToken()),
  };
}

async function postTokenEndpoint(params) {
  const response = await axios.post(OAUTH_TOKEN_URL, new URLSearchParams(params).toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 10000,
  });
  return response.data || {};
}

// ---- customers -------------------------------------------------------------

async function listAccessibleCustomerIds(accessToken) {
  const response = await axios.get(`${adsBaseUrl()}/customers:listAccessibleCustomers`, {
    headers: adsHeaders(accessToken, { loginCustomerId: "" }),
    timeout: 15000,
  });
  const names = Array.isArray(response.data?.resourceNames) ? response.data.resourceNames : [];
  return names.map((name) => normalizeCustomerId(name.split("/").pop())).filter(Boolean);
}

// Best-effort: pulls a display name / currency / manager flag for each
// customer id. A customer we can't query (needs an MCC login-customer-id we
// don't have, or is a cancelled account) still shows up, just by id.
async function describeCustomer(accessToken, customerId) {
  try {
    const response = await axios.post(
      `${adsBaseUrl()}/customers/${customerId}/googleAds:search`,
      {
        query:
          "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager "
          + "FROM customer LIMIT 1",
      },
      { headers: adsHeaders(accessToken), timeout: 15000 },
    );
    const customer = response.data?.results?.[0]?.customer || {};
    return {
      id: customerId,
      name: customer.descriptiveName || null,
      currency_code: customer.currencyCode || null,
      manager: Boolean(customer.manager),
    };
  } catch {
    return { id: customerId, name: null, currency_code: null, manager: false };
  }
}

async function listAccessibleCustomers(accessToken) {
  if (!developerToken()) {
    return { customers: [], error: "GOOGLE_ADS_DEVELOPER_TOKEN is not configured; enter the customer id manually." };
  }
  try {
    const ids = await listAccessibleCustomerIds(accessToken);
    const customers = [];
    for (const id of ids.slice(0, MAX_CUSTOMERS_TO_DESCRIBE)) {
      customers.push(await describeCustomer(accessToken, id));
    }
    for (const id of ids.slice(MAX_CUSTOMERS_TO_DESCRIBE)) {
      customers.push({ id, name: null, currency_code: null, manager: false });
    }
    return { customers, error: null };
  } catch (error) {
    return { customers: [], error: adsErrorMessage(error) };
  }
}

// ---- storage ---------------------------------------------------------------

function toCustomerShape(row) {
  return {
    id: row.id,
    name: row.name || null,
    currencyCode: row.currency_code || null,
    manager: Boolean(row.manager),
  };
}

function toStatusShape(row) {
  if (!row) return { connected: false, developerTokenConfigured: Boolean(developerToken()) };
  return {
    connected: true,
    customerId: row.customer_id || null,
    accessibleCustomers: (row.accessible_customers || []).map(toCustomerShape),
    accessTokenExpiresAt: row.access_token_expires_at || null,
    scope: row.scope || null,
    capturedAt: row.captured_at || null,
    updatedByEmail: row.updated_by_email || null,
    lastError: row.last_error || null,
    developerTokenConfigured: Boolean(developerToken()),
  };
}

async function getStatus(brandKey) {
  if (!brandKey) return toStatusShape(null);
  const row = await GoogleAdsOauthToken.findOne({ brand_id: brandKey }).lean();
  return toStatusShape(row);
}

// Turns the one-time code Google appended to the redirect into a refresh
// token + access token, and parks them (encrypted) against the brand. The
// redirect_uri must match the one the frontend sent Google to byte-for-byte
// or Google refuses the exchange.
async function exchangeCode({ brandKey, code, redirectUri, updatedByEmail }) {
  if (!brandKey) throw new Error("brandKey is required");
  if (!code || !redirectUri) {
    return { success: false, error: "code and redirect_uri are both required." };
  }
  const { clientId, clientSecret } = oauthClient();
  if (!clientId || !clientSecret) {
    return { success: false, error: "GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET are not configured on the backend." };
  }

  let tokens;
  try {
    tokens = await postTokenEndpoint({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
  } catch (error) {
    return { success: false, error: `Google rejected the code: ${adsErrorMessage(error)}` };
  }

  const accessToken = tokens.access_token || "";
  let refreshToken = tokens.refresh_token || "";
  if (!accessToken) {
    return { success: false, error: "Google did not return an access token." };
  }

  // Google only issues a refresh token on the first consent unless the
  // dialog was opened with prompt=consent (which the frontend does). If it's
  // still missing, keep whatever refresh token we already hold for the brand.
  const existing = await GoogleAdsOauthToken.findOne({ brand_id: brandKey }).lean();
  if (!refreshToken && existing?.refresh_token_encrypted) {
    refreshToken = decryptText(existing.refresh_token_encrypted);
  }
  if (!refreshToken) {
    return {
      success: false,
      error: "Google did not return a refresh token. Remove this app from the Google account's third-party access and reconnect.",
    };
  }

  const { customers, error: customersError } = await listAccessibleCustomers(accessToken);
  const expiresAt = tokens.expires_in ? new Date(Date.now() + Number(tokens.expires_in) * 1000) : null;

  // Keep the previously chosen customer if it's still accessible (or if we
  // couldn't list, so a manual entry survives a reconnect).
  const previousCustomer = existing?.customer_id || null;
  const keepCustomer =
    previousCustomer && (customers.length === 0 || customers.some((c) => c.id === previousCustomer));

  const row = await GoogleAdsOauthToken.findOneAndUpdate(
    { brand_id: brandKey },
    {
      $set: {
        brand: await resolveBrandRef(brandKey),
        brand_id: brandKey,
        refresh_token_encrypted: encryptText(refreshToken),
        access_token_encrypted: encryptText(accessToken),
        access_token_expires_at: expiresAt,
        scope: tokens.scope || ADS_SCOPE,
        customer_id: keepCustomer ? previousCustomer : customers.length === 1 ? customers[0].id : null,
        accessible_customers: customers,
        updated_by_email: updatedByEmail || null,
        captured_at: new Date(),
        last_error: customersError || null,
      },
    },
    { upsert: true, new: true },
  ).lean();

  return { success: true, status: toStatusShape(row), customersError };
}

async function setCustomer({ brandKey, customerId }) {
  if (!brandKey) throw new Error("brandKey is required");
  const id = normalizeCustomerId(customerId);
  if (!id) return { success: false, error: "customer_id is required (digits only, dashes optional)." };
  const row = await GoogleAdsOauthToken.findOneAndUpdate(
    { brand_id: brandKey },
    { $set: { customer_id: id, last_error: null } },
    { new: true },
  ).lean();
  if (!row) return { success: false, error: "Connect Google Ads first." };
  return { success: true, status: toStatusShape(row) };
}

// Re-lists accessible customers with a fresh access token and stores them.
async function refreshCustomers(brandKey) {
  const token = await getAccessToken(brandKey);
  if (!token.success) return token;
  const { customers, error } = await listAccessibleCustomers(token.accessToken);
  const row = await GoogleAdsOauthToken.findOneAndUpdate(
    { brand_id: brandKey },
    { $set: { accessible_customers: customers, last_error: error || null } },
    { new: true },
  ).lean();
  return { success: true, status: toStatusShape(row), customersError: error };
}

async function recordError(brandKey, message) {
  if (!brandKey) return;
  await GoogleAdsOauthToken.updateOne(
    { brand_id: brandKey },
    { $set: { last_error: String(message || "").slice(0, 500) } },
  );
}

// Best-effort revoke at Google so the grant disappears from the user's
// account too, then drop the row.
async function disconnect(brandKey) {
  if (!brandKey) return { success: false };
  const row = await GoogleAdsOauthToken.findOne({ brand_id: brandKey }).lean();
  if (row?.refresh_token_encrypted) {
    try {
      await axios.post(OAUTH_REVOKE_URL, new URLSearchParams({ token: decryptText(row.refresh_token_encrypted) }).toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000,
      });
    } catch {
      // Already revoked or Google unreachable — the row goes either way.
    }
  }
  await GoogleAdsOauthToken.deleteOne({ brand_id: brandKey });
  return { success: true };
}

// ---- using the token -------------------------------------------------------

// Hands back a usable access token for the brand, minting a new one from the
// refresh token when the stored one is missing or about to expire. This is
// the entry point anything pulling spend should go through.
async function getAccessToken(brandKey) {
  if (!brandKey) return { success: false, error: "brandKey is required" };
  const row = await GoogleAdsOauthToken.findOne({ brand_id: brandKey }).lean();
  if (!row) return { success: false, error: "Google Ads is not connected for this brand." };

  const expiresAt = row.access_token_expires_at ? new Date(row.access_token_expires_at).getTime() : 0;
  if (row.access_token_encrypted && expiresAt - ACCESS_TOKEN_SKEW_MS > Date.now()) {
    return { success: true, accessToken: decryptText(row.access_token_encrypted), customerId: row.customer_id };
  }

  const { clientId, clientSecret } = oauthClient();
  try {
    const tokens = await postTokenEndpoint({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: decryptText(row.refresh_token_encrypted),
      grant_type: "refresh_token",
    });
    const accessToken = tokens.access_token;
    if (!accessToken) throw new Error("Google did not return an access token.");
    const newExpiry = tokens.expires_in ? new Date(Date.now() + Number(tokens.expires_in) * 1000) : null;
    await GoogleAdsOauthToken.updateOne(
      { brand_id: brandKey },
      { $set: { access_token_encrypted: encryptText(accessToken), access_token_expires_at: newExpiry, last_error: null } },
    );
    return { success: true, accessToken, customerId: row.customer_id };
  } catch (error) {
    const message = `Token refresh failed: ${adsErrorMessage(error)}`;
    await recordError(brandKey, message);
    return { success: false, error: message };
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPEND_RANGE_DAYS = 366;

function daysBetween(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
}

// Every page of a googleAds:search query, following nextPageToken.
async function searchAll(accessToken, customerId, query) {
  const results = [];
  let pageToken;
  do {
    const response = await axios.post(
      `${adsBaseUrl()}/customers/${customerId}/googleAds:search`,
      pageToken ? { query, pageToken } : { query },
      { headers: adsHeaders(accessToken), timeout: 20000 },
    );
    if (Array.isArray(response.data?.results)) results.push(...response.data.results);
    pageToken = response.data?.nextPageToken || null;
  } while (pageToken);
  return results;
}

// Date-wise cost for the brand's chosen customer, in the account's own
// timezone and currency, one entry per calendar day in [start, end]. Days
// with no spend are filled in with 0 so the caller can rely on the shape.
// cost_micros / 1e6 = currency units. Pass `date` for a single day.
async function getSpendByDate({ brandKey, date, start, end, customerId }) {
  const rangeStart = date || start;
  const rangeEnd = date || end;
  if (!DATE_RE.test(String(rangeStart || "")) || !DATE_RE.test(String(rangeEnd || ""))) {
    return { success: false, error: "Pass date=YYYY-MM-DD, or start and end as YYYY-MM-DD." };
  }
  if (rangeEnd < rangeStart) {
    return { success: false, error: "end must not be before start." };
  }
  const dayCount = daysBetween(rangeStart, rangeEnd);
  if (dayCount > MAX_SPEND_RANGE_DAYS) {
    return { success: false, error: `Date range is limited to ${MAX_SPEND_RANGE_DAYS} days.` };
  }
  if (!developerToken()) {
    return { success: false, error: "GOOGLE_ADS_DEVELOPER_TOKEN is not configured." };
  }
  const token = await getAccessToken(brandKey);
  if (!token.success) return token;

  const cid = normalizeCustomerId(customerId || token.customerId);
  if (!cid) return { success: false, error: "No Google Ads customer id chosen for this brand." };

  try {
    const results = await searchAll(
      token.accessToken,
      cid,
      "SELECT segments.date, metrics.cost_micros, customer.currency_code FROM customer "
        + `WHERE segments.date BETWEEN '${rangeStart}' AND '${rangeEnd}' ORDER BY segments.date`,
    );
    const microsByDate = new Map();
    let currency = null;
    for (const result of results) {
      const day = result.segments?.date;
      if (!day) continue;
      microsByDate.set(day, (microsByDate.get(day) || 0) + Number(result.metrics?.costMicros || 0));
      currency = currency || result.customer?.currencyCode || null;
    }

    const days = [];
    let totalMicros = 0;
    const cursor = new Date(`${rangeStart}T00:00:00Z`);
    for (let i = 0; i < dayCount; i += 1) {
      const day = cursor.toISOString().slice(0, 10);
      const micros = microsByDate.get(day) || 0;
      totalMicros += micros;
      days.push({ date: day, spend: micros / 1e6, currency });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return {
      success: true,
      start: rangeStart,
      end: rangeEnd,
      customerId: cid,
      currency,
      total: totalMicros / 1e6,
      days,
    };
  } catch (error) {
    const message = adsErrorMessage(error);
    await recordError(brandKey, message);
    return { success: false, error: message };
  }
}

module.exports = {
  getOauthConfig,
  getStatus,
  exchangeCode,
  setCustomer,
  refreshCustomers,
  disconnect,
  getAccessToken,
  getSpendByDate,
  normalizeCustomerId,
};
