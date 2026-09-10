// UTM, device-type, and request filter helpers.
// Canonical location. Extracted from utils/metricsUtils.js

const { daysInclusive } = require("./date");

// ── Internal helpers ───────────────────────────────────────────────────────────

function normalizeFilterValues(val) {
  if (!val) return [];
  const vals = Array.isArray(val)
    ? val
    : typeof val === "string" && val.includes(",")
      ? val.split(",")
      : [val];
  return vals
    .map((v) => (typeof v === "string" ? v.trim() : String(v).trim()))
    .filter(Boolean);
}

function extractUtmParam(val) {
  if (!val) return null;
  if (Array.isArray(val)) return val.filter((v) => v);
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed.includes(","))
      return trimmed
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    return trimmed || null;
  }
  return null;
}

function extractSingleParam(val) {
  const values = normalizeFilterValues(val);
  return values.length > 0 ? values[0] : null;
}

// Discount codes support multi-select (comma-separated or repeated query params).
// Returns an array of up to `max` codes, or null when none are provided so that
// downstream truthiness checks (`filters.discount_code || ...`) keep working.
const MAX_DISCOUNT_CODES = 3;

function extractDiscountCodes(val, max = MAX_DISCOUNT_CODES) {
  const values = normalizeFilterValues(val);
  if (values.length === 0) return null;
  // De-dupe while preserving order, then cap.
  const seen = new Set();
  const unique = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    unique.push(v);
  }
  return unique.slice(0, max);
}

function canSyncProductUtmFilters(req) {
  if (req?.user?.isAuthor) return true;
  const permissions = Array.isArray(req?.user?.permissions) ? req.user.permissions : [];
  return (
    permissions.includes("all") ||
    permissions.includes("product_utm_filter_sync")
  );
}

// ── Clause builders ────────────────────────────────────────────────────────────

function buildDeviceTypeUserAgentClause(deviceType, column = "user_agent") {
  if (!deviceType) return null;
  const types = Array.isArray(deviceType) ? deviceType : [deviceType];
  if (types.length === 0) return null;

  const clauses = [];
  for (const t of types) {
    const lower = (t || "").toString().toLowerCase().trim();
    if (lower === "desktop") {
      clauses.push(`${column} LIKE '%Windows%'`);
    } else if (lower === "mobile") {
      clauses.push(`(${column} LIKE '%Android%' OR ${column} LIKE '%iPhone%')`);
    } else if (lower === "others") {
      clauses.push(
        `(${column} NOT LIKE '%Windows%' AND ${column} NOT LIKE '%Android%' AND ${column} NOT LIKE '%iPhone%')`,
      );
    }
  }
  if (clauses.length === 0) return null;
  return clauses.join(" OR ");
}

function buildUtmWhereClause(
  filters,
  {
    mapDirectToNull = false,
    prefixWithAnd = false,
    deviceColumn = "user_agent",
  } = {},
) {
  if (!filters) {
    return { clause: "", params: [] };
  }

  const clauses = [];
  const params = [];
  const buildDirectSourceClause = (col) =>
    `(${col} IS NULL OR TRIM(${col}) = '' OR LOWER(TRIM(${col})) IN ('(none)', 'none', 'null', 'direct'))`;

  const append = (col, val) => {
    const cleanVals = normalizeFilterValues(val);
    if (cleanVals.length === 0) return;

    if (mapDirectToNull && col === "utm_source") {
      const hasDirect = cleanVals.some((v) => v.toLowerCase() === "direct");
      const otherVals = cleanVals.filter((v) => v.toLowerCase() !== "direct");
      if (hasDirect) {
        if (otherVals.length === 0) {
          clauses.push(buildDirectSourceClause(col));
        } else {
          clauses.push(
            `(${col} IN (${otherVals.map(() => "?").join(", ")}) OR ${buildDirectSourceClause(col)})`,
          );
          params.push(...otherVals);
        }
        return;
      }
    }

    if (cleanVals.length === 1) {
      clauses.push(`${col} = ?`);
      params.push(cleanVals[0]);
    } else {
      clauses.push(`${col} IN (${cleanVals.map(() => "?").join(", ")})`);
      params.push(...cleanVals);
    }
  };

  append("utm_source", filters.utm_source);
  append("utm_medium", filters.utm_medium);
  append("utm_campaign", filters.utm_campaign);
  append("utm_term", filters.utm_term);
  append("utm_content", filters.utm_content);
  append("order_app_name", filters.sales_channel);

  const dtClause = buildDeviceTypeUserAgentClause(filters.device_type, deviceColumn);
  if (dtClause) {
    clauses.push(`(${dtClause})`);
  }

  if (clauses.length === 0) {
    return { clause: "", params };
  }

  return {
    clause: `${prefixWithAnd ? " AND " : ""}${clauses.join(" AND ")}`,
    params,
  };
}

function appendUtmWhere(sql, params, filters, mapDirectToNull = false) {
  const built = buildUtmWhereClause(filters, { mapDirectToNull, prefixWithAnd: true });
  params.push(...built.params);
  return `${sql}${built.clause}`;
}

function hasUtmFilters(filters) {
  if (!filters) return false;
  return !!(
    filters.utm_source ||
    filters.utm_medium ||
    filters.utm_campaign ||
    filters.utm_term ||
    filters.utm_content ||
    filters.sales_channel ||
    filters.device_type ||
    filters.city
  );
}

// ── Request-level filter extractor ────────────────────────────────────────────

function extractFilters(req) {
  const {
    start,
    end,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_term,
    utm_content,
    sales_channel,
    device_type,
    product_id,
    discount_code,
    city,
    product_type,
  } = req.query;

  // Suppress UTM filters for date ranges exceeding 30 days to prevent heavy queries.
  const ignoreUtms = start && end && daysInclusive(start, end) > 30;
  const allowProductUtmSync = canSyncProductUtmFilters(req);
  const rawProductId = extractUtmParam(product_id);
  const rawUtmSource = ignoreUtms ? null : extractUtmParam(utm_source);
  const hasProduct = Array.isArray(rawProductId) ? rawProductId.length > 0 : !!rawProductId;
  const hasSource = Array.isArray(rawUtmSource) ? rawUtmSource.length > 0 : !!rawUtmSource;
  const sanitizedUtmSource =
    !allowProductUtmSync && hasProduct && hasSource ? null : rawUtmSource;

  return {
    utm_source: sanitizedUtmSource,
    utm_medium: ignoreUtms ? null : extractUtmParam(utm_medium),
    utm_campaign: ignoreUtms ? null : extractUtmParam(utm_campaign),
    utm_term: ignoreUtms ? null : extractUtmParam(utm_term),
    utm_content: ignoreUtms ? null : extractUtmParam(utm_content),
    sales_channel: extractUtmParam(sales_channel),
    device_type: extractUtmParam(device_type),
    product_id: rawProductId,
    discount_code: extractDiscountCodes(discount_code),
    city: extractUtmParam(city),
    product_type: extractUtmParam(product_type),
  };
}

module.exports = {
  buildUtmWhereClause,
  appendUtmWhere,
  buildDeviceTypeUserAgentClause,
  hasUtmFilters,
  extractUtmParam,
  extractSingleParam,
  extractDiscountCodes,
  extractFilters,
  MAX_DISCOUNT_CODES,
};
