const { QueryTypes } = require("sequelize");
const { normalizeTimezone, shiftDays, daysInclusive } = require("../shared/utils/date");
const { getShopInventoryCache, getDefaultRedisClient } = require("./productConversionService");
const logger = require("../shared/utils/logger");

// Out-of-stock history for the Inventory panel's trend chart.
//
// Source: `inventory_oos_history` in the brand database, written by the inventory ingestion pipeline. One row is
// one variant's stock-out: when it was first seen out of stock, and (once restocked) when it came back and with
// how many units. The pipeline stores UTC (`datetime.utcnow()`), so every timestamp here is read as UTC and only
// converted to the brand's timezone to decide which day/hour it falls in. There are no inventory readings between
// these events, so the chart shows stock-outs and restocks, not a stock level.

const MAX_RANGE_DAYS = 31;
const MAX_HOURLY_RANGE_DAYS = 7;
const EPISODE_LIST_CAP = 500;
const ROW_SAFETY_CAP = 50000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_MS = 3600 * 1000;

// ---- timezone helpers (no date library in this service) ------------------------------------------------------

// Offset of `timezone` from UTC at the instant `utcMs`, in milliseconds (positive east of UTC).
function zoneOffsetMs(utcMs, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(new Date(utcMs))
    .reduce((acc, p) => {
      if (p.type !== "literal") acc[p.type] = Number(p.value);
      return acc;
    }, {});
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// The UTC instant at which the wall clock in `timezone` reads `dateStr` at `hour`:00.
function localToUtcMs(dateStr, hour, timezone) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  const first = guess - zoneOffsetMs(guess, timezone);
  const second = guess - zoneOffsetMs(first, timezone);
  return second;
}

const pad2 = (n) => String(n).padStart(2, "0");

// "2026-11-03 22:09:19" (UTC, as written by the pipeline) -> epoch ms, or null.
function parseDbUtc(value) {
  if (value === null || value === undefined || value === "") return null;
  const ms = Date.parse(`${String(value).replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
}

// epoch ms -> "2026-11-03 22:09:19" for use as a query parameter against the UTC columns.
function toDbUtc(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

// ---- request ---------------------------------------------------------------------------------------------------

function bad(message) {
  return { ok: false, status: 400, body: { error: message } };
}

function normalizeOosTrendRequest(query = {}, { timezone } = {}) {
  const start = String(query.start || "").trim();
  const end = String(query.end || query.start || "").trim();
  if (!ISO_DAY.test(start) || !ISO_DAY.test(end)) return bad("start and end must be dates in YYYY-MM-DD format");
  if (end < start) return bad("end cannot be before start");
  const days = daysInclusive(start, end);
  if (!Number.isFinite(days) || days < 1) return bad("start and end must be valid dates");
  if (days > MAX_RANGE_DAYS) return bad(`Date range cannot exceed ${MAX_RANGE_DAYS} days`);

  let granularity = String(query.granularity || "").trim().toLowerCase();
  if (!granularity) granularity = days <= 2 ? "hourly" : "daily";
  if (granularity !== "hourly" && granularity !== "daily") return bad("granularity must be hourly or daily");
  if (granularity === "hourly" && days > MAX_HOURLY_RANGE_DAYS) {
    return bad(`Hourly view is limited to ${MAX_HOURLY_RANGE_DAYS} days`);
  }

  let productId = null;
  if (query.product_id !== undefined && query.product_id !== null && String(query.product_id).trim() !== "") {
    productId = String(query.product_id).trim().split("/").pop();
    if (!/^\d{1,20}$/.test(productId)) return bad("product_id must be a numeric Shopify product id");
  }

  return { ok: true, spec: { start, end, granularity, productId, timezone: normalizeTimezone(timezone) } };
}

// ---- bucketing ---------------------------------------------------------------------------------------------------

function buildBuckets({ start, end, granularity, timezone }) {
  const buckets = [];
  for (let day = start; day <= end; day = shiftDays(day, 1)) {
    if (granularity === "daily") {
      buckets.push({ label: day, startMs: localToUtcMs(day, 0, timezone), endMs: localToUtcMs(shiftDays(day, 1), 0, timezone) });
      continue;
    }
    const dayStart = localToUtcMs(day, 0, timezone);
    const dayEnd = localToUtcMs(shiftDays(day, 1), 0, timezone);
    for (let hour = 0, at = dayStart; at < dayEnd; hour += 1, at += HOUR_MS) {
      buckets.push({ label: `${day} ${pad2(hour)}:00`, startMs: at, endMs: Math.min(at + HOUR_MS, dayEnd) });
    }
  }
  return buckets;
}

// `episodes`: [{ s, b, qty }] (epoch ms; b is null while still out of stock).
function fillBuckets(buckets, episodes, nowMs) {
  return buckets.map(({ label, startMs, endMs }) => {
    if (startMs > nowMs) {
      return { start: iso(startMs), label, oos_count: null, new_oos: 0, restocked: 0, restock_qty: 0, future: true };
    }
    // State at the end of the bucket, or right now for the bucket that is still running.
    const at = Math.min(endMs, nowMs + 1);
    let oos = 0;
    let started = 0;
    let restocked = 0;
    let qty = 0;
    for (const e of episodes) {
      if (e.s < at && (e.b === null || e.b >= at)) oos += 1;
      if (e.s >= startMs && e.s < endMs) started += 1;
      if (e.b !== null && e.b >= startMs && e.b < endMs) {
        restocked += 1;
        qty += e.qty || 0;
      }
    }
    return { start: iso(startMs), label, oos_count: oos, new_oos: started, restocked, restock_qty: qty, future: false };
  });
}

// ---- variant names (best effort, from the same Redis cache the inventory table uses) -------------------------

async function loadVariantNames(brandKey, resolveShopSubdomain) {
  try {
    const redis = getDefaultRedisClient();
    const shop = resolveShopSubdomain && resolveShopSubdomain(brandKey);
    if (!redis || !shop) return new Map();
    const cache = await getShopInventoryCache(redis, shop);
    const names = new Map();
    for (const item of (cache && cache.items) || []) {
      if (!item || item.variant_id === undefined || item.variant_id === null) continue;
      names.set(String(item.variant_id).split("/").pop(), {
        sku: String(item.sku || "").trim() || null,
        title: String(item.product_title || "").trim() || null,
      });
    }
    return names;
  } catch (err) {
    logger.warn("[inventoryOos] could not read variant names from the inventory cache", { error: err && err.message });
    return new Map();
  }
}

// ---- service -----------------------------------------------------------------------------------------------------

function isMissingTableError(err) {
  const e = (err && (err.original || err.parent)) || err || {};
  return (e.code === "ER_NO_SUCH_TABLE" || e.errno === 1146) && String(e.message || "").includes("inventory_oos_history");
}

function buildInventoryOosService({ now = () => Date.now(), loadNames = loadVariantNames } = {}) {
  async function getOosTrend({ conn, brandKey, resolveShopSubdomain, start, end, granularity, productId, timezone }) {
    const nowMs = now();
    const buckets = buildBuckets({ start, end, granularity, timezone });
    const rangeStartMs = buckets[0].startMs;
    const rangeEndMs = buckets[buckets.length - 1].endMs;

    const productClause = productId ? " AND product_id = :productId" : "";
    let rows;
    let openNow;
    try {
      rows = await conn.query(
        `SELECT id, product_id, variant_id,
                DATE_FORMAT(out_of_stock_at, '%Y-%m-%d %H:%i:%s') AS oos_at,
                DATE_FORMAT(back_in_stock_at, '%Y-%m-%d %H:%i:%s') AS back_at,
                start_quantity, recovery_quantity
           FROM inventory_oos_history
          WHERE out_of_stock_at < :rangeEnd
            AND (back_in_stock_at IS NULL OR back_in_stock_at >= :rangeStart)${productClause}
          ORDER BY out_of_stock_at DESC
          LIMIT ${ROW_SAFETY_CAP + 1}`,
        { type: QueryTypes.SELECT, replacements: { rangeStart: toDbUtc(rangeStartMs), rangeEnd: toDbUtc(rangeEndMs), productId } },
      );
      const openRows = await conn.query(
        `SELECT COUNT(*) AS n FROM inventory_oos_history WHERE back_in_stock_at IS NULL${productClause}`,
        { type: QueryTypes.SELECT, replacements: { productId } },
      );
      openNow = Number((openRows[0] && openRows[0].n) || 0);
    } catch (err) {
      if (isMissingTableError(err)) return { available: false };
      throw err;
    }

    const truncated = rows.length > ROW_SAFETY_CAP;
    if (truncated) rows = rows.slice(0, ROW_SAFETY_CAP);

    const episodes = rows.map((r) => ({
      id: Number(r.id),
      productId: String(r.product_id),
      variantId: String(r.variant_id),
      s: parseDbUtc(r.oos_at),
      b: parseDbUtc(r.back_at),
      qty: r.recovery_quantity === null || r.recovery_quantity === undefined ? null : Number(r.recovery_quantity),
      startQty: r.start_quantity === null || r.start_quantity === undefined ? null : Number(r.start_quantity),
    })).filter((e) => e.s !== null);

    const outBuckets = fillBuckets(buckets, episodes, nowMs);

    const startedInRange = episodes.filter((e) => e.s >= rangeStartMs && e.s < rangeEndMs);
    const restockedInRange = episodes.filter((e) => e.b !== null && e.b >= rangeStartMs && e.b < rangeEndMs);
    const durations = restockedInRange.map((e) => (e.b - e.s) / 60000);
    const summary = {
      currently_out_of_stock: openNow,
      stock_outs_in_range: startedInRange.length,
      restocks_in_range: restockedInRange.length,
      units_restocked: restockedInRange.reduce((sum, e) => sum + (e.qty || 0), 0),
      avg_duration_minutes: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    };

    let episodeList = [];
    if (productId) {
      const names = await loadNames(brandKey, resolveShopSubdomain);
      episodeList = episodes.slice(0, EPISODE_LIST_CAP).map((e) => {
        const name = names.get(e.variantId) || {};
        return {
          id: e.id,
          product_id: e.productId,
          variant_id: e.variantId,
          sku: name.sku || null,
          title: name.title || null,
          out_of_stock_at: iso(e.s),
          back_in_stock_at: iso(e.b),
          start_quantity: e.startQty,
          recovery_quantity: e.qty,
          duration_minutes: Math.max(0, Math.round(((e.b === null ? nowMs : e.b) - e.s) / 60000)),
          is_open: e.b === null,
        };
      });
    }

    return {
      available: true,
      range: { start, end },
      granularity,
      timezone,
      generated_at: iso(nowMs),
      truncated,
      product_id: productId,
      buckets: outBuckets,
      summary,
      episodes: episodeList,
    };
  }

  return { getOosTrend };
}

module.exports = {
  buildInventoryOosService,
  normalizeOosTrendRequest,
  MAX_RANGE_DAYS,
  MAX_HOURLY_RANGE_DAYS,
  EPISODE_LIST_CAP,
  _internal: { buildBuckets, fillBuckets, localToUtcMs, zoneOffsetMs, parseDbUtc, toDbUtc, isMissingTableError },
};
