const { QueryTypes } = require("sequelize");
const { metricValue, breachesFor } = require("./adsAlertRules.service");

// Read side of the Ads page. Every figure comes from the per-brand tables the
// pipeline's P&L worker fills right after its spend rollups
// (workers/ads_performance.py, DDL migrations/007_ads_performance.sql):
//
//   ads_campaign_daily  (channel, date, campaign_id)
//   ads_ad_daily        (channel, date, ad_id)          Google: ad group
//   ads_product_daily   (channel, date, product_id)     0 = unattributed
//
// plus, read-only, the pipeline's own product_utm_daily (product revenue by
// utm_source, for per-product ROAS), product_landing_page_map (titles) and
// web_vitals_summary (site speed per landing page). This service only sums
// rows - it never calls an ad platform.
//
// Two ROAS figures are shown side by side on purpose:
//   roas         platform-reported purchase value / spend (what Ads Manager says)
//   shopifyRoas  Shopify orders whose UTMs carry the campaign's ids / spend

const CAMPAIGN_TABLE = "ads_campaign_daily";
const AD_TABLE = "ads_ad_daily";
const PRODUCT_TABLE = "ads_product_daily";
const CHANNELS = ["meta", "google"];
const UNATTRIBUTED_PRODUCT_ID = 0;

// Same lower-cased utm_source sets the worker attributes orders with.
const CHANNEL_UTM_SOURCES = {
  meta: ["facebook", "fb", "instagram", "ig", "meta", "an", "messenger"],
  google: ["google", "youtube", "gdn", "adwords"],
};

// Core Web Vitals LCP bands (seconds).
const LCP_BUCKETS = [
  { id: "good", label: "Good (≤ 2.5s)", max: 2.5 },
  { id: "needs_improvement", label: "Needs improvement (2.5–4s)", max: 4 },
  { id: "poor", label: "Poor (> 4s)", max: Infinity },
];

const MISSING_TABLE_CODES = new Set(["ER_NO_SUCH_TABLE", "ER_BAD_DB_ERROR"]);
const MAX_CAMPAIGNS = 1000;

function isMissingTableError(error) {
  const code = error?.code || error?.original?.code || error?.parent?.code;
  return MISSING_TABLE_CODES.has(code);
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertRange(start, end) {
  if (!ISO_DATE.test(String(start)) || !ISO_DATE.test(String(end))) {
    throw badRequest("start and end must be YYYY-MM-DD");
  }
  if (start > end) throw badRequest("start must be on or before end");
}

function normalizeChannel(channel) {
  if (!channel || channel === "all") return null;
  if (!CHANNELS.includes(channel)) throw badRequest(`channel must be one of all, ${CHANNELS.join(", ")}`);
  return channel;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nullableNum(value) {
  return value === null || value === undefined ? null : num(value);
}

function round(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function parseDateUTC(str) {
  const [y, m, d] = String(str).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDateUTC(date) {
  return date.toISOString().slice(0, 10);
}

function previousRange(start, end) {
  const days = Math.round((parseDateUTC(end) - parseDateUTC(start)) / 86400000) + 1;
  const prevEnd = new Date(parseDateUTC(start).getTime() - 86400000);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86400000);
  return [formatDateUTC(prevStart), formatDateUTC(prevEnd)];
}

async function select(conn, sql, replacements) {
  return conn.query(sql, { type: QueryTypes.SELECT, replacements });
}

// Runs `fn`, turning "table doesn't exist" into `fallback` so a brand whose
// DB hasn't had migration 007 yet gets an empty page instead of a 500.
async function orMissing(fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    if (isMissingTableError(error)) return fallback;
    throw error;
  }
}

const METRIC_SUMS = `
  COALESCE(SUM(spend), 0)                   AS spend,
  COALESCE(SUM(impressions), 0)             AS impressions,
  COALESCE(SUM(clicks), 0)                  AS clicks,
  SUM(link_clicks)                          AS link_clicks,
  SUM(landing_page_views)                   AS landing_page_views,
  COALESCE(SUM(platform_purchases), 0)      AS platform_purchases,
  COALESCE(SUM(platform_purchase_value), 0) AS platform_purchase_value,
  COALESCE(SUM(utm_orders), 0)              AS utm_orders,
  COALESCE(SUM(utm_sales), 0)               AS utm_sales`;

// Raw summed row (snake_case, what the alert evaluator reads) -> API shape.
function shapeMetrics(row) {
  return {
    spend: round(num(row.spend)),
    impressions: num(row.impressions),
    clicks: num(row.clicks),
    linkClicks: nullableNum(row.link_clicks),
    landingPageViews: nullableNum(row.landing_page_views),
    platformPurchases: round(num(row.platform_purchases)),
    platformPurchaseValue: round(num(row.platform_purchase_value)),
    utmOrders: num(row.utm_orders),
    utmSales: round(num(row.utm_sales)),
    roas: round(metricValue("roas", row)),
    shopifyRoas: round(metricValue("shopify_roas", row)),
    ctr: round(metricValue("ctr", row)),
    cpc: round(metricValue("cpc", row)),
    cpa: round(metricValue("cpa", row)),
    lpvRate: round(metricValue("lpv_rate", row)),
    cpm: num(row.impressions) > 0 ? round((num(row.spend) / num(row.impressions)) * 1000) : null,
  };
}

function sumRows(rows) {
  const total = {
    spend: 0,
    impressions: 0,
    clicks: 0,
    link_clicks: null,
    landing_page_views: null,
    platform_purchases: 0,
    platform_purchase_value: 0,
    utm_orders: 0,
    utm_sales: 0,
  };
  for (const row of rows) {
    for (const key of Object.keys(total)) {
      if (row[key] === null || row[key] === undefined) continue;
      total[key] = (total[key] || 0) + num(row[key]);
    }
  }
  return total;
}

function pctChange(current, previous) {
  if (current === null || previous === null || !previous) return null;
  return round(((current - previous) / Math.abs(previous)) * 100, 1);
}

async function fetchChannelTotals(conn, start, end) {
  return select(
    conn,
    `SELECT channel, ${METRIC_SUMS}, COUNT(DISTINCT date) AS day_count
     FROM \`${CAMPAIGN_TABLE}\`
     WHERE date >= ? AND date <= ?
     GROUP BY channel`,
    [start, end],
  );
}

// --- Overview ---------------------------------------------------------------

async function getOverview({ conn, start, end }) {
  assertRange(start, end);
  const [prevStart, prevEnd] = previousRange(start, end);
  if (!conn) return { setup: false, start, end, previousStart: prevStart, previousEnd: prevEnd };

  const result = await orMissing(async () => {
    const [current, previous, trend, coverage] = await Promise.all([
      fetchChannelTotals(conn, start, end),
      fetchChannelTotals(conn, prevStart, prevEnd),
      select(
        conn,
        `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, channel,
                COALESCE(SUM(spend), 0) AS spend,
                COALESCE(SUM(platform_purchase_value), 0) AS platform_purchase_value,
                COALESCE(SUM(utm_sales), 0) AS utm_sales
         FROM \`${CAMPAIGN_TABLE}\`
         WHERE date >= ? AND date <= ?
         GROUP BY date, channel
         ORDER BY date`,
        [start, end],
      ),
      select(
        conn,
        `SELECT COUNT(DISTINCT date) AS days, DATE_FORMAT(MAX(date), '%Y-%m-%d') AS last_date
         FROM \`${CAMPAIGN_TABLE}\``,
        [],
      ),
    ]);
    return { current, previous, trend, coverage: coverage?.[0] || {} };
  }, null);

  if (!result) return { setup: false, start, end, previousStart: prevStart, previousEnd: prevEnd };

  const channelRow = (rows, channel) => rows.find((row) => row.channel === channel) || sumRows([]);
  const channels = {};
  for (const channel of CHANNELS) {
    const cur = shapeMetrics(channelRow(result.current, channel));
    const prev = shapeMetrics(channelRow(result.previous, channel));
    channels[channel] = {
      ...cur,
      hasData: result.current.some((row) => row.channel === channel),
      change: { spend: pctChange(cur.spend, prev.spend), roas: pctChange(cur.roas, prev.roas) },
    };
  }
  const total = shapeMetrics(sumRows(result.current));
  const prevTotal = shapeMetrics(sumRows(result.previous));

  const trendByDate = new Map();
  for (const row of result.trend) {
    const entry = trendByDate.get(row.date) || { date: row.date, metaSpend: 0, googleSpend: 0, platformValue: 0, utmSales: 0 };
    entry[`${row.channel}Spend`] = round(num(row.spend));
    entry.platformValue = round(entry.platformValue + num(row.platform_purchase_value));
    entry.utmSales = round(entry.utmSales + num(row.utm_sales));
    trendByDate.set(row.date, entry);
  }

  return {
    setup: true,
    start,
    end,
    previousStart: prevStart,
    previousEnd: prevEnd,
    total: {
      ...total,
      change: {
        spend: pctChange(total.spend, prevTotal.spend),
        roas: pctChange(total.roas, prevTotal.roas),
        shopifyRoas: pctChange(total.shopifyRoas, prevTotal.shopifyRoas),
        lpvRate: pctChange(total.lpvRate, prevTotal.lpvRate),
      },
    },
    channels,
    trend: [...trendByDate.values()],
    coverage: {
      daysInRange: Math.max(0, ...result.current.map((row) => num(row.day_count))),
      syncedDays: num(result.coverage.days),
      lastSyncedDate: result.coverage.last_date || null,
    },
  };
}

// --- Campaigns --------------------------------------------------------------

async function getCampaigns({ conn, start, end, channel, rules = [] }) {
  assertRange(start, end);
  const ch = normalizeChannel(channel);
  if (!conn) return { setup: false, campaigns: [] };

  const rows = await orMissing(
    () =>
      select(
        conn,
        `SELECT channel, campaign_id,
                MAX(campaign_name) AS campaign_name,
                SUBSTRING_INDEX(GROUP_CONCAT(campaign_status ORDER BY date DESC SEPARATOR '|'), '|', 1) AS campaign_status,
                MAX(campaign_type) AS campaign_type,
                MAX(currency) AS currency,
                COUNT(DISTINCT CASE WHEN spend > 0 THEN date END) AS active_days,
                ${METRIC_SUMS}
         FROM \`${CAMPAIGN_TABLE}\`
         WHERE date >= ? AND date <= ? ${ch ? "AND channel = ?" : ""}
         GROUP BY channel, campaign_id
         ORDER BY spend DESC
         LIMIT ${MAX_CAMPAIGNS}`,
        ch ? [start, end, ch] : [start, end],
      ),
    null,
  );
  if (!rows) return { setup: false, campaigns: [] };

  const campaigns = rows.map((row) => ({
    channel: row.channel,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name || row.campaign_id,
    status: row.campaign_status || null,
    type: row.campaign_type || null,
    currency: row.currency || null,
    activeDays: num(row.active_days),
    ...shapeMetrics(row),
    alerts: breachesFor(rules, row),
  }));
  return { setup: true, start, end, channel: ch || "all", campaigns };
}

async function getCampaignAds({ conn, start, end, channel, campaignId }) {
  assertRange(start, end);
  const ch = normalizeChannel(channel);
  if (!ch) throw badRequest("channel is required");
  if (!campaignId) throw badRequest("campaign_id is required");
  if (!conn) return { ads: [] };

  const rows = await orMissing(
    () =>
      select(
        conn,
        `SELECT ad_id, MAX(ad_name) AS ad_name, MAX(adset_name) AS adset_name,
                MAX(landing_path) AS landing_path, MAX(product_id) AS product_id,
                ${METRIC_SUMS}
         FROM \`${AD_TABLE}\`
         WHERE date >= ? AND date <= ? AND channel = ? AND campaign_id = ?
         GROUP BY ad_id
         ORDER BY spend DESC
         LIMIT 500`,
        [start, end, ch, String(campaignId)],
      ),
    [],
  );
  return {
    ads: rows.map((row) => ({
      adId: row.ad_id,
      adName: row.ad_name || row.ad_id,
      adsetName: row.adset_name || null,
      landingPath: row.landing_path || null,
      productId: row.product_id ? String(row.product_id) : null,
      ...shapeMetrics(row),
    })),
  };
}

// --- Products ---------------------------------------------------------------

async function fetchProductTitles(conn) {
  return orMissing(
    () =>
      select(
        conn,
        `SELECT product_id, MAX(product_title) AS title, MAX(landing_page_path) AS path
         FROM product_landing_page_map GROUP BY product_id`,
        [],
      ),
    [],
  );
}

// Product revenue each channel's traffic brought, from the pipeline's
// product_utm_daily (utm_source x product). This is "what did Meta/Google
// visitors buy", which pairs with the spend that channel put on that product.
async function fetchProductRevenue(conn, start, end) {
  const sources = [...CHANNEL_UTM_SOURCES.meta, ...CHANNEL_UTM_SOURCES.google];
  const placeholders = sources.map(() => "?").join(", ");
  const metaPlaceholders = CHANNEL_UTM_SOURCES.meta.map(() => "?").join(", ");
  return orMissing(
    () =>
      select(
        conn,
        `SELECT product_id,
                SUM(CASE WHEN LOWER(utm_source) IN (${metaPlaceholders}) THEN sales ELSE 0 END)  AS meta_sales,
                SUM(CASE WHEN LOWER(utm_source) IN (${metaPlaceholders}) THEN orders ELSE 0 END) AS meta_orders,
                SUM(CASE WHEN LOWER(utm_source) NOT IN (${metaPlaceholders}) THEN sales ELSE 0 END)  AS google_sales,
                SUM(CASE WHEN LOWER(utm_source) NOT IN (${metaPlaceholders}) THEN orders ELSE 0 END) AS google_orders
         FROM product_utm_daily
         WHERE date >= ? AND date <= ? AND LOWER(utm_source) IN (${placeholders})
         GROUP BY product_id`,
        [
          ...CHANNEL_UTM_SOURCES.meta,
          ...CHANNEL_UTM_SOURCES.meta,
          ...CHANNEL_UTM_SOURCES.meta,
          ...CHANNEL_UTM_SOURCES.meta,
          start,
          end,
          ...sources,
        ],
      ),
    [],
  );
}

function ratio(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator) : null;
}

async function getProducts({ conn, start, end }) {
  assertRange(start, end);
  if (!conn) return { setup: false, products: [] };

  const spendRows = await orMissing(
    () =>
      select(
        conn,
        `SELECT product_id, channel,
                COALESCE(SUM(spend), 0) AS spend,
                COALESCE(SUM(clicks), 0) AS clicks,
                COALESCE(SUM(platform_purchase_value), 0) AS platform_purchase_value
         FROM \`${PRODUCT_TABLE}\`
         WHERE date >= ? AND date <= ?
         GROUP BY product_id, channel`,
        [start, end],
      ),
    null,
  );
  if (!spendRows) return { setup: false, products: [] };

  const [revenueRows, titleRows] = await Promise.all([fetchProductRevenue(conn, start, end), fetchProductTitles(conn)]);
  const titles = new Map(titleRows.map((row) => [String(row.product_id), row]));
  const revenue = new Map(revenueRows.map((row) => [String(row.product_id), row]));

  const products = new Map();
  for (const row of spendRows) {
    const id = String(row.product_id);
    const entry = products.get(id) || { productId: id, metaSpend: 0, googleSpend: 0, platformValue: 0, clicks: 0 };
    entry[`${row.channel}Spend`] = round(entry[`${row.channel}Spend`] + num(row.spend));
    entry.platformValue = round(entry.platformValue + num(row.platform_purchase_value));
    entry.clicks += num(row.clicks);
    products.set(id, entry);
  }

  const rows = [...products.values()].map((entry) => {
    const unattributed = entry.productId === String(UNATTRIBUTED_PRODUCT_ID);
    const rev = revenue.get(entry.productId) || {};
    const metaSales = unattributed ? null : round(num(rev.meta_sales));
    const googleSales = unattributed ? null : round(num(rev.google_sales));
    const spend = round(entry.metaSpend + entry.googleSpend);
    const sales = unattributed ? null : round(metaSales + googleSales);
    const title = titles.get(entry.productId);
    return {
      ...entry,
      unattributed,
      title: unattributed ? "Not tied to one product" : title?.title || `Product ${entry.productId}`,
      path: unattributed ? null : title?.path || null,
      spend,
      metaSales,
      googleSales,
      sales,
      orders: unattributed ? null : num(rev.meta_orders) + num(rev.google_orders),
      metaRoas: unattributed ? null : ratio(metaSales, entry.metaSpend),
      googleRoas: unattributed ? null : ratio(googleSales, entry.googleSpend),
      roas: unattributed ? null : ratio(sales, spend),
    };
  });
  rows.sort((a, b) => b.spend - a.spend);

  const totalSpend = round(rows.reduce((acc, row) => acc + row.spend, 0));
  const attributedSpend = round(rows.filter((row) => !row.unattributed).reduce((acc, row) => acc + row.spend, 0));
  return {
    setup: true,
    start,
    end,
    products: rows,
    totals: {
      spend: totalSpend,
      attributedSpend,
      attributedShare: totalSpend > 0 ? round((attributedSpend / totalSpend) * 100, 1) : null,
    },
  };
}

// --- Landing pages: LC -> LPV vs site speed ---------------------------------

// web_vitals_summary.url looks like https://<shop>/<shop>/products/x (the
// shop domain repeated as the first path segment), so drop a first segment
// that is a hostname before comparing with ads_ad_daily.landing_path.
function vitalsPath(url) {
  let path;
  try {
    path = new URL(String(url)).pathname;
  } catch {
    return null;
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.length && parts[0].includes(".")) parts.shift();
  return `/${parts.join("/")}`.toLowerCase().replace(/\/+$/, "") || "/";
}

function lcpBucket(lcp) {
  if (lcp === null || lcp === undefined) return null;
  return LCP_BUCKETS.find((bucket) => lcp <= bucket.max)?.id || null;
}

async function fetchSiteSpeed(conn, start, end) {
  const rows = await orMissing(
    () =>
      select(
        conn,
        `SELECT url, AVG(lcp) AS lcp, AVG(fcp) AS fcp, AVG(performance) AS performance, COUNT(*) AS samples
         FROM web_vitals_summary
         WHERE date >= ? AND date <= ? AND lcp IS NOT NULL
         GROUP BY url`,
        [start, end],
      ),
    [],
  );
  const byPath = new Map();
  for (const row of rows) {
    const path = vitalsPath(row.url);
    if (!path) continue;
    const prev = byPath.get(path);
    const samples = num(row.samples);
    if (!prev) {
      byPath.set(path, { lcp: num(row.lcp), fcp: num(row.fcp), performance: num(row.performance), samples });
      continue;
    }
    // Same path under two URLs: sample-weighted average.
    const total = prev.samples + samples;
    for (const key of ["lcp", "fcp", "performance"]) {
      prev[key] = (prev[key] * prev.samples + num(row[key]) * samples) / total;
    }
    prev.samples = total;
  }
  return byPath;
}

async function getLandingPages({ conn, start, end }) {
  assertRange(start, end);
  if (!conn) return { setup: false, pages: [], speedBuckets: [] };

  const rows = await orMissing(
    () =>
      select(
        conn,
        `SELECT COALESCE(landing_path, '') AS landing_path,
                COUNT(DISTINCT ad_id) AS ads,
                COALESCE(SUM(spend), 0) AS spend,
                COALESCE(SUM(clicks), 0) AS clicks,
                COALESCE(SUM(link_clicks), 0) AS link_clicks,
                COALESCE(SUM(landing_page_views), 0) AS landing_page_views,
                COALESCE(SUM(platform_purchase_value), 0) AS platform_purchase_value
         FROM \`${AD_TABLE}\`
         WHERE date >= ? AND date <= ? AND channel = 'meta'
         GROUP BY COALESCE(landing_path, '')
         ORDER BY link_clicks DESC
         LIMIT 300`,
        [start, end],
      ),
    null,
  );
  if (!rows) return { setup: false, pages: [], speedBuckets: [] };

  const speed = await fetchSiteSpeed(conn, start, end);
  const pages = rows.map((row) => {
    const path = row.landing_path || null;
    const vitals = path ? speed.get(path) : null;
    const lcp = vitals ? round(vitals.lcp) : null;
    return {
      landingPath: path,
      ads: num(row.ads),
      spend: round(num(row.spend)),
      linkClicks: num(row.link_clicks),
      landingPageViews: num(row.landing_page_views),
      lpvRate: round(metricValue("lpv_rate", row)),
      lostClicks: Math.max(0, num(row.link_clicks) - num(row.landing_page_views)),
      roas: round(metricValue("roas", row)),
      lcp,
      fcp: vitals ? round(vitals.fcp) : null,
      performance: vitals ? Math.round(vitals.performance) : null,
      speedBucket: lcpBucket(lcp),
    };
  });

  // LC -> LPV rate per LCP band: the "is slowness costing us clicks" view.
  const speedBuckets = LCP_BUCKETS.map((bucket) => {
    const inBucket = pages.filter((page) => page.speedBucket === bucket.id);
    const linkClicks = inBucket.reduce((acc, page) => acc + page.linkClicks, 0);
    const lpv = inBucket.reduce((acc, page) => acc + page.landingPageViews, 0);
    return {
      id: bucket.id,
      label: bucket.label,
      pages: inBucket.length,
      linkClicks,
      landingPageViews: lpv,
      lpvRate: linkClicks > 0 ? round((lpv / linkClicks) * 100) : null,
    };
  });
  const unmeasured = pages.filter((page) => page.speedBucket === null);

  return {
    setup: true,
    start,
    end,
    pages,
    speedBuckets,
    unmeasuredPages: unmeasured.length,
  };
}

module.exports = {
  getOverview,
  getCampaigns,
  getCampaignAds,
  getProducts,
  getLandingPages,
  vitalsPath,
  previousRange,
  CAMPAIGN_TABLE,
  AD_TABLE,
  PRODUCT_TABLE,
};
