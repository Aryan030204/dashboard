const { QueryTypes } = require("sequelize");
const { normalizeTimezone, getTodayInTimezone, shiftDays } = require("../shared/utils/date");

// "Marketplace history" panel: website prices against marketplace prices, now and over time.
//
// Source: the `mm_*` tables of the brand database, written by the marketplace scraper. This service only reads them.
// A price is shown only when the check actually read it: failed and suspect checks never become prices, and a
// listing a person later rejected (wrong product) is left out together with its history.

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const PINCODE = /^\d{4,10}$/;
const DEFAULT_DAYS = 90;
const ORDER = ["AMAZON", "FLIPKART", "MYNTRA", "NYKAA", "BLINKIT", "ZEPTO"];
const LIVE = new Set(["ACTIVE", "OOS"]);
const KEPT = new Set(["ACTIVE", "OOS", "NEEDS_REDISCOVERY"]); // still a listing, possibly waiting for a new link
const OBSERVED = new Set(["OK", "OUT_OF_STOCK"]);

const bad = (message) => ({ ok: false, status: 400, body: { error: message } });

const isDay = (value) => ISO_DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

// `start`/`end` are days in the brand's timezone. `range=all` reads everything; without dates, the last 90 days.
function normalizeRangeRequest(query = {}, { timezone, now = new Date() } = {}) {
  const zone = normalizeTimezone(timezone);
  const today = getTodayInTimezone(zone, now);
  const all = String(query.range || "") === "all";
  const end = String(query.end || "").trim() || today;
  const start = all ? null : String(query.start || "").trim() || shiftDays(end, -(DEFAULT_DAYS - 1));
  if (!isDay(end) || (start !== null && !isDay(start))) return bad("start and end must be dates in YYYY-MM-DD format");
  if (start !== null && start > end) return bad("start must not be after end");
  const pincode = String(query.pincode || "").trim();
  if (pincode && !PINCODE.test(pincode)) return bad("invalid pincode");
  return { ok: true, spec: { start, end, pincode, timezone: zone } };
}

function normalizeProductRequest(query = {}, options) {
  const range = normalizeRangeRequest(query, options);
  if (!range.ok) return range;
  const variantId = Number(query.variant_id);
  if (!Number.isInteger(variantId) || variantId <= 0) return bad("variant_id is required");
  return { ok: true, spec: { ...range.spec, variantId } };
}

const number = (value) => (value === null || value === undefined || value === "" ? null : Number(value));

// The database stores naive UTC ("YYYY-MM-DD HH:mm:ss").
const utcDate = (value) => (value instanceof Date ? value : new Date(`${String(value).replace(" ", "T")}Z`));

function dayFormatter(timezone) {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (date) => format.format(date);
}

function gap(price, ours) {
  if (price === null || ours === null || !(ours > 0)) return { pct: null, abs: null };
  return { pct: Math.round(((price - ours) / ours) * 1000) / 10, abs: Math.round((price - ours) * 100) / 100 };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const average = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);
const round1 = (value) => (value === null ? null : Math.round(value * 10) / 10);

function summarise(gaps) {
  const pct = gaps.map((g) => g.pct).filter((v) => v !== null);
  const abs = gaps.map((g) => g.abs).filter((v) => v !== null);
  return {
    n: pct.length,
    median: { pct: round1(median(pct)), abs: round1(median(abs)) },
    average: { pct: round1(average(pct)), abs: round1(average(abs)) },
  };
}

function sizeLabel(variant) {
  const value = number(variant.size_value);
  const unit = String(variant.size_unit || "").toUpperCase();
  const pack = Number(variant.pack_count || 1);
  if (value === null) {
    const title = String(variant.variant_title || "");
    return title && title.toLowerCase() !== "default title" ? title : "";
  }
  return `${pack > 1 ? `${pack}×` : ""}${Number(value)}${unit}`;
}

// Reduces raw checks to one value per variant, marketplace and day, plus our own price per variant and day.
function dailyValues(snapshots, { toDay, start, end, allowedListings }) {
  const perListing = new Map(); // listing|day -> latest observed check
  const ours = new Map(); // variant -> day -> { price, mrp, at }
  let latestDay = null;
  let firstDay = null;

  for (const row of snapshots) {
    if (!allowedListings.has(Number(row.listing_id))) continue;
    const at = utcDate(row.checked_at);
    const day = toDay(at);
    if ((start && day < start) || day > end) continue;
    if (!latestDay || day > latestDay) latestDay = day;
    if (!firstDay || day < firstDay) firstDay = day;
    const variant = Number(row.variant_id);

    if (number(row.brand_sp) !== null) {
      if (!ours.has(variant)) ours.set(variant, new Map());
      const known = ours.get(variant).get(day);
      if (!known || at > known.at) {
        ours.get(variant).set(day, { price: number(row.brand_sp), mrp: number(row.brand_mrp), at });
      }
    }

    if (!OBSERVED.has(row.status) || row.validation !== "OK") continue;
    const oos = row.status === "OUT_OF_STOCK" || row.availability === "OUT_OF_STOCK";
    if (!oos && number(row.mkt_sp) === null) continue;
    const key = `${row.listing_id}|${day}`;
    const known = perListing.get(key);
    if (!known || at > known.at) {
      perListing.set(key, {
        listingId: Number(row.listing_id),
        variant,
        code: row.code,
        day,
        at,
        price: number(row.mkt_sp),
        best: number(row.mkt_best_at_price),
        ours: number(row.brand_sp),
        oos,
        stock: oos ? "out" : row.availability === "IN_STOCK" ? "in" : "unknown",
      });
    }
  }

  const values = new Map(); // variant|code -> day -> value; two listings: the cheapest one that is in stock
  for (const value of perListing.values()) {
    const key = `${value.variant}|${value.code}`;
    if (!values.has(key)) values.set(key, new Map());
    const known = values.get(key).get(value.day);
    const better = !known || (known.oos && !value.oos) || (known.oos === value.oos && !value.oos && value.price < known.price);
    if (better) values.get(key).set(value.day, value);
  }
  return { values, ours, firstDay, latestDay };
}

function daysBetween(first, last) {
  const days = [];
  for (let day = first; day && day <= last; day = shiftDays(day, 1)) days.push(day);
  return days;
}

const latestOf = (byDay) => (byDay && byDay.size ? byDay.get([...byDay.keys()].sort().pop()) : null);

function cellFor({ listings, byDay, latestDay }) {
  if (!listings.length) return { state: "unlisted" };
  const value = latestOf(byDay);
  const url = listings.find((l) => l.listing_id === value?.listingId)?.url || listings[0].url;
  if (!value) return { state: "unread", url };
  const listed = value.oos ? { pct: null, abs: null } : gap(value.price, value.ours);
  const best = value.oos ? { pct: null, abs: null } : gap(value.best, value.ours);
  return {
    state: value.oos ? "oos" : "ok",
    price: value.price,
    best: value.best,
    gap: listed,
    bestGap: best,
    stock: value.stock,
    day: value.day,
    checkedAt: value.at.toISOString(),
    stale: value.day < latestDay,
    url: listings.find((l) => l.listing_id === value.listingId)?.url || url,
  };
}

// Product rank by units sold; `units` are rows of the last 30 days of daily_inventory_summary.
function rankProducts(units) {
  const byProduct = new Map();
  const byVariant = new Map();
  for (const row of units) {
    const sold = Number(row.units || 0);
    byProduct.set(String(row.product_id), (byProduct.get(String(row.product_id)) || 0) + sold);
    byVariant.set(String(row.variant_id), (byVariant.get(String(row.variant_id)) || 0) + sold);
  }
  const ranks = new Map(
    [...byProduct.entries()].filter(([, sold]) => sold > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id], index) => [id, index + 1]),
  );
  return { ranks, unitsByVariant: byVariant };
}

// Listings grouped as product -> variant -> marketplace, without rejected and retired ones.
function groupListings(rows) {
  const allowed = new Set();
  const variants = new Map();
  for (const row of rows) {
    if (row.match_status === "MANUAL_REJECTED") continue;
    const listingId = Number(row.listing_id);
    allowed.add(listingId); // its history counts even if it was later replaced
    if (!KEPT.has(row.listing_status) || !Number(row.variant_active) || !Number(row.product_active)) continue;
    const id = Number(row.variant_id);
    if (!variants.has(id)) variants.set(id, { ...row, variant_id: id, markets: new Map() });
    const markets = variants.get(id).markets;
    if (!markets.has(row.code)) markets.set(row.code, []);
    markets.get(row.code).push({
      listing_id: listingId,
      live: LIVE.has(row.listing_status),
      url: /^https:\/\//i.test(row.canonical_url || "") ? row.canonical_url : null,
    });
  }
  return { allowed, variants };
}

const marketplaceList = (codes, names) =>
  ORDER.filter((code) => codes.has(code)).map((code) => ({ code, name: names.get(code) || code }));

// The size shown for a product: the listed one that sold most, then the one on most marketplaces.
function mainVariants(variants, unitsByVariant) {
  const products = new Map();
  for (const variant of variants.values()) {
    const key = Number(variant.product_id);
    if (!products.has(key)) products.set(key, []);
    products.get(key).push(variant);
  }
  const sold = (v) => unitsByVariant.get(String(v.shopify_variant_id)) || 0;
  return [...products.values()].map((list) => {
    const sorted = [...list].sort((a, b) => sold(b) - sold(a) || b.markets.size - a.markets.size || a.variant_id - b.variant_id);
    return { main: sorted[0], all: sorted };
  });
}

const currentMrp = (v) => {
  const price = number(v.price);
  const compare = number(v.compare_at_price);
  return compare !== null && price !== null && compare > price ? compare : price;
};

function buildOverview({ listings, snapshots, units, names, spec }) {
  const { allowed, variants } = groupListings(listings);
  const toDay = dayFormatter(spec.timezone);
  const daily = dailyValues(snapshots, { toDay, start: spec.start, end: spec.end, allowedListings: allowed });
  const { ranks, unitsByVariant } = rankProducts(units);
  const products = mainVariants(variants, unitsByVariant);
  const codes = new Set(products.flatMap(({ main }) => [...main.markets.keys()]));

  const rows = products.map(({ main, all }) => {
    const cells = {};
    for (const code of codes) {
      cells[code] = cellFor({
        listings: main.markets.get(code) || [],
        byDay: daily.values.get(`${main.variant_id}|${code}`),
        latestDay: daily.latestDay,
      });
    }
    return {
      variantId: main.variant_id,
      product: main.product_title,
      size: sizeLabel(main),
      sizes: all.map((v) => ({ variantId: v.variant_id, label: sizeLabel(v) || "Default" })),
      ourPrice: number(main.price),
      mrp: currentMrp(main),
      rank: ranks.get(String(main.shopify_product_id)) || null,
      live: [...main.markets.entries()].filter(([, list]) => list.some((l) => l.live)).map(([code]) => code),
      cells,
    };
  });

  // Gap lines use the same main sizes as the table.
  const series = daysBetween(daily.firstDay, daily.latestDay).map((date) => {
    const point = { date, listed: {}, best: {} };
    for (const code of codes) {
      const listed = [];
      const best = [];
      for (const { main } of products) {
        const value = daily.values.get(`${main.variant_id}|${code}`)?.get(date);
        if (!value || value.oos) continue;
        listed.push(gap(value.price, value.ours));
        if (value.best !== null) best.push(gap(value.best, value.ours));
      }
      point.listed[code] = summarise(listed);
      point.best[code] = summarise(best);
    }
    return point;
  });

  return {
    marketplaces: marketplaceList(codes, names),
    products: rows.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.product.localeCompare(b.product)),
    series,
    asOf: daily.latestDay,
    firstDay: daily.firstDay,
  };
}

function buildProduct({ listings, snapshots, names, spec }) {
  const { allowed, variants } = groupListings(listings);
  const variant = variants.get(spec.variantId);
  if (!variant) return null;
  const toDay = dayFormatter(spec.timezone);
  const daily = dailyValues(snapshots, { toDay, start: spec.start, end: spec.end, allowedListings: allowed });
  const codes = new Set(variant.markets.keys());
  const ours = daily.ours.get(variant.variant_id) || new Map();

  const series = daysBetween(daily.firstDay, daily.latestDay).map((date) => {
    const point = { date, ours: ours.get(date)?.price ?? null, marketplaces: {} };
    for (const code of codes) {
      const value = daily.values.get(`${variant.variant_id}|${code}`)?.get(date);
      point.marketplaces[code] = value ? { price: value.oos ? null : value.price, best: value.oos ? null : value.best, oos: value.oos } : null;
    }
    return point;
  });

  const current = marketplaceList(codes, names).map(({ code }) => ({
    code,
    ...cellFor({
      listings: variant.markets.get(code),
      byDay: daily.values.get(`${variant.variant_id}|${code}`),
      latestDay: daily.latestDay,
    }),
  }));

  const sizes = [...variants.values()].filter((v) => Number(v.product_id) === Number(variant.product_id))
    .sort((a, b) => a.variant_id - b.variant_id)
    .map((v) => ({ variantId: v.variant_id, label: sizeLabel(v) || "Default" }));

  return {
    variantId: variant.variant_id,
    product: variant.product_title,
    size: sizeLabel(variant),
    sizes,
    ourPrice: number(variant.price),
    marketplaces: marketplaceList(codes, names),
    series,
    current,
    asOf: daily.latestDay,
  };
}

// No scraper tables (or an older layout) in this brand database.
function isNotSetUp(err) {
  const e = (err && (err.original || err.parent)) || err || {};
  if (e.code === "ER_NO_SUCH_TABLE" || e.errno === 1146) return String(e.message || "").includes("mm_");
  return (e.code === "ER_BAD_FIELD_ERROR" || e.errno === 1054) && /mkt_|brand_sp|brand_mrp/.test(String(e.message || ""));
}

// Positional `?` only: the tenant connection formats replacements with mysql2.
const select = (conn, sql, replacements = []) => conn.query(sql, { replacements, type: QueryTypes.SELECT });

const LISTINGS_SQL = `
  SELECT l.id AS listing_id, l.variant_id, l.status AS listing_status, l.canonical_url, m.code,
         pm.status AS match_status, v.shopify_variant_id, v.title AS variant_title, v.price, v.compare_at_price,
         v.size_value, v.size_unit, v.pack_count, v.is_active AS variant_active,
         p.id AS product_id, p.shopify_product_id, p.title AS product_title, p.is_active AS product_active
    FROM mm_marketplace_listings l
    JOIN mm_marketplaces m ON m.id = l.marketplace_id
    JOIN mm_product_matches pm ON pm.id = l.match_id
    JOIN mm_product_variants v ON v.id = l.variant_id
    JOIN mm_products p ON p.id = v.product_id`;

async function loadSnapshots(conn, { start, end, pincode, variantId }) {
  const where = ["s.checked_at < ?"];
  const values = [shiftDays(end, 2)]; // a day of slack on both sides; the exact day is decided in the brand's timezone
  if (start) {
    where.push("s.checked_at >= ?");
    values.push(shiftDays(start, -1));
  }
  if (variantId) {
    where.push("s.variant_id = ?");
    values.push(variantId);
  }
  where.push("(s.pincode = '' OR s.pincode = ?)");
  values.push(pincode || "");
  return select(
    conn,
    `SELECT s.listing_id, s.variant_id, m.code, s.checked_at, s.status, s.availability, s.validation,
            s.mkt_sp, s.mkt_best_at_price, s.brand_sp, s.brand_mrp
       FROM mm_price_snapshots s
       JOIN mm_marketplaces m ON m.id = s.marketplace_id
      WHERE ${where.join(" AND ")}`,
    values,
  );
}

async function loadUnits(conn) {
  try {
    return await select(
      conn,
      `SELECT product_id, variant_id, SUM(units_sold) AS units
         FROM daily_inventory_summary
        WHERE date >= (SELECT DATE_SUB(MAX(date), INTERVAL 29 DAY) FROM daily_inventory_summary)
        GROUP BY product_id, variant_id`,
    );
  } catch (err) {
    const e = (err && (err.original || err.parent)) || err || {};
    if (e.code === "ER_NO_SUCH_TABLE" || e.errno === 1146) return []; // no sales data: no ranking
    throw err;
  }
}

async function loadContext(conn, pincode) {
  const [markets, pins] = await Promise.all([
    select(conn, "SELECT code, name FROM mm_marketplaces"),
    select(conn, "SELECT DISTINCT pincode FROM mm_price_snapshots WHERE pincode <> '' ORDER BY pincode"),
  ]);
  const pincodes = pins.map((row) => row.pincode);
  return {
    names: new Map(markets.map((row) => [row.code, row.name])),
    pincodes,
    pincode: pincodes.includes(pincode) ? pincode : pincodes[0] || "",
  };
}

function buildMarketplaceHistoryService() {
  async function getOverview({ conn, ...spec }) {
    try {
      const context = await loadContext(conn, spec.pincode);
      const [listings, snapshots, units] = await Promise.all([
        select(conn, LISTINGS_SQL),
        loadSnapshots(conn, { ...spec, pincode: context.pincode }),
        loadUnits(conn),
      ]);
      return {
        available: true,
        start: spec.start,
        end: spec.end,
        pincode: context.pincode,
        pincodes: context.pincodes,
        ...buildOverview({ listings, snapshots, units, names: context.names, spec }),
      };
    } catch (err) {
      if (isNotSetUp(err)) return { available: false };
      throw err;
    }
  }

  async function getProduct({ conn, ...spec }) {
    try {
      const context = await loadContext(conn, spec.pincode);
      const [listings, snapshots] = await Promise.all([
        select(conn, LISTINGS_SQL),
        loadSnapshots(conn, { ...spec, pincode: context.pincode }),
      ]);
      const product = buildProduct({ listings, snapshots, names: context.names, spec });
      if (!product) return { notFound: true };
      return { available: true, start: spec.start, end: spec.end, pincode: context.pincode, ...product };
    } catch (err) {
      if (isNotSetUp(err)) return { available: false };
      throw err;
    }
  }

  return { getOverview, getProduct };
}

module.exports = {
  buildMarketplaceHistoryService,
  normalizeRangeRequest,
  normalizeProductRequest,
  buildOverview,
  buildProduct,
};
