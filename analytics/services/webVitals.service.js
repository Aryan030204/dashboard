const { QueryTypes } = require("sequelize");
const { resolveTenantRoute } = require("../shared/db/tenantRouterClient");
const { getTenantConnection } = require("../shared/db/tenantConnection");
const { getDynamicBrandsMap } = require("../config/brands");
const {
  resolveAccessibleBrandKeys,
  humanizeBrandKey,
} = require("./overallSnapshotService");

const METRICS = ["performance", "fcp", "lcp", "ttfb", "inp", "cls"];

// Standard Core Web Vitals thresholds for fcp/lcp/ttfb/inp/cls. The
// `performance` score uses its own 4-tier scale — see getPerformanceStatus.
const THRESHOLDS = {
  fcp: { good: 1.8, needsImprovement: 3, direction: "lower" },
  lcp: { good: 2.5, needsImprovement: 4, direction: "lower" },
  ttfb: { good: 0.8, needsImprovement: 1.8, direction: "lower" },
  inp: { good: 200, needsImprovement: 500, direction: "lower" },
  cls: { good: 0.1, needsImprovement: 0.25, direction: "lower" },
};

function numberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// Custom (non-Lighthouse) scale for the Performance score: good >59,
// needs attention 47-59, poor 40-46, critical <=39.
function getPerformanceStatus(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (value > 59) return "good";
  if (value >= 47) return "needs_attention";
  if (value >= 40) return "poor";
  return "critical";
}

function getStatus(metric, value) {
  if (metric === "performance") return getPerformanceStatus(value);
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const t = THRESHOLDS[metric];
  if (!t) return null;
  if (t.direction === "higher") {
    if (value >= t.good) return "good";
    if (value >= t.needsImprovement) return "needs_improvement";
    return "poor";
  }
  if (value <= t.good) return "good";
  if (value <= t.needsImprovement) return "needs_improvement";
  return "poor";
}

function getPreviousIsoDate(value) {
  const [year, month, day] = String(value || "")
    .split("-")
    .map((part) => Number(part));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return value;
  }
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  utcDate.setUTCDate(utcDate.getUTCDate() - 1);
  return utcDate.toISOString().slice(0, 10);
}

function mapMetricRow(row) {
  return {
    performance: numberOrNull(row?.performance),
    fcp: numberOrNull(row?.fcp),
    lcp: numberOrNull(row?.lcp),
    ttfb: numberOrNull(row?.ttfb),
    inp: numberOrNull(row?.inp),
    cls: numberOrNull(row?.cls),
  };
}

const AVERAGE_METRICS_SQL = `
  SELECT
    AVG(avg_performance) AS performance,
    AVG(avg_fcp) AS fcp,
    AVG(avg_lcp) AS lcp,
    AVG(avg_ttfb) AS ttfb,
    AVG(avg_inp) AS inp,
    AVG(avg_cls) AS cls,
    SUM(sample_count) AS count
  FROM daily_web_vitals_summary
  WHERE date = ?
`;

async function averageMetricsForDate(conn, date) {
  const rows = await conn.query(AVERAGE_METRICS_SQL, {
    type: QueryTypes.SELECT,
    replacements: [date],
  });
  return rows?.[0] || null;
}

async function getSnapshot({ conn, date }) {
  const previousDate = getPreviousIsoDate(date);

  const [currentAgg, previousAgg] = await Promise.all([
    averageMetricsForDate(conn, date),
    averageMetricsForDate(conn, previousDate),
  ]);

  const currentValues = mapMetricRow(currentAgg);
  const previousValues = mapMetricRow(previousAgg);

  const metrics = {};
  const previousMetrics = {};
  for (const metric of METRICS) {
    const currentValue = currentValues[metric];
    const previousValue = previousValues[metric];
    metrics[metric] = {
      value: currentValue,
      status: getStatus(metric, currentValue),
      deltaPct:
        currentValue !== null && previousValue !== null && previousValue !== 0
          ? ((currentValue - previousValue) / previousValue) * 100
          : null,
    };
    previousMetrics[metric] = { value: previousValue };
  }

  return {
    date,
    previousDate,
    sampleCount: Number(currentAgg?.count || 0),
    previousSampleCount: Number(previousAgg?.count || 0),
    metrics,
    previousMetrics,
  };
}

const MAX_TREND_URL_LENGTH = 500;

// The spellings one page can be stored under in daily_web_vitals_summary: with or without a trailing slash, and
// with the host repeated as the first path segment ("https://shop.com/shop.com/products/x"), which the PageSpeed
// service sometimes writes. The page list on the client comes from PageSpeed, so the match must be forgiving.
function urlVariants(rawUrl) {
  const raw = String(rawUrl || "").trim();
  if (!raw) return [];
  const out = new Set([raw]);
  try {
    const parsed = new URL(raw);
    const host = parsed.host;
    const search = `${parsed.search}${parsed.hash}`;
    let path = parsed.pathname;
    if (path === `/${host}`) path = "/";
    else if (path.startsWith(`/${host}/`)) path = path.slice(host.length + 1);
    const bare = path.length > 1 ? path.replace(/\/+$/, "") : path;
    const slashed = bare.endsWith("/") ? bare : `${bare}/`;
    for (const p of [bare, slashed]) {
      out.add(`${parsed.protocol}//${host}${p === "/" ? "" : p}${search}`);
      out.add(`${parsed.protocol}//${host}${p}${search}`);
      out.add(`${parsed.protocol}//${host}/${host}${p === "/" ? "" : p}${search}`);
      out.add(`${parsed.protocol}//${host}/${host}${p}${search}`);
    }
  } catch (_err) {
    /* not a URL: only the raw text is matched */
  }
  return [...out];
}

// Daily averages for the brand, or (with `url`) for one page of it.
async function getTrend({ conn, start, end, url = null }) {
  const variants = url ? urlVariants(String(url).slice(0, MAX_TREND_URL_LENGTH)) : [];
  const urlFilter = variants.length ? `AND url IN (${variants.map(() => "?").join(", ")})` : "";
  const rows = await conn.query(
    `
      SELECT
        date,
        AVG(avg_performance) AS performance,
        AVG(avg_fcp) AS fcp,
        AVG(avg_lcp) AS lcp,
        AVG(avg_ttfb) AS ttfb,
        AVG(avg_inp) AS inp,
        AVG(avg_cls) AS cls
      FROM daily_web_vitals_summary
      WHERE date >= ? AND date <= ? ${urlFilter}
      GROUP BY date
      ORDER BY date ASC
    `,
    {
      type: QueryTypes.SELECT,
      replacements: [start, end, ...variants],
    },
  );

  return {
    granularity: "daily",
    url: variants.length ? String(url) : null,
    // A day with no value for a metric (AVG over nothing) stays null so the chart shows a gap, not a 0.
    points: rows.map((row) => ({
      label: row.date,
      ...Object.fromEntries(METRICS.map((metric) => [metric, row[metric] === null || row[metric] === undefined ? null : numberOrNull(row[metric])])),
    })),
  };
}

async function getPageBreakdown({ conn, date }) {
  const rows = await conn.query(
    `
      SELECT
        page_name,
        url,
        avg_performance,
        avg_fcp,
        avg_lcp,
        avg_ttfb,
        avg_inp,
        avg_cls,
        date
      FROM daily_web_vitals_summary
      WHERE date = ?
      ORDER BY avg_performance ASC
    `,
    {
      type: QueryTypes.SELECT,
      replacements: [date],
    },
  );

  return rows.map((row) => {
    const performance = numberOrNull(row.avg_performance);
    return {
      page_name: row.page_name || "",
      url: row.url || "",
      performance,
      performance_status: getStatus("performance", performance),
      fcp: numberOrNull(row.avg_fcp),
      lcp: numberOrNull(row.avg_lcp),
      ttfb: numberOrNull(row.avg_ttfb),
      inp: numberOrNull(row.avg_inp),
      cls: numberOrNull(row.avg_cls),
      date: row.date || null,
    };
  });
}

async function getBrandSnapshot(brandKey, date) {
  try {
    const route = await resolveTenantRoute(brandKey);
    if (!route || route.error) {
      return {
        brand_key: brandKey,
        brand_name: humanizeBrandKey(brandKey),
        sampleCount: 0,
        metrics: null,
      };
    }
    const tenant = getTenantConnection({ ...route, brandId: brandKey });
    const agg = await averageMetricsForDate(tenant.sequelize, date);
    const values = mapMetricRow(agg);
    const metrics = {};
    for (const metric of METRICS) {
      const value = values[metric];
      metrics[metric] = { value, status: getStatus(metric, value) };
    }
    return {
      brand_key: brandKey,
      brand_name: humanizeBrandKey(brandKey),
      sampleCount: Number(agg?.count || 0),
      metrics,
    };
  } catch {
    return {
      brand_key: brandKey,
      brand_name: humanizeBrandKey(brandKey),
      sampleCount: 0,
      metrics: null,
    };
  }
}

async function getAllBrandsSnapshot({ date, user = {} }) {
  const accessibleBrandKeys = resolveAccessibleBrandKeys(user, await getDynamicBrandsMap());
  const brands = await Promise.all(
    accessibleBrandKeys.map((brandKey) => getBrandSnapshot(brandKey, date)),
  );
  return brands;
}

module.exports = {
  getSnapshot,
  getTrend,
  urlVariants,
  MAX_TREND_URL_LENGTH,
  getPageBreakdown,
  getAllBrandsSnapshot,
};
