import { captureApiFailure } from "../observability.js";

function resolveApiBase() {
  const envBase = (import.meta.env.VITE_API_BASE || "").trim();
  if (!envBase) return "/api";
  return envBase;
}

const API_BASE = resolveApiBase();

function isMaintenanceStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

function qs(params) {
  const parts = [];
  Object.entries(params).forEach(([k, v]) => {
    if (!v) return;
    if (Array.isArray(v)) {
      v.forEach((val) => {
        if (val)
          parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(val)}`);
      });
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  });
  return parts.length ? `?${parts.join("&")}` : "";
}

function normalizeBrandKey(src) {
  if (!src) return "";
  return src.toString().trim().toUpperCase();
}

function appendBrandKey(params, source) {
  const brand_key = normalizeBrandKey(source?.brand_key ?? source?.brandKey);
  const out = { ...params };
  if (brand_key) out.brand_key = brand_key;
  if (source?.utm_source) out.utm_source = source.utm_source;
  if (source?.utm_medium) out.utm_medium = source.utm_medium;
  if (source?.utm_campaign) out.utm_campaign = source.utm_campaign;
  if (source?.product_id) out.product_id = source.product_id;
  if (source?.sales_channel) out.sales_channel = source.sales_channel;
  if (source?.device_type) out.device_type = source.device_type;
  if (source?.discount_code) out.discount_code = source.discount_code;
  if (source?.city) out.city = source.city;
  if (source?.product_type) out.product_type = source.product_type;
  if (source?.refreshKey) out.refreshKey = source.refreshKey;
  return out;
}

function captureFailure(path, details = {}) {
  captureApiFailure(path, details);
}

function formatDateRangeSuffix(start, end) {
  const s = (start || "").toString().trim();
  const e = (end || "").toString().trim();
  if (s && e) return s === e ? s : `${s}_to_${e}`;
  if (s) return s;
  if (e) return e;
  return "";
}

function filenameFromDisposition(disposition) {
  if (!disposition) return null;
  const match = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return null;
}

function authHeaders() {
  const token = window.localStorage.getItem("gateway_access_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function clearStoredAuth() {
  window.localStorage.removeItem("gateway_access_token");
  window.localStorage.removeItem("gateway_refresh_token");
  window.dispatchEvent(new Event("auth:session-expired"));
}

const REFRESH_MAX_RETRIES = 3;

function refreshBackoff(attempt) {
  const ms = Math.min(1000 * 2 ** attempt, 4000) + Math.random() * 250;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Refresh the access token. Only a DEFINITIVE failure (401/403 = refresh token
// genuinely invalid/expired/revoked) ends the session. Transient failures
// (rate limit, 5xx, network blip, non-JSON body) are retried with backoff and,
// if still failing, surface as a failed request WITHOUT logging the user out.
async function refreshAccessToken() {
  for (let attempt = 0; attempt < REFRESH_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({}),
      });

      // Definitive: the refresh token itself is no longer valid -> real logout.
      if (res.status === 401 || res.status === 403) {
        clearStoredAuth();
        return false;
      }

      // Transient server-side failure (429/5xx/etc.) -> back off and retry.
      if (!res.ok) {
        await refreshBackoff(attempt);
        continue;
      }

      const json = await res.json().catch(() => null);
      if (!json || !json.access_token) {
        await refreshBackoff(attempt);
        continue;
      }

      window.localStorage.setItem("gateway_access_token", json.access_token);
      window.localStorage.removeItem("gateway_refresh_token");
      window.dispatchEvent(new Event("auth:token-refreshed"));
      return true;
    } catch (err) {
      // Network error -> transient. Do NOT clear auth here.
      console.error("Failed to refresh token (transient)", err);
      await refreshBackoff(attempt);
    }
  }
  // Exhausted retries on a transient problem: keep the session, fail the request.
  return false;
}

let refreshPromise = null;

// Run the refresh under a browser-wide lock so only ONE tab refreshes at a time.
// A tab that queues on the lock re-checks localStorage after acquiring it: if the
// winning tab already stored a new access token, we skip our own rotation entirely
// (avoids presenting the just-rotated cookie again and tripping reuse detection).
async function runRefreshExclusive() {
  const tokenBefore = window.localStorage.getItem("gateway_access_token");

  const doRefresh = async () => {
    const current = window.localStorage.getItem("gateway_access_token");
    if (current && current !== tokenBefore) {
      // Another tab refreshed while we waited for the lock.
      return true;
    }
    return refreshAccessToken();
  };

  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request("gateway-token-refresh", doRefresh);
  }
  // Fallback (e.g. older Safari without Web Locks): per-tab dedup only.
  // The backend rotation grace cache still protects against cross-tab races.
  return doRefresh();
}

async function ensureFreshToken() {
  if (!refreshPromise) {
    refreshPromise = runRefreshExclusive().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function fetchWithAuth(url, options = {}, retry = true) {
  const opts = {
    ...options,
    headers: { ...(options.headers || {}), ...authHeaders() },
  };
  const res = await fetch(url, opts);
  if (res.status === 401 && retry) {
    const refreshed = await ensureFreshToken();
    if (!refreshed) return res;
    const retryOpts = {
      ...options,
      headers: { ...(options.headers || {}), ...authHeaders() },
    };
    return fetch(url, retryOpts);
  }
  return res;
}

async function getJSON(path, params) {
  const url = `${API_BASE}${path}${qs(params || {})}`;
  try {
    const res = await fetchWithAuth(url);
    if (!res.ok) {
      const err = new Error(`${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (e) {
    captureFailure(path, { status: e?.status, method: "GET", brandKey: params?.brand_key });
    console.error("API error", path, e);
    return { __error: true };
  }
}

// Generic helpers returning { error, data, status }
export async function doGet(path, params, options = {}) {
  const url = `${API_BASE}${path}${qs(params || {})}`;
  try {
    const res = await fetchWithAuth(url, { signal: options.signal });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      captureFailure(path, { status: res.status, method: "GET", brandKey: params?.brand_key });
      return { error: true, status: res.status, data: json };
    }
    return { error: false, data: json };
  } catch (error) {
    if (error?.name === "AbortError" || options.signal?.aborted) {
      return { error: true, aborted: true };
    }
    captureFailure(path, { method: "GET", brandKey: params?.brand_key });
    return { error: true };
  }
}

export async function doPost(path, body) {
  const url = `${API_BASE}${path}`;
  try {
    const res = await fetchWithAuth(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      captureFailure(path, { status: res.status, method: "POST", brandKey: body?.brand_key });
      return { error: true, status: res.status, data: json };
    }
    return { error: false, data: json };
  } catch {
    captureFailure(path, { method: "POST", brandKey: body?.brand_key });
    return { error: true };
  }
}

export async function doPut(path, body) {
  const url = `${API_BASE}${path}`;
  try {
    const res = await fetchWithAuth(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      captureFailure(path, { status: res.status, method: "PUT", brandKey: body?.brand_key });
      return { error: true, status: res.status, data: json };
    }
    return { error: false, data: json };
  } catch {
    captureFailure(path, { method: "PUT", brandKey: body?.brand_key });
    return { error: true };
  }
}

export async function doDelete(path) {
  const url = `${API_BASE}${path}`;
  try {
    const res = await fetchWithAuth(url, { method: "DELETE" });
    // Some deletes return 204 with no JSON
    let json = {};
    try {
      json = await res.json();
    } catch {
      // Ignore empty JSON bodies on delete
    }
    if (!res.ok) {
      captureFailure(path, { status: res.status, method: "DELETE" });
      return { error: true, status: res.status, data: json };
    }
    return { error: false, data: json };
  } catch {
    captureFailure(path, { method: "DELETE" });
    return { error: true };
  }
}

export async function doPatch(path, body) {
  const url = `${API_BASE}${path}`;
  try {
    const res = await fetchWithAuth(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      captureFailure(path, { status: res.status, method: "PATCH", brandKey: body?.brand_key });
      return { error: true, status: res.status, data: json };
    }
    return { error: false, data: json };
  } catch {
    captureFailure(path, { method: "PATCH", brandKey: body?.brand_key });
    return { error: true };
  }
}

// ---- Auth helpers -----------------------------------------------------------
export async function login(email, password) {
  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });
    const json = await res.json().catch(() => ({}));
    if (isMaintenanceStatus(res.status) || json?.error === "service_temporarily_unavailable") {
      return { error: true, unavailable: true, status: res.status, data: json };
    }
    if (!res.ok || !json.access_token)
      return { error: true, status: res.status, data: json };
    window.localStorage.setItem("gateway_access_token", json.access_token);
    window.localStorage.removeItem("gateway_refresh_token");
    return { error: false, data: json };
  } catch {
    return { error: true };
  }
}

export async function logout() {
  try {
    clearStoredAuth();
    await fetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
    });
  } catch {
    // ignore logout errors
  }
}

export async function me() {
  try {
    const res = await fetchWithAuth(`${API_BASE}/auth/me`);
    const json = await res.json().catch(() => ({}));
    if (
      isMaintenanceStatus(res.status) ||
      json?.error === "service_temporarily_unavailable"
    ) {
      return { authenticated: false, unavailable: true, status: res.status };
    }
    if (res.status === 401) return { authenticated: false, status: res.status };
    if (!res.ok) return { authenticated: false, status: res.status };
    return { authenticated: true, user: json.user, expiresAt: json.expiresAt };
  } catch {
    return { authenticated: false, unavailable: true };
  }
}

export async function getClientSettings() {
  try {
    const res = await fetchWithAuth(`${API_BASE}/auth/client-settings`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { dashboardBannerEnabled: false, error: true };
    return { dashboardBannerEnabled: !!json?.settings?.dashboardBannerEnabled };
  } catch {
    return { dashboardBannerEnabled: false, error: true };
  }
}

export async function updateClientSettings({ dashboardBannerEnabled }) {
  const res = await fetchWithAuth(`${API_BASE}/auth/admin/client-settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dashboard_banner_enabled: !!dashboardBannerEnabled }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { error: json?.error || "Failed to update settings" };
  return { dashboardBannerEnabled: !!json?.settings?.dashboardBannerEnabled };
}

export async function sendHeartbeat(meta = null) {
  try {
    const res = await fetch(`${API_BASE}/activity/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ meta }),
    });
    return { error: !res.ok };
  } catch {
    return { error: true };
  }
}

// ---- Author Access Control APIs -------------------------------------------
export async function getAccessControl() {
  return doGet("/author/access-control");
}
export async function setAccessMode(mode) {
  return doPost("/author/access-control/mode", { mode });
}
export async function setAccessSettings({ autoProvision }) {
  return doPost("/author/access-control/settings", { autoProvision });
}
export async function listWhitelist() {
  return doGet("/author/access-control/whitelist");
}
export async function addWhitelist(email, brand_key, notes) {
  return doPost("/author/access-control/whitelist", {
    email,
    brand_key,
    notes,
  });
}
export async function removeWhitelist(id) {
  return doDelete(`/author/access-control/whitelist/${id}`);
}

export async function onboardTenant(payload) {
  return doPost("/tenant/add", payload);
}

// ---- Merchant Requests ------------------------------------------------------
export async function listMerchantRequests(params = {}) {
  return doGet("/merchant-requests/", params);
}

export async function createMerchantRequest(payload) {
  return doPost("/merchant-requests/", payload);
}

export async function getMerchantRequest(id) {
  return doGet(`/merchant-requests/${encodeURIComponent(id)}`);
}

export async function addMerchantRequestComment(id, content) {
  return doPost(`/merchant-requests/${encodeURIComponent(id)}/comments`, { content });
}

export async function updateMerchantRequestStatus(id, status) {
  return doPatch(`/merchant-requests/${encodeURIComponent(id)}/status`, { status });
}

export async function updateMerchantRequestAssignee(id, todoist_user_id) {
  return doPatch(`/merchant-requests/${encodeURIComponent(id)}/assignee`, { todoist_user_id });
}

export async function updateMerchantRequestDueDate(id, due_date) {
  return doPatch(`/merchant-requests/${encodeURIComponent(id)}/due-date`, { due_date });
}

export async function updateMerchantRequestDeadline(id, deadline_date) {
  return doPatch(`/merchant-requests/${encodeURIComponent(id)}/deadline`, { deadline_date });
}

export async function deleteMerchantRequest(id) {
  return doDelete(`/merchant-requests/${encodeURIComponent(id)}`);
}

export async function listTodoistUsers() {
  return doGet("/merchant-requests/admin/todoist-users");
}

export async function reconcileMerchantRequests() {
  return doPost("/merchant-requests/admin/reconcile", {});
}

export async function listBrandConfigs() {
  return doGet("/merchant-requests/admin/brand-configs");
}

export async function listTodoistProjects({ refresh = false } = {}) {
  return doGet(
    "/merchant-requests/admin/todoist-projects",
    refresh ? { refresh: 1 } : {},
  );
}

export async function linkBrandProject(brand_key, todoist_project_id) {
  return doPost(`/merchant-requests/admin/brand-configs/${encodeURIComponent(brand_key)}/link`, {
    todoist_project_id,
  });
}

export async function triggerBrandProvision(brand_key) {
  return doPost(`/merchant-requests/admin/brand-configs/${encodeURIComponent(brand_key)}/provision`, {});
}

export async function updateBrandPriorityCaps(brand_key, priority_caps) {
  return doPatch(`/merchant-requests/admin/brand-configs/${encodeURIComponent(brand_key)}/priority-caps`, priority_caps);
}

export async function deleteBrandConfig(brand_key) {
  return doDelete(`/merchant-requests/admin/brand-configs/${encodeURIComponent(brand_key)}`);
}


// ---- Admin user management (Access Control) -------------------------------
export async function adminListUsers() {
  return doGet("/auth/admin/users");
}

export async function adminUpsertUser(payload) {
  return doPost("/auth/admin/users", payload);
}

export async function adminDeleteUser(email) {
  return doDelete(`/auth/admin/users/${encodeURIComponent(email)}`);
}

// ---- Admin custom roles (Access Control) -----------------------------------
export async function listCustomRoles() {
  return doGet("/auth/admin/custom-roles");
}

export async function getCustomRole(id) {
  return doGet(`/auth/admin/custom-roles/${encodeURIComponent(id)}`);
}

export async function createCustomRole(payload) {
  return doPost("/auth/admin/custom-roles", payload);
}

export async function updateCustomRole(id, payload) {
  return doPatch(`/auth/admin/custom-roles/${encodeURIComponent(id)}`, payload);
}

export async function deleteCustomRole(id) {
  return doDelete(`/auth/admin/custom-roles/${encodeURIComponent(id)}`);
}

// ---- Admin domain rules ---------------------------------------------------
export async function listDomainRules() {
  return doGet("/auth/admin/domain-rules");
}

export async function upsertDomainRule(payload) {
  return doPost("/auth/admin/domain-rules", payload);
}

export async function deleteDomainRule(domain) {
  return doDelete(`/auth/admin/domain-rules/${encodeURIComponent(domain)}`);
}

export async function getDashboardSummary(args) {
  const params = appendBrandKey(
    {
      ...args,
      start: args.start || args.date,
      end: args.end || args.date || args.start,
    },
    args,
  );
  const json = await getJSON("/metrics/summary", params);
  return {
    metrics: json?.metrics || null,
    range: json?.range || {
      start: params.start || null,
      end: params.end || null,
    },
    prev_range: json?.prev_range || null,
    filter_options: json?.filter_options || null,
    error: json?.__error,
  };
}

export async function getDataRestrictionConfig() {
  const res = await doGet("/metrics/data-restriction-config");
  if (res.error) {
    return { enabled: true, periodDays: 30, __error: true };
  }
  return {
    enabled:
      typeof res.data?.enabled === "boolean" ? res.data.enabled : true,
    periodDays: Number.isFinite(Number(res.data?.periodDays))
      ? Number(res.data.periodDays)
      : 30,
  };
}

export async function getWebPerformanceSummary(args) {
  const params = appendBrandKey(
    {
      start: args.start || args.date,
      end: args.end || args.date || args.start,
      timezone: args.timezone,
      compare_start: args.compare_start,
      compare_end: args.compare_end,
    },
    args,
  );
  const res = await doGet("/metrics/web-performance-summary", params);
  if (res.error) {
    return { __error: true };
  }
  return res.data || {};
}

export async function getOverallSnapshot(args = {}) {
  const params = {
    start: args.start || args.date,
    end: args.end || args.date || args.start,
    compare_start: args.compare_start,
    compare_end: args.compare_end,
    utm_source: args.utm_source,
    utm_medium: args.utm_medium,
    utm_campaign: args.utm_campaign,
    utm_term: args.utm_term,
    utm_content: args.utm_content,
    sales_channel: args.sales_channel,
    device_type: args.device_type,
    discount_code: args.discount_code,
    brand_keys: args.brand_keys,
  };
  const json = await getJSON("/metrics/summary/brands", params);
  return {
    range: json?.range || {
      start: params.start || null,
      end: params.end || null,
    },
    prev_range: json?.prev_range || null,
    metric_keys: Array.isArray(json?.metric_keys) ? json.metric_keys : [],
    brands: Array.isArray(json?.brands) ? json.brands : [],
    error: json?.__error,
  };
}

export async function getSummaryFilterOptions(args) {
  const params = appendBrandKey(
    {
      start: args.start || args.date,
      end: args.end || args.date || args.start,
      product_id: args.product_id,
    },
    args,
  );
  const json = await getJSON("/metrics/summary-filter-options", params);
  return {
    filter_options: json?.filter_options || null,
    error: json?.__error,
  };
}

// Product Types
export async function getProductTypes(args) {
  const params = appendBrandKey({ date: args.date }, args);
  const json = await getJSON("/metrics/product-types", params);
  return {
    types: Array.isArray(json?.types) ? json.types : [],
    date: json?.date || null,
    error: json?.__error,
  };
}

export async function fetchProductTypes(brandKey, start, end) {
  const params = { brand_key: brandKey };
  if (start) params.start = start;
  if (end) params.end = end;
  return getJSON("/metrics/product-types", params);
}

export async function getProductConversion(args, options = {}) {
  const params = appendBrandKey(
    {
      start: args.start,
      end: args.end,
      page: args.page,
      page_size: args.pageSize,
      sort_by: args.sortBy,
      sort_dir: args.sortDir,
      compare_start: args.compareStart,
      compare_end: args.compareEnd,
      search: args.search,
      filters: args.filters,
      // Add product_types and page_types support
      product_types:
        args.productTypes || args.product_types
          ? JSON.stringify(args.productTypes || args.product_types)
          : undefined,
      page_types:
        args.pageTypes || args.page_types
          ? JSON.stringify(args.pageTypes || args.page_types)
          : undefined,
      inventory_period: args.inventoryPeriod || "7d",
      inventory_only: args.inventoryOnly ? "true" : undefined,
    },
    args,
  );
  // Ensure product_types is serialized if needed, but getJSON/qs handles arrays automatically as multiple keys or we might need JSON.stringify if backend expects JSON string.
  // Backend expects: productTypes = typeof req.query.product_types === 'string' ? JSON.parse(...) : req.query.product_types;
  // So if we pass array here, qs() currently repeats keys: key=val1&key=val2.
  // Backend logic: productTypes = ... : req.query.product_types. If express sees multiple keys, it creates an array.
  // So standard array passing works. UNLESS backend specifically uses JSON.parse on it.
  // Backend code I wrote:
  // if (req.query.product_types) { ... JSON.parse ... : req.query.product_types }
  // So if it's an array (from qs repeating keys), JSON.parse might fail or not be needed.
  // Wait, if qs repeats keys, express body parser urlencoded extended: true makes it array?
  // Actually, axios/fetch with qs function I see in api.js:
  // qs function:
  // if (Array.isArray(v)) { v.forEach(val => parts.push(...)) }
  // So ?product_types=A&product_types=B.
  // Express req.query.product_types will be ['A', 'B'].
  // My backend code: typeof ... === 'string' ? JSON.parse : ...
  // If it's array, it falls to else, which is correct.
  // HOWEVER, implementing JSON.stringify explicitly is wider compatibility safely, like filters.
  // if (params.product_types) params.product_types = JSON.stringify(params.product_types);

  const res = await doGet("/metrics/product-conversion", params, {
    signal: options.signal,
  });
  if (res.aborted) return { error: true, aborted: true };
  if (res.error) return { error: true };
  const json = res.data || {};
  return {
    rows: Array.isArray(json?.rows) ? json.rows : [],
    total_count: Number(json?.total_count || 0),
    page: Number(json?.page || 1),
    page_size: Number(json?.page_size || Number(params.page_size) || 10),
    range: json?.range || null,
    error: false,
  };
}

export async function exportProductConversionCsv(args) {
  const params = appendBrandKey(
    {
      start: args.start,
      end: args.end,
      sort_by: args.sortBy,
      sort_dir: args.sortDir,
      // Fix: Serialize filters array to JSON string to avoid [object Object] in query string
      filters: args.filters ? JSON.stringify(args.filters) : undefined,
      search: args.search,
      visible_columns: args.visible_columns
        ? JSON.stringify(args.visible_columns)
        : undefined,
      compare_start: args.compareStart,
      compare_end: args.compareEnd,
      product_types:
        args.productTypes || args.product_types
          ? JSON.stringify(args.productTypes || args.product_types)
          : undefined,
      page_types:
        args.pageTypes || args.page_types
          ? JSON.stringify(args.pageTypes || args.page_types)
          : undefined,
    },
    args,
  );
  const dateSuffix = formatDateRangeSuffix(params.start, params.end);
  const fallbackName = dateSuffix
    ? `product_conversion_${dateSuffix}.csv`
    : "product_conversion.csv";
  const url = `${resolveApiBase()}/metrics/product-conversion/export${qs(params)}`;
  try {
    const res = await fetch(url, {
      credentials: "include",
      headers: { ...authHeaders() },
    });
    if (!res.ok) return { error: true, status: res.status };
    const blob = await res.blob();
    const fromHeader = filenameFromDisposition(
      res.headers.get("Content-Disposition"),
    );
    return { error: false, blob, filename: fromHeader || fallbackName };
  } catch (e) {
    console.error("API error product-conversion csv", e);
    return { error: true };
  }
}

export async function getBundleOptions(args, options = {}) {
  const params = appendBrandKey(
    {
      start: args.start,
      end: args.end,
    },
    args,
  );
  const res = await doGet("/metrics/bundles/options", params, {
    signal: options.signal,
  });
  if (res.error) return { error: true, bundles: [] };
  return {
    error: false,
    bundles: Array.isArray(res.data?.bundles) ? res.data.bundles : [],
  };
}

export async function getBundleSummary(args, options = {}) {
  const params = appendBrandKey(
    {
      start: args.start,
      end: args.end,
    },
    args,
  );
  const res = await doGet("/metrics/bundles/summary", params, {
    signal: options.signal,
  });
  if (res.error) return { error: true, rows: [] };
  return {
    error: false,
    rows: Array.isArray(res.data?.rows) ? res.data.rows : [],
  };
}

export async function exportBundleSummaryCsv(args) {
  const params = appendBrandKey(
    {
      start: args.start,
      end: args.end,
    },
    args,
  );
  const dateSuffix = formatDateRangeSuffix(params.start, params.end);
  const fallbackName = dateSuffix
    ? `bundle_summary_${dateSuffix}.csv`
    : "bundle_summary.csv";
  const url = `${resolveApiBase()}/metrics/bundles/summary/export${qs(params)}`;
  try {
    const res = await fetch(url, {
      credentials: "include",
      headers: { ...authHeaders() },
    });
    if (!res.ok) return { error: true, status: res.status };
    const blob = await res.blob();
    const fromHeader = filenameFromDisposition(
      res.headers.get("Content-Disposition"),
    );
    return { error: false, blob, filename: fromHeader || fallbackName };
  } catch (e) {
    console.error("API error bundles summary csv", e);
    return { error: true };
  }
}

export async function getBundleProducts(args, options = {}) {
  const bundleProductIds = args.bundle_product_id || args.bundleProductId || [];
  const normalizedBundleProductIds = Array.isArray(bundleProductIds)
    ? bundleProductIds
    : [bundleProductIds].filter(Boolean);
  const params = appendBrandKey(
    {
      start: args.start,
      end: args.end,
      bundle_product_id: normalizedBundleProductIds[0],
      bundle_product_ids: normalizedBundleProductIds.length > 0
        ? JSON.stringify(normalizedBundleProductIds)
        : undefined,
    },
    args,
  );
  const res = await doGet("/metrics/bundles/products", params, {
    signal: options.signal,
  });
  if (res.error) return { error: true, rows: [] };
  return {
    error: false,
    rows: Array.isArray(res.data?.rows) ? res.data.rows : [],
  };
}

export async function exportBundleProductsCsv(args) {
  const bundleProductIds = args.bundle_product_id || args.bundleProductId || [];
  const normalizedBundleProductIds = Array.isArray(bundleProductIds)
    ? bundleProductIds
    : [bundleProductIds].filter(Boolean);
  const params = appendBrandKey(
    {
      start: args.start,
      end: args.end,
      bundle_product_id: normalizedBundleProductIds[0],
      bundle_product_ids: normalizedBundleProductIds.length > 0
        ? JSON.stringify(normalizedBundleProductIds)
        : undefined,
    },
    args,
  );
  const dateSuffix = formatDateRangeSuffix(params.start, params.end);
  const fallbackName = dateSuffix
    ? `bundle_products_${dateSuffix}.csv`
    : "bundle_products.csv";
  const url = `${resolveApiBase()}/metrics/bundles/products/export${qs(params)}`;
  try {
    const res = await fetch(url, {
      credentials: "include",
      headers: { ...authHeaders() },
    });
    if (!res.ok) return { error: true, status: res.status };
    const blob = await res.blob();
    const fromHeader = filenameFromDisposition(
      res.headers.get("Content-Disposition"),
    );
    return { error: false, blob, filename: fromHeader || fallbackName };
  } catch (e) {
    console.error("API error bundles products csv", e);
    return { error: true };
  }
}

function shapeOrderSplitJson(json) {
  const unavailable = !!json?.payment_mode_unavailable;
  const cod_orders = unavailable ? null : Number(json?.cod_orders || 0);
  const prepaid_orders = unavailable ? null : Number(json?.prepaid_orders || 0);
  const partially_paid_orders = unavailable
    ? null
    : Number(json?.partially_paid_orders || 0);
  const total = Number(
    json?.total_orders_from_split ||
      (cod_orders || 0) + (prepaid_orders || 0) + (partially_paid_orders || 0),
  );
  const cod_percent = unavailable ? null : Number(json?.cod_percent || 0);
  const prepaid_percent = unavailable ? null : Number(json?.prepaid_percent || 0);
  const partially_paid_percent = unavailable
    ? null
    : Number(
        json?.partially_paid_percent ||
          (total > 0 ? (partially_paid_orders / total) * 100 : 0),
      );
  return {
    timezone: json?.timezone || "Asia/Kolkata",
    cod_orders,
    prepaid_orders,
    partially_paid_orders,
    total,
    cod_percent,
    prepaid_percent,
    partially_paid_percent,
    unavailable,
    error: json?.__error,
  };
}

function shapePaymentSalesSplitJson(json) {
  const unavailable = !!json?.payment_mode_unavailable;
  const cod_sales = unavailable ? null : Number(json?.cod_sales || 0);
  const prepaid_sales = unavailable ? null : Number(json?.prepaid_sales || 0);
  const partial_sales = unavailable ? null : Number(json?.partial_sales || 0);
  const total = Number(
    json?.total_sales_from_split ||
      (cod_sales || 0) + (prepaid_sales || 0) + (partial_sales || 0),
  );
  const cod_percent = unavailable ? null : Number(json?.cod_percent || 0);
  const prepaid_percent = unavailable ? null : Number(json?.prepaid_percent || 0);
  const partial_percent = unavailable
    ? null
    : Number(json?.partial_percent || (total > 0 ? (partial_sales / total) * 100 : 0));
  return {
    timezone: json?.timezone || "Asia/Kolkata",
    cod_sales,
    prepaid_sales,
    partial_sales,
    total,
    cod_percent,
    prepaid_percent,
    partial_percent,
    unavailable,
    error: json?.__error,
  };
}

export async function getOrderSplit(args) {
  const params = appendBrandKey(
    {
      start: args.start,
      end: args.end,
      product_id: args.product_id,
      hour_lte: args.hour_lte,
    },
    args,
  );
  const json = await getJSON("/metrics/order-split", params);
  return shapeOrderSplitJson(json);
}

export async function getPaymentSalesSplit(args) {
  const params = appendBrandKey(
    {
      start: args.start,
      end: args.end,
      product_id: args.product_id,
      hour_lte: args.hour_lte,
    },
    args,
  );
  const json = await getJSON("/metrics/payment-sales-split", params);
  return shapePaymentSalesSplitJson(json);
}

// Combines the 4 calls (order-count split + sales split, current + previous
// period) Mode of Payment used to make into 1 request. The backend runs the
// same 4 underlying queries in parallel; this just avoids 3 extra HTTP round
// trips per dashboard load.
export async function getPaymentSplitSummary(args) {
  const params = appendBrandKey(
    {
      start: args.start,
      end: args.end,
      compare_start: args.compare_start,
      compare_end: args.compare_end,
      product_id: args.product_id,
      hour_lte: args.hour_lte,
    },
    args,
  );
  const json = await getJSON("/metrics/payment-split-summary", params);
  return {
    current: {
      orders: shapeOrderSplitJson(json?.current?.orders || {}),
      sales: shapePaymentSalesSplitJson(json?.current?.sales || {}),
    },
    previous: {
      orders: json?.previous?.orders ? shapeOrderSplitJson(json.previous.orders) : null,
      sales: json?.previous?.sales ? shapePaymentSalesSplitJson(json.previous.sales) : null,
    },
    error: json?.__error,
  };
}

// One bucketed (hourly|daily) request instead of the old per-hour/per-day
// loop of getOrderSplit + getPaymentSalesSplit calls.
export async function getPaymentSplitTrend(args) {
  const params = appendBrandKey(
    {
      start: args.start,
      end: args.end,
      granularity: args.granularity || "daily",
      product_id: args.product_id,
      hour_lte: args.hour_lte,
    },
    args,
  );
  const json = await getJSON("/metrics/payment-split-trend", params);
  return {
    timezone: json?.timezone || "Asia/Kolkata",
    granularity: json?.granularity || params.granularity,
    range: json?.range || { start: args.start, end: args.end },
    points: Array.isArray(json?.points) ? json.points : [],
    error: json?.__error,
  };
}

export async function getTrafficSourceSplit(args) {
  const toDateString = (value) => {
    if (!value) return '';
    if (typeof value === 'string') {
      if (value.includes('T')) {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) {
          const adjusted = new Date(parsed.getTime() + 12 * 60 * 60 * 1000);
          return adjusted.toISOString().split('T')[0];
        }
      }
      return value.split('T')[0];
    }
    if (value instanceof Date) {
      const adjusted = new Date(value.getTime() + 12 * 60 * 60 * 1000);
      return adjusted.toISOString().split('T')[0];
    }
    return String(value);
  };

  const normalizeName = (name) => String(name || '').trim();

  const toTokens = (name) =>
    normalizeName(name)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);

  const normalizeRule = (rule) => {
    const type = String(rule?.matchType || rule?.type || '')
      .toLowerCase()
      .trim();
    const value = String(rule?.value || rule?.pattern || '')
      .toLowerCase()
      .trim();
    const bucket = String(rule?.bucket || rule?.category || '')
      .toLowerCase()
      .trim();
    if (!type || !value || !bucket) return null;
    if (!['equals', 'starts_with', 'contains'].includes(type)) return null;
    if (!['meta', 'google', 'direct', 'others'].includes(bucket)) return null;
    return { type, value, bucket };
  };

  const rulePriority = { equals: 1, starts_with: 2, contains: 3 };

  const matchesRule = (sourceLower, rule) => {
    if (rule.type === 'equals') return sourceLower === rule.value;
    if (rule.type === 'starts_with') return sourceLower.startsWith(rule.value);
    if (rule.type === 'contains') return sourceLower.includes(rule.value);
    return false;
  };

  const getCategory = (name, customRules = []) => {
    const lower = normalizeName(name).toLowerCase();
    const tokens = toTokens(name);

    for (const rule of customRules) {
      if (matchesRule(lower, rule)) return rule.bucket;
    }

    if (
      lower.includes('instagram') ||
      lower.includes('facebook') ||
      lower.includes('meta') ||
      tokens.includes('ig') ||
      tokens.includes('insta') ||
      tokens.includes('fb')
    ) {
      return 'meta';
    }
    if (lower.includes('google')) return 'google';
    if (lower.includes('direct')) return 'direct';
    return 'others';
  };

  const parseUtmSourceArray = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  };

  const calcDelta = (curr, prev) => {
    if (prev === 0) return curr > 0 ? 100 : 0;
    return ((curr - prev) / prev) * 100;
  };

  const base = { start: args.start, end: args.end };
  if (args.compare_start) base.compare_start = args.compare_start;
  if (args.compare_end) base.compare_end = args.compare_end;
  const params = appendBrandKey(base, args);
  const json = await getJSON("/metrics/traffic-source-split", params);

  const rows = Array.isArray(json?.rows) ? json.rows : [];
  const customRulesRaw = Array.isArray(args?.mappingRules)
    ? args.mappingRules
    : Array.isArray(args?.mapping_rules)
      ? args.mapping_rules
      : [];
  const customRules = customRulesRaw
    .map(normalizeRule)
    .filter(Boolean)
    .sort((a, b) => rulePriority[a.type] - rulePriority[b.type]);
  const currentStart = toDateString(args.start);
  const currentEnd = toDateString(args.end);

  const prevRange = json?.prev_range || null;
  const prevStart = toDateString(prevRange?.start);
  const prevEnd = toDateString(prevRange?.end);

  const initStats = () => ({ sessions: 0, atc_sessions: 0 });
  const current = {
    meta: initStats(),
    google: initStats(),
    direct: initStats(),
    others: initStats(),
  };
  const previous = {
    meta: initStats(),
    google: initStats(),
    direct: initStats(),
    others: initStats(),
  };

  const othersMap = new Map();
  const metaMap = new Map();

  for (const row of rows) {
    const rowDate = toDateString(row?.date);
    const isCurrent =
      !!rowDate && !!currentStart && !!currentEnd && rowDate >= currentStart && rowDate <= currentEnd;
    const isPrevious =
      !!rowDate && !!prevStart && !!prevEnd && rowDate >= prevStart && rowDate <= prevEnd;

    if (!isCurrent && !isPrevious) continue;

    const entries = parseUtmSourceArray(row?.utm_source);
    for (const entry of entries) {
      const sourceName = normalizeName(entry?.utm_name || 'Unknown') || 'Unknown';
      const category = getCategory(sourceName, customRules);
      const sessions = Number(entry?.sessions || 0);
      const atcSessions = Number(entry?.atc_sessions || 0);

      const target = isCurrent ? current : previous;
      target[category].sessions += sessions;
      target[category].atc_sessions += atcSessions;

      if (isCurrent && (category === 'meta' || category === 'others')) {
        const targetMap = category === 'meta' ? metaMap : othersMap;
        if (!targetMap.has(sourceName)) {
          targetMap.set(sourceName, { sessions: 0, atc_sessions: 0 });
        }
        const existing = targetMap.get(sourceName);
        existing.sessions += sessions;
        existing.atc_sessions += atcSessions;
      }
    }
  }

  const addDelta = (cat) => ({
    ...current[cat],
    delta: calcDelta(current[cat].sessions, previous[cat].sessions),
    atc_delta: calcDelta(current[cat].atc_sessions, previous[cat].atc_sessions),
    prev_sessions: previous[cat].sessions,
    prev_atc_sessions: previous[cat].atc_sessions,
  });

  const meta = addDelta('meta');
  const google = addDelta('google');
  const direct = addDelta('direct');
  const others = addDelta('others');

  const toBreakdown = (mapObj) =>
    Array.from(mapObj.entries())
      .map(([name, stats]) => ({
        name,
        sessions: Number(stats?.sessions || 0),
        atc_sessions: Number(stats?.atc_sessions || 0),
      }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 15);

  const total_sessions = meta.sessions + google.sessions + direct.sessions + others.sessions;
  const total_atc_sessions =
    meta.atc_sessions + google.atc_sessions + direct.atc_sessions + others.atc_sessions;

  return {
    meta,
    meta_breakdown: toBreakdown(metaMap),
    google,
    direct,
    others,
    others_breakdown: toBreakdown(othersMap),
    total_sessions: Number(total_sessions || 0),
    total_atc_sessions: Number(total_atc_sessions || 0),
    prev_range: prevRange,
    error: json?.__error,
  };
}

export async function getHourlySalesSummary(args = {}) {
  const params = appendBrandKey({}, args);
  const json = await getJSON("/metrics/hourly-sales-summary", params);
  return {
    data: json?.data || null,
    timezone: json?.timezone || "Asia/Kolkata",
    error: json?.__error,
  };
}

export async function getHourlyTrend(args) {
  const base = {
    start: args.start,
    end: args.end,
    aggregate: args.aggregate,
    compare: args.compare,
  };
  if (args.compare_start) base.compare_start = args.compare_start;
  if (args.compare_end) base.compare_end = args.compare_end;
  if (args.utm_source) base.utm_source = args.utm_source;
  if (args.utm_medium) base.utm_medium = args.utm_medium;
  if (args.utm_campaign) base.utm_campaign = args.utm_campaign;
  if (args.sales_channel) base.sales_channel = args.sales_channel;
  if (args.device_type) base.device_type = args.device_type;
  if (args.product_id) base.product_id = args.product_id;
  if (args.discount_code) base.discount_code = args.discount_code;
  if (args.product_type) base.product_type = args.product_type;
  const params = appendBrandKey(base, args);
  const json = await getJSON("/metrics/hourly-trend", params);
  const comparison = json?.comparison;
  return {
    points: Array.isArray(json?.points) ? json.points : [],
    range: json?.range || null,
    timezone: json?.timezone || "Asia/Kolkata",
    alignHour: typeof json?.alignHour === "number" ? json.alignHour : null,
    comparison: comparison
      ? {
          points: Array.isArray(comparison.points) ? comparison.points : [],
          range: comparison.range || null,
          alignHour:
            typeof comparison.alignHour === "number"
              ? comparison.alignHour
              : null,
          hourSampleCount: Array.isArray(comparison.hourSampleCount)
            ? comparison.hourSampleCount
            : null,
        }
      : null,
    error: json?.__error,
  };
}

export async function getDailyTrend(args) {
  const base = { start: args.start, end: args.end };
  if (args.compare_start) base.compare_start = args.compare_start;
  if (args.compare_end) base.compare_end = args.compare_end;
  if (args.utm_source) base.utm_source = args.utm_source;
  if (args.utm_medium) base.utm_medium = args.utm_medium;
  if (args.utm_campaign) base.utm_campaign = args.utm_campaign;
  if (args.sales_channel) base.sales_channel = args.sales_channel;
  if (args.device_type) base.device_type = args.device_type;
  if (args.product_id) base.product_id = args.product_id;
  if (args.discount_code) base.discount_code = args.discount_code;
  if (args.product_type) base.product_type = args.product_type;
  const params = appendBrandKey(base, args);
  const json = await getJSON("/metrics/daily-trend", params);
  return {
    days: Array.isArray(json?.days) ? json.days : [],
    comparison:
      json?.comparison && Array.isArray(json?.comparison?.days)
        ? { range: json.comparison.range || null, days: json.comparison.days }
        : null,
    range: json?.range || null,
    timezone: json?.timezone || "Asia/Kolkata",
    error: json?.__error,
  };
}

export async function getDailyFunnel(args = {}) {
  const params = appendBrandKey(
    {
      start: args.start,
      end: args.end,
      utm_date: args.utmDate,
      compare_utm_date: args.compareUtmDate,
      utm_source: args.utmSource || undefined,
      include_utm:
        typeof args.includeUtm === "boolean" ? String(args.includeUtm) : undefined,
      include_daily:
        typeof args.includeDaily === "boolean"
          ? String(args.includeDaily)
          : undefined,
    },
    args,
  );
  const json = await getJSON("/metrics/daily-funnel", params);
  return {
    rows: Array.isArray(json?.rows) ? json.rows : [],
    utmRows: Array.isArray(json?.utmRows) ? json.utmRows : [],
    utmDate: json?.utmDate || null,
    utmSource: json?.utmSource || null,
    utmCutoffHour: Number.isInteger(json?.utmCutoffHour) ? json.utmCutoffHour : null,
    range: json?.range || null,
    timezone: json?.timezone || "Asia/Kolkata",
    error: json?.__error,
  };
}

export async function getWebVitalsSnapshot(args = {}) {
  const params = appendBrandKey({ date: args.date }, args);
  const json = await getJSON("/web-vitals/snapshot", params);
  return {
    date: json?.date || null,
    previousDate: json?.previousDate || null,
    sampleCount: Number(json?.sampleCount || 0),
    previousSampleCount: Number(json?.previousSampleCount || 0),
    metrics: json?.metrics || {},
    previousMetrics: json?.previousMetrics || {},
    error: json?.__error,
  };
}

export async function getWebVitalsAllBrandsSnapshot(args = {}) {
  const json = await getJSON("/web-vitals/all-brands-snapshot", { date: args.date });
  return {
    date: json?.date || null,
    brands: Array.isArray(json?.brands) ? json.brands : [],
    error: json?.__error,
  };
}

export async function getWebVitalsTrend(args = {}) {
  const params = appendBrandKey(
    {
      start: args.start,
      end: args.end,
      granularity: args.granularity || "daily",
    },
    args,
  );
  const json = await getJSON("/web-vitals/trend", params);
  return {
    granularity: json?.granularity || "daily",
    points: Array.isArray(json?.points) ? json.points : [],
    error: json?.__error,
  };
}

export async function getWebVitalsPages(args = {}) {
  const params = appendBrandKey({ date: args.date }, args);
  const json = await getJSON("/web-vitals/pages", params);
  return {
    date: json?.date || null,
    rows: Array.isArray(json?.rows) ? json.rows : [],
    error: json?.__error,
  };
}

export async function getMonthlyTrend(args) {
  const base = { start: args.start, end: args.end };
  if (args.compare_start) base.compare_start = args.compare_start;
  if (args.compare_end) base.compare_end = args.compare_end;
  if (args.utm_source) base.utm_source = args.utm_source;
  if (args.utm_medium) base.utm_medium = args.utm_medium;
  if (args.utm_campaign) base.utm_campaign = args.utm_campaign;
  if (args.sales_channel) base.sales_channel = args.sales_channel;
  if (args.device_type) base.device_type = args.device_type;
  if (args.product_id) base.product_id = args.product_id;
  if (args.discount_code) base.discount_code = args.discount_code;
  if (args.product_type) base.product_type = args.product_type;
  const params = appendBrandKey(base, args);
  const json = await getJSON("/metrics/monthly-trend", params);
  return {
    points: Array.isArray(json?.points) ? json.points : [],
    comparison:
      json?.comparison && Array.isArray(json?.comparison?.points)
        ? {
            range: json.comparison.range || null,
            points: json.comparison.points,
          }
        : null,
    range: json?.range || null,
    timezone: json?.timezone || "Asia/Kolkata",
    error: json?.__error,
  };
}

export async function getTopProducts(args = {}) {
  const params = appendBrandKey(
    {
      start: args.start,
      end: args.end,
      limit: args.limit,
      utm_source: args.utm_source,
    },
    args,
  );
  const json = await getJSON("/metrics/top-products", params);
  const products = Array.isArray(json?.products)
    ? json.products.map((p) => ({
        product_id: p.product_id,
        landing_page_path: p.landing_page_path || p.path || null,
        sessions: Number(p.sessions || p.total_sessions || 0),
        sessions_with_cart_additions: Number(
          p.sessions_with_cart_additions || p.total_atc_sessions || 0,
        ),
        add_to_cart_rate: Number(p.add_to_cart_rate || 0),
        add_to_cart_rate_pct: Number(
          p.add_to_cart_rate_pct ||
            (p.add_to_cart_rate ? p.add_to_cart_rate * 100 : 0),
        ),
      }))
    : [];
  return { products, error: json?.__error };
}

export async function getProductKpis(args = {}) {
  const params = appendBrandKey(
    { start: args.start, end: args.end, product_id: args.product_id },
    args,
  );
  const json = await getJSON("/metrics/product-kpis", params);
  const sessions = Number(json?.sessions || 0);
  const atcSessions = Number(json?.sessions_with_cart_additions || 0);
  const totalOrders = Number(json?.total_orders || 0);
  const totalSales = Number(json?.total_sales || 0);
  const addToCartRate =
    typeof json?.add_to_cart_rate === "number"
      ? json.add_to_cart_rate
      : sessions > 0
        ? atcSessions / sessions
        : 0;
  const conversionRate =
    typeof json?.conversion_rate === "number"
      ? json.conversion_rate
      : sessions > 0
        ? totalOrders / sessions
        : 0;
  const rtoOrders = Number(json?.rto_orders || 0);
  const rtoRate =
    typeof json?.rto_rate === "number"
      ? json.rto_rate
      : totalOrders > 0
        ? rtoOrders / totalOrders
        : 0;

  return {
    product_id: json?.product_id || args.product_id,
    range: json?.range || { start: args.start || null, end: args.end || null },
    sessions,
    sessions_with_cart_additions: atcSessions,
    add_to_cart_rate: addToCartRate,
    add_to_cart_rate_pct: addToCartRate * 100,
    total_orders: totalOrders,
    total_sales: totalSales,
    rto_orders: rtoOrders,
    rto_rate: rtoRate,
    rto_rate_pct: rtoRate * 100,
    conversion_rate: conversionRate,
    conversion_rate_pct: conversionRate * 100,
    brand_key: json?.brand_key || null,
    error: json?.__error,
  };
}

// Fetch last updated timestamp from external service using same-origin API base to avoid CORS issues
export async function getLastUpdatedPTS(arg = undefined) {
  let brandKey = "";
  if (typeof arg === "string") {
    brandKey = normalizeBrandKey(arg);
  } else if (arg && typeof arg === "object") {
    brandKey = normalizeBrandKey(arg.brandKey);
  }
  const search = brandKey ? `?brand_key=${encodeURIComponent(brandKey)}` : "";
  const url = `${API_BASE}/external/last-updated/pts${search}`;
  try {
    const res = await fetchWithAuth(url, { cache: "no-store" });
    if (!res.ok) throw new Error("Failed");
    const json = await res.json();
    console.log("Last updated PTS response: ", json);
    return {
      raw: json["Last successful run completed at"],
      timezone: json.timezone,
      error: false,
    };
  } catch (e) {
    console.error("Last updated fetch error", e);
    return { raw: null, timezone: null, error: true };
  }
}

export async function getDashboardLayout() {
  const res = await doGet("/dashboard/layout");
  if (res.error) return res;
  return { error: false, data: res.data };
}

export async function saveDashboardLayout(payload) {
  return doPost("/dashboard/layout", payload);
}

export async function getDailyInsight({ brandKey, date } = {}) {
  const res = await doGet("/daily-insights", { brand_key: normalizeBrandKey(brandKey), date });
  if (res.error) return res;
  return { error: false, data: res.data?.data ?? null };
}

export async function listDailyInsights({ brandKey, limit, before } = {}) {
  const res = await doGet("/daily-insights/history", {
    brand_key: normalizeBrandKey(brandKey),
    limit,
    before,
  });
  if (res.error) return res;
  return { error: false, data: res.data?.data ?? [] };
}

export async function saveDailyInsight({ brandKey, date, insight }) {
  // brand_key must be in the query string (not just the JSON body) — the
  // gateway's brand-context resolution only reads request headers/query args,
  // so a body-only brand_key silently falls back to the caller's default brand.
  const normalizedBrandKey = normalizeBrandKey(brandKey);
  const res = await doPost(`/daily-insights${qs({ brand_key: normalizedBrandKey })}`, {
    brand_key: normalizedBrandKey,
    date,
    insight,
  });
  if (res.error) return res;
  return { error: false, data: res.data?.data ?? null };
}

export async function deleteDailyInsight({ brandKey, date }) {
  const normalizedBrandKey = normalizeBrandKey(brandKey);
  const res = await doDelete(
    `/daily-insights${qs({ brand_key: normalizedBrandKey, date })}`,
  );
  if (res.error) return res;
  return { error: false, data: res.data?.data ?? null };
}

// Health Monitor — global infra observability data, not brand-scoped, so
// these never call appendBrandKey.
export async function getHealthMonitorSummary() {
  const res = await doGet("/health-monitor/summary", {});
  if (res.error) return { error: true, status: res.status, data: res.data };
  return { error: false, data: res.data || {} };
}

export async function getHealthMonitorServices() {
  const res = await doGet("/health-monitor/services", {});
  if (res.error) return { error: true, status: res.status, data: res.data };
  return { error: false, data: Array.isArray(res.data?.services) ? res.data.services : [] };
}

export async function getHealthMonitorServiceDetail(serviceName) {
  const res = await doGet(`/health-monitor/services/${encodeURIComponent(serviceName)}`, {});
  if (res.error) return { error: true, status: res.status, data: res.data };
  return { error: false, data: res.data || null };
}

export async function getHealthMonitorEndpointHistory({ serviceName, endpoint, range }) {
  const res = await doGet(
    `/health-monitor/services/${encodeURIComponent(serviceName)}/endpoints/history`,
    { endpoint, range },
  );
  if (res.error) return { error: true, status: res.status, data: res.data };
  return { error: false, data: res.data || { buckets: [], availabilityPct: null } };
}

export async function getHealthMonitorIncidents(filters = {}) {
  const params = {
    status: filters.status,
    severity: filters.severity,
    service: filters.service,
    from: filters.from,
    to: filters.to,
    page: filters.page,
    pageSize: filters.pageSize,
  };
  const res = await doGet("/health-monitor/incidents", params);
  if (res.error) return { error: true, status: res.status, data: res.data };
  return { error: false, data: res.data || { incidents: [], page: 1, pageSize: 25, total: 0 } };
}

export async function getSessionAnalyticsSummary(args = {}) {
  const params = appendBrandKey(
    {
      from: args.from,
      to: args.to,
      brand: args.brand,
      user: args.user,
    },
    { ...args, brand_key: args.brand || args.brand_key },
  );
  const res = await doGet("/session-analytics/summary", params);
  if (res.error) return { error: true, status: res.status, data: res.data };
  return { error: false, data: res.data || {} };
}

export async function getSessionAnalyticsTrend(args = {}) {
  const params = appendBrandKey(
    {
      from: args.from,
      to: args.to,
      brand: args.brand,
      user: args.user,
      granularity: args.granularity,
    },
    { ...args, brand_key: args.brand || args.brand_key },
  );
  const res = await doGet("/session-analytics/trend", params);
  if (res.error) return { error: true, status: res.status, data: res.data };
  return {
    error: false,
    data: Array.isArray(res.data) ? res.data : [],
  };
}

export async function getSessionAnalyticsInsights(args = {}) {
  const params = appendBrandKey(
    {
      from: args.from,
      to: args.to,
      brand: args.brand,
      user: args.user,
    },
    { ...args, brand_key: args.brand || args.brand_key },
  );
  const res = await doGet("/session-analytics/insights", params);
  if (res.error) return { error: true, status: res.status, data: res.data };
  return { error: false, data: res.data || {} };
}

export async function getSessionAnalyticsBrands(args = {}) {
  const params = appendBrandKey(
    {
      from: args.from,
      to: args.to,
      brand: args.brand,
      user: args.user,
    },
    { ...args, brand_key: args.brand || args.brand_key },
  );
  const res = await doGet("/session-analytics/brands", params);
  if (res.error) return { error: true, status: res.status, data: res.data };
  return {
    error: false,
    data: Array.isArray(res.data) ? res.data : [],
  };
}

export async function getSessionAnalyticsUsers(args = {}) {
  const params = appendBrandKey(
    {
      from: args.from,
      to: args.to,
      brand: args.brand,
      user: args.user,
      page: args.page,
      limit: args.limit,
      search: args.search,
      sort: args.sort,
      direction: args.direction,
      actor_type: args.actor_type,
    },
    { ...args, brand_key: args.brand || args.brand_key },
  );
  const res = await doGet("/session-analytics/users", params);
  if (res.error) return { error: true, status: res.status, data: res.data };
  return {
    error: false,
    data: {
      rows: Array.isArray(res.data?.rows) ? res.data.rows : [],
      total: Number(res.data?.total || 0),
    },
  };
}

export async function getSessionAnalyticsFilters(args = {}) {
  const params = appendBrandKey(
    {
      from: args.from,
      to: args.to,
      brand: args.brand,
    },
    { ...args, brand_key: args.brand || args.brand_key },
  );
  const res = await doGet("/session-analytics/filters", params);
  if (res.error) return { error: true, status: res.status, data: res.data };
  return {
    error: false,
    data: {
      brands: Array.isArray(res.data?.brands) ? res.data.brands : [],
      users: Array.isArray(res.data?.users) ? res.data.users : [],
    },
  };
}

async function exportSessionAnalyticsCsv(path, args = {}, fallbackName) {
  const params = appendBrandKey(
    {
      from: args.from,
      to: args.to,
      brand: args.brand,
      user: args.user,
      search: args.search,
      sort: args.sort,
      direction: args.direction,
      actor_type: args.actor_type,
    },
    { ...args, brand_key: args.brand || args.brand_key },
  );
  const url = `${resolveApiBase()}${path}${qs(params)}`;
  try {
    const res = await fetch(url, {
      credentials: "include",
      headers: { ...authHeaders() },
    });
    if (!res.ok) return { error: true, status: res.status };
    const blob = await res.blob();
    const fromHeader = filenameFromDisposition(
      res.headers.get("Content-Disposition"),
    );
    return {
      error: false,
      blob,
      filename: fromHeader || fallbackName,
    };
  } catch (error) {
    console.error("Session analytics export failed", error);
    return { error: true };
  }
}

export async function exportSessionAnalyticsBrandsCsv(args = {}) {
  const dateSuffix = formatDateRangeSuffix(args.from, args.to);
  return exportSessionAnalyticsCsv(
    "/session-analytics/brands/export",
    args,
    dateSuffix ? `session_brands_${dateSuffix}.csv` : "session_brands.csv",
  );
}

export async function exportSessionAnalyticsUsersCsv(args = {}) {
  const dateSuffix = formatDateRangeSuffix(args.from, args.to);
  return exportSessionAnalyticsCsv(
    "/session-analytics/users/export",
    args,
    dateSuffix ? `session_users_${dateSuffix}.csv` : "session_users.csv",
  );
}

// Author brands helper (list)
export async function listAuthorBrands() {
  const res = await doGet("/tenant/brands");
  if (res.error) return res;
  // data is { "1": "PTS", "2": "BBB" }
  const brands = Object.entries(res.data || {}).map(([, id]) => ({
    key: id.toString().toUpperCase()
  }));
  return { error: false, data: { brands } };
}

// ---------------- Author: Alerts admin ----------------
export async function listAlerts(params) {
  return doGet("/alerts", params);
}

export async function createAlert(payload) {
  return doPost("/alerts", payload);
}

export async function updateAlert(id, payload) {
  return doPut(`/alerts/${id}`, payload);
}

export async function deleteAlert(id) {
  return doDelete(`/alerts/${id}`);
}

export async function setAlertActive(id, isActive) {
  return doPost(`/alerts/${id}/status`, { is_active: isActive ? 1 : 0 });
}
