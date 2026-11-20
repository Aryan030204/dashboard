// Central configuration. The report-window rules are REQUIRED and have no defaults: which end of the window names
// the report, and the 12 PM / 3 PM start times, are business decisions (see the plan, section K1). Guessing them in
// code would silently produce wrong reports, so a missing value fails at startup instead.

const ANCHORS = Object.freeze(["end", "start"]);

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseClock(value, name) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!match || hour > 23 || minute > 59) {
    throw new Error(`${name} must be HH:mm (24-hour), got "${value || ""}"`);
  }
  return { hour, minute };
}

// Returns the window rules as plain numbers. Throws a readable error listing every problem at once.
function readWindowRules(env = process.env) {
  const problems = [];
  // Confirmed business rules are the defaults (report date = the date the window ENDS on; NDD window starts 12:00, everything
  // else 15:00). An empty variable counts as unset, so a copied-but-unfilled .env cannot break start-up. An explicit but
  // invalid value is still an error.
  const anchor = String(env.NDD_SLA_REPORT_DATE_ANCHOR || "end").trim().toLowerCase();
  if (!ANCHORS.includes(anchor)) problems.push(`NDD_SLA_REPORT_DATE_ANCHOR must be one of ${ANCHORS.join("|")}`);

  let nddStart;
  let otherStart;
  try {
    nddStart = parseClock(env.NDD_SLA_NDD_START_TIME || "12:00", "NDD_SLA_NDD_START_TIME");
  } catch (err) {
    problems.push(err.message);
  }
  try {
    otherStart = parseClock(env.NDD_SLA_OTHER_START_TIME || "15:00", "NDD_SLA_OTHER_START_TIME");
  } catch (err) {
    problems.push(err.message);
  }

  const lengthHours = toInt(env.NDD_SLA_WINDOW_LENGTH_HOURS, 24);
  if (!(lengthHours > 0 && lengthHours <= 72)) problems.push("NDD_SLA_WINDOW_LENGTH_HOURS must be between 1 and 72");

  if (problems.length) throw new Error(`Invalid NDD/SLA window configuration: ${problems.join("; ")}`);
  return { anchor, nddStart, otherStart, lengthHours };
}

function parseJson(value, name, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`${name} must be valid JSON: ${err.message}`);
  }
}

const aliasList = (value, fallback) => (value ? String(value).split(",").map((x) => x.trim()).filter(Boolean) : fallback);
const opt = (value) => (value === undefined || value === "" ? undefined : value);

function getConfig(env = process.env) {
  return {
    nodeEnv: env.NODE_ENV || "development",
    port: toInt(env.PORT, 4050),
    brandKey: String(env.NDD_SLA_BRAND_KEY || "AJMAL").trim().toUpperCase(),
    timezone: env.NDD_SLA_TIMEZONE || "Asia/Kolkata",
    db: {
      host: env.NDD_DB_HOST || "",
      port: toInt(env.NDD_DB_PORT, 3306),
      user: env.NDD_DB_USER || "",
      password: env.NDD_DB_PASSWORD || "",
      database: env.NDD_DB_NAME || "",
      connectionLimit: toInt(env.NDD_DB_POOL, 5),
    },
    window: readWindowRules(env),
    columns: {
      reference: env.NDD_SLA_COL_REFERENCE || "Reference Code",
      clientLocation: env.NDD_SLA_COL_CLIENT_LOCATION || "Client Location",
      orderStatus: env.NDD_SLA_COL_ORDER_STATUS || "Order Status",
      courier: env.NDD_SLA_COL_COURIER || "Courier",
      orderDate: env.NDD_SLA_COL_ORDER_DATE || "Order Date",
    },
    // Other header spellings accepted when the preferred name above is absent (comma-separated env override replaces them).
    columnAliases: {
      reference: aliasList(env.NDD_SLA_COL_REFERENCE_ALIASES, ["Reference Code", "Reference No", "Order Reference", "Order No"]),
      clientLocation: aliasList(env.NDD_SLA_COL_CLIENT_LOCATION_ALIASES, ["Client Location", "Client", "Location", "Warehouse"]),
      orderStatus: aliasList(env.NDD_SLA_COL_ORDER_STATUS_ALIASES, ["Order Status", "Status"]),
      courier: aliasList(env.NDD_SLA_COL_COURIER_ALIASES, ["Courier", "Courier Name", "Courier Partner", "Courier Aggregator Name"]),
      orderDate: aliasList(env.NDD_SLA_COL_ORDER_DATE_ALIASES, ["Order Date", "Order Created At", "Order Datetime", "Import Date"]),
    },
    limits: {
      dbBatchRows: toInt(env.NDD_SLA_DB_BATCH_ROWS, 1000),
      // No default: the real ceiling must come from benchmarking with actual file sizes.
      // Safety guard against exhausting the worker (768 MB): a kept order is a few hundred bytes. NOT a benchmarked
      // figure; raise or lower it once real file sizes are known. Exceeding it fails the run with INPUT_TOO_LARGE.
      maxKeptRows: toInt(env.NDD_SLA_MAX_KEPT_ROWS, 250000),
      maxAttachmentBytes: toInt(env.NDD_SLA_MAX_ATTACHMENT_BYTES, 25 * 1024 * 1024),
    },
    gatewaySharedSecret: env.GATEWAY_SHARED_SECRET || "",
    allowInsecureAuth: String(env.ALLOW_INSECURE_AUTH || "").toLowerCase() === "true",
    pollMs: toInt(env.NDD_SLA_POLL_MS, 60000),
    passwordAesKey: env.PASSWORD_AES_KEY || "",
    tmpDir: env.NDD_SLA_TMP_DIR || require("os").tmpdir(),

    // Ingestion modes. AUTO = worker (Gmail + EasyCom API). MANUAL = authors upload both files. Both can be on.
    // With AUTO off the worker does nothing (it idles), so no Gmail/EasyCom configuration is needed.
    autoEnabled: String(env.NDD_SLA_AUTO_ENABLED === undefined ? "true" : env.NDD_SLA_AUTO_ENABLED).toLowerCase() !== "false",
    uploadEnabled: String(env.NDD_SLA_UPLOAD_ENABLED === undefined ? "true" : env.NDD_SLA_UPLOAD_ENABLED).toLowerCase() !== "false",
    upload: {
      maxBytes: toInt(env.NDD_SLA_MAX_UPLOAD_BYTES, 30 * 1024 * 1024), // per file as sent (may be gzip)
      maxExpandedBytes: toInt(env.NDD_SLA_MAX_EXPANDED_BYTES, 150 * 1024 * 1024), // per file after un-gzipping (zip-bomb guard)
      // Same safety idea as limits.maxKeptRows, tighter because the API container is smaller than the worker.
      maxKeptRows: toInt(env.NDD_SLA_UPLOAD_MAX_KEPT_ROWS, 100000),
      // Column names inside the uploaded EasyCom export. Defaults are the PRD labels; verify against a real export.
      easycomColumns: {
        reference: env.NDD_SLA_EASYCOM_FILE_COL_REFERENCE || "Reference Code",
        pickedAt: env.NDD_SLA_EASYCOM_FILE_COL_PICKED_AT || "Shipment(Pickup At)",
      },
      easycomColumnAliases: {
        reference: aliasList(env.NDD_SLA_EASYCOM_FILE_COL_REFERENCE_ALIASES, ["Reference Code", "Reference No", "Order Reference", "Order No"]),
        pickedAt: aliasList(env.NDD_SLA_EASYCOM_FILE_COL_PICKED_AT_ALIASES, ["Shipment Picked At", "Shipment Pickup At", "Shipment Picked Up At", "Pickup At", "Picked At", "Pickup Date", "Pickup Time"]),
      },
    },

    // Worker behaviour. Provisional knobs, not business rules.
    worker: {
      maxAttempts: toInt(env.NDD_SLA_MAX_ATTEMPTS, 5), // failed attempts before a run is left failed for good
      backoffBaseMs: toInt(env.NDD_SLA_BACKOFF_BASE_MS, 60000),
      backoffMaxMs: toInt(env.NDD_SLA_BACKOFF_MAX_MS, 30 * 60000),
      pauseMaxMs: toInt(env.NDD_SLA_PAUSE_MAX_MINUTES, 30) * 60000, // a paused report is cancelled after this long
      lockStaleMs: toInt(env.NDD_SLA_LOCK_STALE_MS, 15 * 60000), // a lock this old without a heartbeat is a dead worker
      gokwikDeadlineHours: toInt(env.NDD_SLA_GOKWIK_DEADLINE_HOURS, 24), // after the window closes, waiting longer = GOKWIK_TIMEOUT
      lookbackDays: toInt(env.NDD_SLA_SCHEDULE_LOOKBACK_DAYS, 2), // report dates (ending today and earlier) the scheduler keeps ensuring
    },

    // Gmail / GoKwik matching. Sender, subject pattern and filename pattern have NO defaults: production values are
    // not known to this repo. Missing values stop the worker from starting (see validateIntegrationConfig).
    gmail: {
      sender: env.NDD_SLA_GMAIL_SENDER || "",
      subjectPattern: env.NDD_SLA_GMAIL_SUBJECT_PATTERN || "",
      filenamePattern: env.NDD_SLA_GMAIL_FILENAME_PATTERN || "",
      pick: env.NDD_SLA_GMAIL_PICK === "latest" ? "latest" : "first", // when several messages match
      searchLookaheadHours: toInt(env.NDD_SLA_GMAIL_LOOKAHEAD_HOURS, 24),
      clientId: env.NDD_GMAIL_CLIENT_ID || "",
      clientSecret: env.NDD_GMAIL_CLIENT_SECRET || "",
    },

    // EasyCom. No URL, endpoint, auth scheme, pagination scheme or field name is assumed.
    easycom: {
      baseUrl: env.NDD_EASYCOM_BASE_URL || "",
      endpoint: env.NDD_EASYCOM_ENDPOINT || "",
      auth: {
        mode: String(env.NDD_EASYCOM_AUTH_MODE || "").toLowerCase(),
        headerName: env.NDD_EASYCOM_AUTH_HEADER || "",
        queryParam: env.NDD_EASYCOM_AUTH_QUERY_PARAM || "",
      },
      query: parseJson(env.NDD_EASYCOM_STATIC_QUERY, "NDD_EASYCOM_STATIC_QUERY", {}),
      dateParams: { fromParam: opt(env.NDD_EASYCOM_FROM_PARAM), toParam: opt(env.NDD_EASYCOM_TO_PARAM) },
      pagination: {
        mode: String(env.NDD_EASYCOM_PAGINATION_MODE || "").toLowerCase(),
        pageSize: toInt(env.NDD_EASYCOM_PAGE_SIZE, 100),
        pageSizeParam: opt(env.NDD_EASYCOM_PAGE_SIZE_PARAM),
        pageParam: opt(env.NDD_EASYCOM_PAGE_PARAM),
        startPage: toInt(env.NDD_EASYCOM_START_PAGE, 1),
        offsetParam: opt(env.NDD_EASYCOM_OFFSET_PARAM),
        cursorParam: opt(env.NDD_EASYCOM_CURSOR_PARAM),
      },
      response: {
        itemsPath: env.NDD_EASYCOM_ITEMS_PATH || "",
        nextCursorPath: opt(env.NDD_EASYCOM_NEXT_CURSOR_PATH),
        hasMorePath: opt(env.NDD_EASYCOM_HAS_MORE_PATH),
      },
      fields: { reference: env.NDD_EASYCOM_FIELD_REFERENCE || "", pickedAt: env.NDD_EASYCOM_FIELD_PICKED_AT || "" },
      maxPages: toInt(env.NDD_EASYCOM_MAX_PAGES, 1000),
      timeoutMs: toInt(env.NDD_EASYCOM_TIMEOUT_MS, 30000),
    },
  };
}

// Everything production still has to supply, as env var names. The worker refuses to start while this is non-empty.
function validateIntegrationConfig(config) {
  const { missingEasycomConfig } = require("./integrations/easycomClient");
  const missing = [];
  if (!config.passwordAesKey) missing.push("PASSWORD_AES_KEY");
  if (!config.db.host || !config.db.user || !config.db.database) missing.push("NDD_DB_HOST / NDD_DB_USER / NDD_DB_NAME");
  if (!config.gmail.sender) missing.push("NDD_SLA_GMAIL_SENDER");
  if (!config.gmail.subjectPattern) missing.push("NDD_SLA_GMAIL_SUBJECT_PATTERN");
  if (!config.gmail.filenamePattern) missing.push("NDD_SLA_GMAIL_FILENAME_PATTERN");
  if (!config.gmail.clientId || !config.gmail.clientSecret) missing.push("NDD_GMAIL_CLIENT_ID / NDD_GMAIL_CLIENT_SECRET");
  missing.push(...missingEasycomConfig(config.easycom));
  return missing;
}

module.exports = { ANCHORS, getConfig, parseClock, readWindowRules, validateIntegrationConfig };
