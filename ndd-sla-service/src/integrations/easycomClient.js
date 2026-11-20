// EasyCom shipments client, driven ENTIRELY by configuration: no URL, endpoint, header name, parameter name, response
// shape or field name is assumed in code (none of them is known yet; see .env.example). The client yields one page at
// a time, already reduced to { reference, pickedAtRaw }, so the caller never holds more than one page.
//
// config.easycom = {
//   baseUrl, endpoint,
//   auth:  { mode: "bearer" | "header" | "query" | "none", headerName, queryParam },   // token comes from getToken()
//   query: { ...static query params },
//   dateParams: { fromParam, toParam },          // optional: how the order-date range is sent (values "YYYY-MM-DD HH:mm:ss")
//   pagination: { mode: "page" | "offset" | "cursor", pageSize, pageSizeParam, pageParam, startPage, offsetParam, cursorParam },
//   response: { itemsPath, nextCursorPath, hasMorePath },    // dot paths into the JSON body
//   fields: { reference, pickedAt },                         // dot paths into each item
//   maxPages, timeoutMs, retries, retryBaseMs,
// }
const { PipelineError } = require("../errors");
const { ensureLogger } = require("../logger");

function getPath(obj, path) {
  if (!path) return undefined;
  let cur = obj;
  for (const key of String(path).split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

// What must be configured before this client can run. Used by worker start-up and by tests.
function missingEasycomConfig(cfg) {
  const missing = [];
  const need = (ok, name) => { if (!ok) missing.push(name); };
  need(cfg.baseUrl, "NDD_EASYCOM_BASE_URL");
  need(cfg.endpoint, "NDD_EASYCOM_ENDPOINT");
  need(cfg.response && cfg.response.itemsPath, "NDD_EASYCOM_ITEMS_PATH");
  need(cfg.fields && cfg.fields.reference, "NDD_EASYCOM_FIELD_REFERENCE");
  need(cfg.fields && cfg.fields.pickedAt, "NDD_EASYCOM_FIELD_PICKED_AT");
  const mode = cfg.pagination && cfg.pagination.mode;
  need(["page", "offset", "cursor"].includes(mode), "NDD_EASYCOM_PAGINATION_MODE (page|offset|cursor)");
  if (mode === "cursor") {
    need(cfg.pagination.cursorParam, "NDD_EASYCOM_CURSOR_PARAM");
    need(cfg.response.nextCursorPath, "NDD_EASYCOM_NEXT_CURSOR_PATH");
  }
  if (mode === "page") need(cfg.pagination.pageParam, "NDD_EASYCOM_PAGE_PARAM");
  if (mode === "offset") need(cfg.pagination.offsetParam, "NDD_EASYCOM_OFFSET_PARAM");
  if (mode === "page" || mode === "offset") need(cfg.pagination.pageSizeParam, "NDD_EASYCOM_PAGE_SIZE_PARAM");
  const auth = (cfg.auth && cfg.auth.mode) || "";
  need(["bearer", "header", "query", "none"].includes(auth), "NDD_EASYCOM_AUTH_MODE (bearer|header|query|none)");
  if (auth === "header") need(cfg.auth.headerName, "NDD_EASYCOM_AUTH_HEADER");
  if (auth === "query") need(cfg.auth.queryParam, "NDD_EASYCOM_AUTH_QUERY_PARAM");
  return missing;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildEasycomClient({ config, getToken, fetchImpl = globalThis.fetch, logger, sleepImpl = sleep }) {
  const log = ensureLogger(logger, "easycom");
  const missing = missingEasycomConfig(config);
  if (missing.length) throw new PipelineError("EASYCOM_CONFIG_MISSING", `Missing EasyCom config: ${missing.join(", ")}`);

  const pagination = config.pagination;
  const pageSize = Number(pagination.pageSize) || 100;
  const maxPages = Number(config.maxPages) || 1000;
  const retries = config.retries ?? 3;
  const retryBaseMs = config.retryBaseMs ?? 500;
  const timeoutMs = config.timeoutMs ?? 30000;

  async function requestOnce(params) {
    const url = new URL(config.endpoint, config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`);
    for (const [k, v] of Object.entries({ ...(config.query || {}), ...params })) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const headers = { Accept: "application/json" };
    const auth = config.auth || { mode: "none" };
    if (auth.mode !== "none") {
      const token = await getToken();
      if (auth.mode === "bearer") headers.Authorization = `Bearer ${token}`;
      else if (auth.mode === "header") headers[auth.headerName] = token;
      else if (auth.mode === "query") url.searchParams.set(auth.queryParam, token);
    }
    return fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
  }

  // Transient failures (network, timeout, 429, 5xx) are retried here with exponential backoff; 401/403 and other 4xx
  // are not, because repeating them cannot help.
  async function request(params) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let res;
      try {
        res = await requestOnce(params);
      } catch (err) {
        if (err instanceof PipelineError) throw err;
        lastError = new PipelineError("EASYCOM_NETWORK", `EasyCom request failed: ${err.message}`, { retryable: true, cause: err });
      }
      if (res) {
        if (res.ok) {
          try {
            return await res.json();
          } catch (err) {
            throw new PipelineError("EASYCOM_BAD_RESPONSE", "EasyCom returned a body that is not JSON");
          }
        }
        if (res.status === 401 || res.status === 403) {
          throw new PipelineError("EASYCOM_AUTH", `EasyCom rejected the credentials (HTTP ${res.status})`);
        }
        if (res.status !== 429 && res.status < 500) {
          throw new PipelineError("EASYCOM_HTTP", `EasyCom returned HTTP ${res.status}`);
        }
        lastError = new PipelineError("EASYCOM_UNAVAILABLE", `EasyCom returned HTTP ${res.status}`, { retryable: true });
        const retryAfter = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
        if (attempt < retries) {
          await sleepImpl(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : retryBaseMs * 2 ** attempt);
          continue;
        }
      }
      if (attempt < retries) await sleepImpl(retryBaseMs * 2 ** attempt);
    }
    throw lastError;
  }

  // Async generator of pages: { page, items: [{ reference, pickedAtRaw }], rawCount }.
  // `range` = { from, to } wall strings; sent only if dateParams are configured.
  async function* fetchShipments(range = {}) {
    const dp = config.dateParams || {};
    const base = {};
    if (dp.fromParam && range.from) base[dp.fromParam] = range.from;
    if (dp.toParam && range.to) base[dp.toParam] = range.to;
    if (pagination.mode !== "cursor") base[pagination.pageSizeParam] = pageSize;

    let cursor = null;
    let pageNo = Number(pagination.startPage ?? 1);
    let offset = 0;

    for (let fetched = 0; fetched < maxPages; fetched += 1) {
      const params = { ...base };
      if (pagination.mode === "page") params[pagination.pageParam] = pageNo;
      else if (pagination.mode === "offset") params[pagination.offsetParam] = offset;
      else if (cursor) params[pagination.cursorParam] = cursor;
      if (pagination.mode === "cursor" && pagination.pageSizeParam) params[pagination.pageSizeParam] = pageSize;

      const body = await request(params);
      const raw = getPath(body, config.response.itemsPath);
      if (!Array.isArray(raw)) {
        throw new PipelineError("EASYCOM_BAD_RESPONSE", `EasyCom response has no array at "${config.response.itemsPath}"`);
      }
      const items = raw.map((item) => ({
        reference: getPath(item, config.fields.reference),
        pickedAtRaw: getPath(item, config.fields.pickedAt),
      }));
      log.debug("easycom page", { page: fetched + 1, items: raw.length });
      yield { page: fetched + 1, items, rawCount: raw.length };

      let more;
      if (pagination.mode === "cursor") {
        cursor = getPath(body, config.response.nextCursorPath);
        more = Boolean(cursor) && raw.length > 0;
      } else {
        more = raw.length >= pageSize;
        if (config.response.hasMorePath) {
          const flag = getPath(body, config.response.hasMorePath);
          if (flag !== undefined) more = Boolean(flag) && raw.length > 0;
        }
        pageNo += 1;
        offset += raw.length;
      }
      if (!more) return;
    }
    throw new PipelineError("EASYCOM_TOO_MANY_PAGES", `EasyCom pagination did not end within ${maxPages} pages (NDD_EASYCOM_MAX_PAGES)`);
  }

  return { fetchShipments };
}

module.exports = { buildEasycomClient, missingEasycomConfig, getPath };
