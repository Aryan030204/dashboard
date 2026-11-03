const { QueryTypes } = require("sequelize");
const {
  computePercentDelta,
  computeReturnCounts,
  computeReturnCountsPair,
  appendProductFilter,
} = require("../shared/utils/metricsUtils");
const { matchDatePreset } = require("./metricsCacheService");
const {
  appendUtmWhere,
} = require("../shared/utils/filters");
const {
  parseIsoDate,
  formatIsoDate,
  DEFAULT_TIMEZONE,
  normalizeTimezone,
} = require("../shared/utils/date");
const {
  DAY_MS,
  pad2,
  getTimezoneContext,
  parseHourFromCutoff,
  resolveCompareRange,
  buildLiveCutoffContext,
  buildCompletedHourCutoffContext,
  buildRowTwoComparisonCutoffs,
  ciEventsSqlExpr,
} = require("./metricsFoundation");
const {
  normalizeMetricRequest,
} = require("./metricsRequestNormalizer");
const {
  queryOverallSummaryTotals,
  queryOverallSummaryPair,
  queryOrderSalesTotals,
  queryUtmAggregateTotals,
  queryUtmAggregatePair,
  queryUtmAggregateRows,
  queryDiscountAggregateTotals,
  queryDiscountAggregatePair,
  queryDiscountAggregateRows,
  queryProductTypeAggregateTotals,
  queryProductTypeAggregatePair,
  queryProductTypeAggregateRows,
  queryUtmSummaryFilterOptions,
  queryProductDailySessionTotals,
  resolveUtmAggregateSource,
  resolveDiscountAggregateSource,
  resolveProductTypeAggregateSource,
  hasDiscountFilter,
  hasProductTypeFilter,
  isCombinedProductUtmSourceFilter,
} = require("./metricsAggregateService");

const buildCutoffContext = buildLiveCutoffContext;
const getUtmAggregateSource = resolveUtmAggregateSource;
const getDiscountAggregateSource = resolveDiscountAggregateSource;
const getProductTypeAggregateSource = resolveProductTypeAggregateSource;

function hasAnyFilters(filters = {}) {
  return !!(
    filters.utm_source ||
    filters.utm_medium ||
    filters.utm_campaign ||
    filters.utm_term ||
    filters.utm_content ||
    filters.sales_channel ||
    filters.device_type ||
    filters.product_id ||
    filters.discount_code ||
    filters.city ||
    hasProductTypeFilter(filters)
  );
}

function hasSnapshotFilters(filters = {}) {
  return !!(
    filters.utm_source ||
    filters.utm_medium ||
    filters.utm_campaign ||
    filters.utm_term ||
    filters.utm_content
  );
}

function hasCityFilter(filters = {}) {
  if (Array.isArray(filters.city)) return filters.city.length > 0;
  return !!filters.city;
}

function appendCityWhere(sql, replacements, city, column = "city") {
  const cities = Array.isArray(city) ? city.filter(Boolean) : city ? [city] : [];
  if (cities.length === 0) return sql;
  if (cities.length === 1) {
    replacements.push(cities[0]);
    return `${sql} AND ${column} = ?`;
  }
  replacements.push(...cities);
  return `${sql} AND ${column} IN (${cities.map(() => "?").join(", ")})`;
}

function buildNormalizedUtmSourceSql(column = "utm_source") {
  return `
    CASE
      WHEN ${column} IS NULL
        OR TRIM(${column}) = ''
        OR LOWER(TRIM(${column})) IN ('(none)', 'none', 'null', 'direct')
      THEN 'direct'
      ELSE TRIM(${column})
    END
  `;
}

function buildNormalizedUtmCampaignSql(column = "utm_campaign") {
  return `
    CASE
      WHEN ${column} IS NULL
        OR TRIM(${column}) = ''
        OR LOWER(TRIM(${column})) IN ('(none)', 'none', 'null')
      THEN '(none)'
      ELSE TRIM(${column})
    END
  `;
}

async function queryCurrentRowTwoSessionTotals(
  conn,
  start,
  end,
  filters = {},
  cutoffHour = 23,
) {
  if (getUtmAggregateSource(filters, "hourly")) {
    const totals = await queryUtmAggregateTotals(conn, start, end, filters, {
      granularity: "hourly",
      cutoffHour,
    });
    return {
      total_sessions: totals.total_sessions,
      total_atc_sessions: totals.total_atc_sessions,
    };
  }
  if (filters.device_type) {
    return queryDeviceHourlyTotals(conn, start, end, filters, cutoffHour);
  }
  if (hasCityFilter(filters)) {
    return queryCitySessionTotals(conn, start, end, filters, cutoffHour);
  }
  if (filters.product_id || hasSnapshotFilters(filters)) {
    return queryHourlyProductSessionTotals(conn, start, end, cutoffHour, filters);
  }
  if (!hasAnyFilters(filters)) {
    return queryHourlySessionTotals(conn, start, end, cutoffHour);
  }
  return queryHourlySessionTotals(conn, start, end, cutoffHour);
}

async function queryPreviousRowTwoSessionTotals(
  conn,
  start,
  end,
  filters = {},
  cutoffHour = 23,
) {
  if (getUtmAggregateSource(filters, "hourly")) {
    const totals = await queryUtmAggregateTotals(conn, start, end, filters, {
      granularity: "hourly",
      cutoffHour,
    });
    return {
      total_sessions: totals.total_sessions,
      total_atc_sessions: totals.total_atc_sessions,
    };
  }
  if (filters.device_type) {
    return queryDeviceHourlyTotals(conn, start, end, filters, cutoffHour);
  }
  if (hasCityFilter(filters)) {
    return queryCitySessionTotals(conn, start, end, filters, cutoffHour);
  }
  if (filters.product_id || hasSnapshotFilters(filters)) {
    return queryHourlyProductSessionTotals(conn, start, end, cutoffHour, filters);
  }
  return queryHourlySessionTotals(conn, start, end, cutoffHour);
}

function buildSnapshotSessionFilters(filters = {}) {
  return {
    utm_source: filters.utm_source,
    utm_medium: filters.utm_medium,
    utm_campaign: filters.utm_campaign,
    utm_term: filters.utm_term,
    utm_content: filters.utm_content,
  };
}

function buildDeviceExpressions(deviceType) {
  const types = Array.isArray(deviceType) ? deviceType : [deviceType];
  const sessionCols = [];
  const atcCols = [];
  for (const rawType of types) {
    const lower = (rawType || "").toString().toLowerCase().trim();
    if (lower === "desktop") {
      sessionCols.push("COALESCE(desktop_sessions, 0)");
      atcCols.push("COALESCE(desktop_atc_sessions, 0)");
    } else if (lower === "mobile") {
      sessionCols.push("COALESCE(mobile_sessions, 0)", "COALESCE(tablet_sessions, 0)");
      atcCols.push(
        "COALESCE(mobile_atc_sessions, 0)",
        "COALESCE(tablet_atc_sessions, 0)",
      );
    } else if (lower === "others") {
      sessionCols.push("COALESCE(other_sessions, 0)");
      atcCols.push("COALESCE(other_atc_sessions, 0)");
    }
  }

  return {
    sessionExpr:
      sessionCols.length > 0
        ? sessionCols.join(" + ")
        : "COALESCE(adjusted_number_of_sessions, number_of_sessions)",
    atcExpr:
      atcCols.length > 0
        ? atcCols.join(" + ")
        : "COALESCE(number_of_atc_sessions, 0)",
  };
}

async function querySnapshotSessionTotals(conn, start, end, filters = {}) {
  let sql = `
    SELECT
      COALESCE(SUM(sessions), 0) AS total_sessions,
      COALESCE(SUM(sessions_with_cart_additions), 0) AS total_atc_sessions
    FROM product_sessions_snapshot
    WHERE date >= ? AND date <= ?
  `;
  const replacements = [start, end];
  sql = appendUtmWhere(sql, replacements, buildSnapshotSessionFilters(filters), true);
  const rows = await conn.query(sql, {
    type: QueryTypes.SELECT,
    replacements,
  });
  return rows?.[0] || {};
}

async function queryDeviceHourlyTotals(conn, start, end, filters = {}, cutoffHour = 23) {
  const { sessionExpr, atcExpr } = buildDeviceExpressions(filters.device_type);

  const sql = `
    SELECT
      COALESCE(SUM(${sessionExpr}), 0) AS total_sessions,
      COALESCE(SUM(${atcExpr}), 0) AS total_atc_sessions
    FROM hourly_sessions_summary_shopify
    WHERE date >= ? AND date <= ? AND hour <= ?
  `;
  const rows = await conn.query(sql, {
    type: QueryTypes.SELECT,
    replacements: [start, end, cutoffHour],
  });
  return rows?.[0] || {};
}

async function queryHourlySessionTotals(conn, start, end, cutoffHour = 23) {
  const sql = `
    SELECT
      COALESCE(SUM(COALESCE(adjusted_number_of_sessions, number_of_sessions)), 0) AS total_sessions,
      COALESCE(SUM(number_of_atc_sessions), 0) AS total_atc_sessions
    FROM hourly_sessions_summary_shopify
    WHERE date >= ? AND date <= ? AND hour <= ?
  `;
  const rows = await conn.query(sql, {
    type: QueryTypes.SELECT,
    replacements: [start, end, cutoffHour],
  });
  return rows?.[0] || {};
}

async function queryCitySessionTotals(
  conn,
  start,
  end,
  filters = {},
  cutoffHour = null,
) {
  const hasCutoff = Number.isInteger(cutoffHour);
  let sql = `
    SELECT
      COALESCE(SUM(sessions), 0) AS total_sessions,
      COALESCE(SUM(atc_sessions), 0) AS total_atc_sessions
    FROM ${hasCutoff ? "hourly_city_sessions_summary_shopify" : "daily_city_sessions_summary_shopify"}
    WHERE date >= ? AND date <= ?
  `;
  const replacements = [start, end];
  if (hasCutoff) {
    sql += " AND hour <= ?";
    replacements.push(cutoffHour);
  }
  sql = appendCityWhere(sql, replacements, filters.city);
  const rows = await conn.query(sql, {
    type: QueryTypes.SELECT,
    replacements,
  });
  return rows?.[0] || {};
}

async function queryCityOrderSalesTotals(
  conn,
  start,
  end,
  filters = {},
  cutoffHour = null,
) {
  const hasCutoff = Number.isInteger(cutoffHour);
  let sql = `
    SELECT
      COALESCE(SUM(total_orders), 0) AS total_orders,
      COALESCE(SUM(total_revenue), 0) AS total_sales
    FROM ${hasCutoff ? "hourly_citywise_summary" : "daily_citywise_summary"}
    WHERE date >= ? AND date <= ?
  `;
  const replacements = [start, end];
  if (hasCutoff) {
    sql += " AND hour <= ?";
    replacements.push(cutoffHour);
  }
  sql = appendCityWhere(sql, replacements, filters.city);
  const rows = await conn.query(sql, {
    type: QueryTypes.SELECT,
    replacements,
  });
  return rows?.[0] || {};
}

async function queryCityRows(
  conn,
  start,
  end,
  filters = {},
  granularity = "daily",
  cutoffHour = null,
) {
  const replacements = [start, end];
  let sql;
  if (granularity === "hourly") {
    sql = `
      SELECT
        DATE_FORMAT(date, '%Y-%m-%d') AS date,
        hour,
        COALESCE(SUM(total_revenue), 0) AS sales,
        COALESCE(SUM(total_orders), 0) AS orders,
        COALESCE(SUM(sessions), 0) AS sessions,
        COALESCE(SUM(atc_sessions), 0) AS atc,
        0 AS ci_events
      FROM hourly_citywise_summary
      WHERE date >= ? AND date <= ?
    `;
    if (Number.isInteger(cutoffHour)) {
      sql += " AND hour <= ?";
      replacements.push(cutoffHour);
    }
    sql = appendCityWhere(sql, replacements, filters.city);
    sql += " GROUP BY date, hour ORDER BY date ASC, hour ASC";
  } else {
    sql = `
      SELECT
        DATE_FORMAT(date, '%Y-%m-%d') AS date,
        COALESCE(SUM(total_revenue), 0) AS sales,
        COALESCE(SUM(total_orders), 0) AS orders,
        COALESCE(SUM(sessions), 0) AS sessions,
        COALESCE(SUM(atc_sessions), 0) AS atc,
        0 AS ci_events
      FROM daily_citywise_summary
      WHERE date >= ? AND date <= ?
    `;
    sql = appendCityWhere(sql, replacements, filters.city);
    sql += " GROUP BY date ORDER BY date ASC";
  }
  return conn.query(sql, {
    type: QueryTypes.SELECT,
    replacements,
  });
}

async function queryCheckoutInitiatedTotals(conn, start, end, cutoffHour = null, brandKey = null) {
  const ciEventsExpr = ciEventsSqlExpr(brandKey);
  const hasCutoff = Number.isInteger(cutoffHour);
  if (!hasCutoff) {
    const rows = await conn.query(
      `
        SELECT
          COALESCE(SUM(${ciEventsExpr}), 0) AS total_ci_events
        FROM hourly_sessions_summary_shopify
        WHERE date >= ? AND date <= ?
      `,
      {
        type: QueryTypes.SELECT,
        replacements: [start, end],
      },
    );
    return Number(rows?.[0]?.total_ci_events || 0);
  }

  const sql = `
    SELECT
      COALESCE(SUM(${ciEventsExpr}), 0) AS total_ci_events
    FROM hourly_sessions_summary_shopify
    WHERE date >= ? AND date <= ?${hasCutoff ? " AND hour <= ?" : ""}
  `;
  const replacements = hasCutoff ? [start, end, cutoffHour] : [start, end];
  const rows = await conn.query(sql, {
    type: QueryTypes.SELECT,
    replacements,
  });
  return Number(rows?.[0]?.total_ci_events || 0);
}

async function queryCheckoutInitiatedPair(
  conn,
  currentRange,
  previousRange,
  currentCutoffHour = null,
  previousCutoffHour = null,
  brandKey = null,
) {
  const [current, previous] = await Promise.all([
    queryCheckoutInitiatedTotals(
      conn,
      currentRange.start,
      currentRange.end,
      currentCutoffHour,
      brandKey,
    ),
    queryCheckoutInitiatedTotals(
      conn,
      previousRange.start,
      previousRange.end,
      previousCutoffHour,
      brandKey,
    ),
  ]);

  return { current, previous };
}

async function queryCheckoutInitiatedRows(
  conn,
  start,
  end,
  granularity = "hourly",
  cutoffHour = null,
  brandKey = null,
) {
  const ciEventsExpr = ciEventsSqlExpr(brandKey);
  if (granularity === "daily") {
    const rows = await conn.query(
      `
        SELECT
          DATE_FORMAT(date, '%Y-%m-%d') AS date,
          COALESCE(SUM(${ciEventsExpr}), 0) AS ci_events
        FROM hourly_sessions_summary_shopify
        WHERE date >= ? AND date <= ?
        GROUP BY date
        ORDER BY date ASC
      `,
      {
        type: QueryTypes.SELECT,
        replacements: [start, end],
      },
    );
    return Array.isArray(rows) ? rows : [];
  }

  const hasCutoff = Number.isInteger(cutoffHour);
  const rows = await conn.query(
    `
      SELECT
        DATE_FORMAT(date, '%Y-%m-%d') AS date,
        hour,
        ${ciEventsExpr} AS ci_events
      FROM hourly_sessions_summary_shopify
      WHERE date >= ? AND date <= ?${hasCutoff ? " AND hour <= ?" : ""}
      ORDER BY date ASC, hour ASC
    `,
    {
      type: QueryTypes.SELECT,
      replacements: hasCutoff ? [start, end, cutoffHour] : [start, end],
    },
  );
  return Array.isArray(rows) ? rows : [];
}

// `date` is the first day; `endDate` (optional) makes it an inclusive range of days.
async function queryDailyFunnelUtmRows(conn, date, cutoffHour = null, endDate = date) {
  const normalizedSourceSql = buildNormalizedUtmSourceSql();
  const hasCutoff = Number.isInteger(cutoffHour);
  const baseTable = hasCutoff ? "utm_source_hourly" : "utm_source_daily";
  const baseWhere = hasCutoff
    ? "WHERE metric_date >= ? AND metric_date <= ? AND metric_hour <= ?"
    : "WHERE metric_date >= ? AND metric_date <= ?";
  const baseReplacements = hasCutoff ? [date, endDate, cutoffHour] : [date, endDate];
  const orderWhere = hasCutoff
    ? "WHERE created_date >= ? AND created_date <= ? AND HOUR(created_time) <= ?"
    : "WHERE created_date >= ? AND created_date <= ?";
  const orderReplacements = hasCutoff ? [date, endDate, cutoffHour] : [date, endDate];

  const [baseRows, orderRows] = await Promise.all([
    conn.query(
      `
        SELECT
          ${normalizedSourceSql} AS utm_source,
          COALESCE(SUM(sales), 0) AS sales,
          COALESCE(SUM(sessions), 0) AS sessions,
          COALESCE(SUM(atc_sessions), 0) AS atc_sessions,
          COALESCE(SUM(orders), 0) AS orders
        FROM ${baseTable}
        ${baseWhere}
        GROUP BY ${normalizedSourceSql}
      `,
      {
        type: QueryTypes.SELECT,
        replacements: baseReplacements,
      },
    ),
    conn.query(
      `
        SELECT
          utm_source,
          COALESCE(SUM(CASE WHEN payment_type = 'Prepaid' THEN 1 ELSE 0 END), 0) AS prepaid_orders,
          COALESCE(SUM(CASE WHEN payment_type = 'COD' THEN 1 ELSE 0 END), 0) AS cod_orders,
          COALESCE(SUM(CASE WHEN payment_type = 'Partial' THEN 1 ELSE 0 END), 0) AS partially_paid_orders
        FROM (
          SELECT
            ${normalizedSourceSql} AS utm_source,
            order_name,
            CASE
              WHEN payment_gateway_names LIKE '%Gokwik PPCOD%' THEN 'Partial'
              WHEN (
                payment_gateway_names IS NULL
                OR payment_gateway_names = ''
                OR payment_gateway_names LIKE '%Cash on Delivery (COD)%'
                OR payment_gateway_names LIKE '%cash_on_delivery%'
              ) AND (
                payment_gateway_names NOT LIKE '%Gokwik PPCOD%'
                OR payment_gateway_names IS NULL
              ) THEN 'COD'
              ELSE 'Prepaid'
            END AS payment_type
          FROM shopify_orders
          ${orderWhere}
          GROUP BY ${normalizedSourceSql}, payment_gateway_names, order_name
        ) grouped_orders
        GROUP BY utm_source
      `,
      {
        type: QueryTypes.SELECT,
        replacements: orderReplacements,
      },
    ),
  ]);

  const bySource = new Map();

  for (const row of Array.isArray(baseRows) ? baseRows : []) {
    bySource.set(String(row.utm_source || "direct"), {
      utm_source: String(row.utm_source || "direct"),
      sales: Number(row.sales || 0),
      sessions: Number(row.sessions || 0),
      atc_sessions: Number(row.atc_sessions || 0),
      orders: Number(row.orders || 0),
      prepaid_orders: 0,
      cod_orders: 0,
      partially_paid_orders: 0,
    });
  }

  for (const row of Array.isArray(orderRows) ? orderRows : []) {
    const source = String(row.utm_source || "direct");
    const existing = bySource.get(source) || {
      utm_source: source,
      sales: 0,
      sessions: 0,
      atc_sessions: 0,
      orders: 0,
      prepaid_orders: 0,
      cod_orders: 0,
      partially_paid_orders: 0,
    };
    existing.prepaid_orders = Number(row.prepaid_orders || 0);
    existing.cod_orders = Number(row.cod_orders || 0);
    existing.partially_paid_orders = Number(row.partially_paid_orders || 0);
    bySource.set(source, existing);
  }

  return Array.from(bySource.values()).sort((left, right) =>
    String(left.utm_source || "").localeCompare(String(right.utm_source || "")),
  );
}

function buildDeltaMetric(current, previous) {
  const curr = Number(current || 0);
  const prev = Number(previous || 0);
  const diff = curr - prev;
  let diff_pct = 0;
  if (prev === 0) {
    diff_pct = curr === 0 ? 0 : 100;
  } else {
    diff_pct = (diff / prev) * 100;
  }
  return {
    current: curr,
    previous: prev,
    diff_pct,
    direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
  };
}

function getPreviousIsoDate(value) {
  const [year, month, day] = String(value || "").split("-").map((part) => Number(part));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return value;
  }
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  utcDate.setUTCDate(utcDate.getUTCDate() - 1);
  return utcDate.toISOString().slice(0, 10);
}

// The compared side is cut at the last completed hour only when the current range is the single day "today";
// longer ranges compare whole days.
function resolveUtmCompareWindow(date, endDate, compareDate, compareEndDate, cutoffCtx) {
  const lastDate = endDate || date;
  const previousDate = compareDate || getPreviousIsoDate(date);
  const previousEndDate = compareDate ? compareEndDate || compareDate : previousDate;
  const today = cutoffCtx?.today;
  const previousCutoffHour =
    today && date === today && lastDate === today && Number.isInteger(cutoffCtx?.cutoffHour)
      ? cutoffCtx.cutoffHour
      : null;
  return { lastDate, previousDate, previousEndDate, previousCutoffHour };
}

async function queryDailyFunnelUtmRowsWithDelta(
  conn,
  date,
  compareDate,
  cutoffCtx = null,
  { endDate = null, compareEndDate = null } = {},
) {
  const { lastDate, previousDate, previousEndDate, previousCutoffHour } =
    resolveUtmCompareWindow(date, endDate, compareDate, compareEndDate, cutoffCtx);
  const [currentRows, previousRows] = await Promise.all([
    queryDailyFunnelUtmRows(conn, date, null, lastDate),
    queryDailyFunnelUtmRows(conn, previousDate, previousCutoffHour, previousEndDate),
  ]);

  const previousMap = new Map(
    (Array.isArray(previousRows) ? previousRows : []).map((row) => [String(row.utm_source || 'direct'), row]),
  );

  return (Array.isArray(currentRows) ? currentRows : []).map((row) => {
    const previous = previousMap.get(String(row.utm_source || 'direct')) || {};
    return {
      ...row,
      previous_date: previousDate,
      previous_end_date: previousEndDate,
      previous: {
        sales: Number(previous.sales || 0),
        sessions: Number(previous.sessions || 0),
        atc_sessions: Number(previous.atc_sessions || 0),
        orders: Number(previous.orders || 0),
        prepaid_orders: Number(previous.prepaid_orders || 0),
        cod_orders: Number(previous.cod_orders || 0),
        partially_paid_orders: Number(previous.partially_paid_orders || 0),
      },
      deltas: {
        sales: buildDeltaMetric(row.sales, previous.sales),
        sessions: buildDeltaMetric(row.sessions, previous.sessions),
        atc_sessions: buildDeltaMetric(row.atc_sessions, previous.atc_sessions),
        orders: buildDeltaMetric(row.orders, previous.orders),
        prepaid_orders: buildDeltaMetric(row.prepaid_orders, previous.prepaid_orders),
        cod_orders: buildDeltaMetric(row.cod_orders, previous.cod_orders),
        partially_paid_orders: buildDeltaMetric(row.partially_paid_orders, previous.partially_paid_orders),
      },
    };
  });
}

async function queryDailyFunnelUtmCampaignRows(conn, date, utmSource, cutoffHour = null, endDate = date) {
  const normalizedSourceSql = buildNormalizedUtmSourceSql();
  const normalizedCampaignSql = buildNormalizedUtmCampaignSql();
  const hasCutoff = Number.isInteger(cutoffHour);
  const baseTable = hasCutoff ? "utm_source_campaign_hourly" : "utm_source_campaign_daily";
  const baseWhere = hasCutoff
    ? "WHERE metric_date >= ? AND metric_date <= ? AND utm_source = ? AND metric_hour <= ?"
    : "WHERE metric_date >= ? AND metric_date <= ? AND utm_source = ?";
  const baseReplacements = hasCutoff
    ? [date, endDate, utmSource, cutoffHour]
    : [date, endDate, utmSource];
  const orderWhere = hasCutoff
    ? "WHERE created_date >= ? AND created_date <= ? AND HOUR(created_time) <= ?"
    : "WHERE created_date >= ? AND created_date <= ?";
  const orderReplacements = hasCutoff
    ? [date, endDate, cutoffHour, utmSource]
    : [date, endDate, utmSource];

  const [baseRows, orderRows] = await Promise.all([
    conn.query(
      `
        SELECT
          ${normalizedCampaignSql} AS utm_campaign,
          COALESCE(SUM(sales), 0) AS sales,
          COALESCE(SUM(sessions), 0) AS sessions,
          COALESCE(SUM(atc_sessions), 0) AS atc_sessions,
          COALESCE(SUM(orders), 0) AS orders
        FROM ${baseTable}
        ${baseWhere}
        GROUP BY ${normalizedCampaignSql}
      `,
      {
        type: QueryTypes.SELECT,
        replacements: baseReplacements,
      },
    ),
    conn.query(
      `
        SELECT
          utm_campaign,
          COALESCE(SUM(CASE WHEN payment_type = 'Prepaid' THEN 1 ELSE 0 END), 0) AS prepaid_orders,
          COALESCE(SUM(CASE WHEN payment_type = 'COD' THEN 1 ELSE 0 END), 0) AS cod_orders,
          COALESCE(SUM(CASE WHEN payment_type = 'Partial' THEN 1 ELSE 0 END), 0) AS partially_paid_orders
        FROM (
          SELECT
            ${normalizedCampaignSql} AS utm_campaign,
            order_name,
            CASE
              WHEN payment_gateway_names LIKE '%Gokwik PPCOD%' THEN 'Partial'
              WHEN (
                payment_gateway_names IS NULL
                OR payment_gateway_names = ''
                OR payment_gateway_names LIKE '%Cash on Delivery (COD)%'
                OR payment_gateway_names LIKE '%cash_on_delivery%'
              ) AND (
                payment_gateway_names NOT LIKE '%Gokwik PPCOD%'
                OR payment_gateway_names IS NULL
              ) THEN 'COD'
              ELSE 'Prepaid'
            END AS payment_type
          FROM shopify_orders
          ${orderWhere} AND ${normalizedSourceSql} = ?
          GROUP BY ${normalizedCampaignSql}, payment_gateway_names, order_name
        ) grouped_orders
        GROUP BY utm_campaign
      `,
      {
        type: QueryTypes.SELECT,
        replacements: orderReplacements,
      },
    ),
  ]);

  const byCampaign = new Map();

  for (const row of Array.isArray(baseRows) ? baseRows : []) {
    byCampaign.set(String(row.utm_campaign || "(none)"), {
      utm_source: String(row.utm_campaign || "(none)"),
      sales: Number(row.sales || 0),
      sessions: Number(row.sessions || 0),
      atc_sessions: Number(row.atc_sessions || 0),
      orders: Number(row.orders || 0),
      prepaid_orders: 0,
      cod_orders: 0,
      partially_paid_orders: 0,
    });
  }

  for (const row of Array.isArray(orderRows) ? orderRows : []) {
    const campaign = String(row.utm_campaign || "(none)");
    const existing = byCampaign.get(campaign) || {
      utm_source: campaign,
      sales: 0,
      sessions: 0,
      atc_sessions: 0,
      orders: 0,
      prepaid_orders: 0,
      cod_orders: 0,
      partially_paid_orders: 0,
    };
    existing.prepaid_orders = Number(row.prepaid_orders || 0);
    existing.cod_orders = Number(row.cod_orders || 0);
    existing.partially_paid_orders = Number(row.partially_paid_orders || 0);
    byCampaign.set(campaign, existing);
  }

  return Array.from(byCampaign.values()).sort((left, right) =>
    String(left.utm_source || "").localeCompare(String(right.utm_source || "")),
  );
}

async function queryDailyFunnelUtmCampaignRowsWithDelta(
  conn,
  date,
  compareDate,
  utmSource,
  cutoffCtx = null,
  { endDate = null, compareEndDate = null } = {},
) {
  const { lastDate, previousDate, previousEndDate, previousCutoffHour } =
    resolveUtmCompareWindow(date, endDate, compareDate, compareEndDate, cutoffCtx);
  const [currentRows, previousRows] = await Promise.all([
    queryDailyFunnelUtmCampaignRows(conn, date, utmSource, null, lastDate),
    queryDailyFunnelUtmCampaignRows(conn, previousDate, utmSource, previousCutoffHour, previousEndDate),
  ]);

  const previousMap = new Map(
    (Array.isArray(previousRows) ? previousRows : []).map((row) => [String(row.utm_source || '(none)'), row]),
  );

  return (Array.isArray(currentRows) ? currentRows : []).map((row) => {
    const previous = previousMap.get(String(row.utm_source || '(none)')) || {};
    return {
      ...row,
      previous_date: previousDate,
      previous_end_date: previousEndDate,
      previous: {
        sales: Number(previous.sales || 0),
        sessions: Number(previous.sessions || 0),
        atc_sessions: Number(previous.atc_sessions || 0),
        orders: Number(previous.orders || 0),
        prepaid_orders: Number(previous.prepaid_orders || 0),
        cod_orders: Number(previous.cod_orders || 0),
        partially_paid_orders: Number(previous.partially_paid_orders || 0),
      },
      deltas: {
        sales: buildDeltaMetric(row.sales, previous.sales),
        sessions: buildDeltaMetric(row.sessions, previous.sessions),
        atc_sessions: buildDeltaMetric(row.atc_sessions, previous.atc_sessions),
        orders: buildDeltaMetric(row.orders, previous.orders),
        prepaid_orders: buildDeltaMetric(row.prepaid_orders, previous.prepaid_orders),
        cod_orders: buildDeltaMetric(row.cod_orders, previous.cod_orders),
        partially_paid_orders: buildDeltaMetric(row.partially_paid_orders, previous.partially_paid_orders),
      },
    };
  });
}

async function queryHourlyProductSessionTotals(conn, start, end, cutoffHour = 23, filters = {}) {
  let sql = `
    SELECT
      COALESCE(SUM(sessions), 0) AS total_sessions,
      COALESCE(SUM(sessions_with_cart_additions), 0) AS total_atc_sessions
    FROM hourly_product_sessions
    WHERE date >= ? AND date <= ? AND hour <= ?
  `;
  const replacements = [start, end, cutoffHour];
  sql = appendUtmWhere(sql, replacements, buildSnapshotSessionFilters(filters), true);
  sql = appendProductFilter(sql, replacements, filters.product_id);
  const rows = await conn.query(sql, {
    type: QueryTypes.SELECT,
    replacements,
  });
  return rows?.[0] || {};
}

async function getReturnsSnapshot(conn, start, end, filters = {}) {
  if (hasCityFilter(filters)) {
    return {
      cancelled_orders: null,
      refunded_orders: null,
      rto_orders: null,
    };
  }
  if (getUtmAggregateSource(filters, "daily")) {
    const totals = await queryUtmAggregateTotals(conn, start, end, filters, {
      granularity: "daily",
    });
    const returnTotals = await computeReturnCounts({ start, end, conn, filters });
    return {
      cancelled_orders: Number(totals?.cancelled_orders || 0),
      refunded_orders: Number(totals?.refunded_orders || 0),
      rto_orders: Number(returnTotals?.rto_orders || 0),
    };
  }
  const rows = await computeReturnCounts({ start, end, conn, filters });
  return {
    cancelled_orders: Number(rows.cancelled_orders || 0),
    refunded_orders: Number(rows.refunded_orders || 0),
    rto_orders: Number(rows.rto_orders || 0),
  };
}

async function getReturnsSnapshotPair(conn, currentRange, previousRange, filters = {}) {
  if (hasCityFilter(filters)) {
    return {
      current: {
        cancelled_orders: null,
        refunded_orders: null,
        rto_orders: null,
      },
      previous: {
        cancelled_orders: null,
        refunded_orders: null,
        rto_orders: null,
      },
    };
  }
  if (getUtmAggregateSource(filters, "daily")) {
    const [pair, rtoPair] = await Promise.all([
      queryUtmAggregatePair(
        conn,
        currentRange,
        previousRange,
        filters,
        { granularity: "daily" },
      ),
      computeReturnCountsPair(currentRange, previousRange, conn, filters),
    ]);
    return {
      current: {
        cancelled_orders: Number(pair?.current?.cancelled_orders || 0),
        refunded_orders: Number(pair?.current?.refunded_orders || 0),
        rto_orders: Number(rtoPair?.current?.rto_orders || 0),
      },
      previous: {
        cancelled_orders: Number(pair?.previous?.cancelled_orders || 0),
        refunded_orders: Number(pair?.previous?.refunded_orders || 0),
        rto_orders: Number(rtoPair?.previous?.rto_orders || 0),
      },
    };
  }
  const combinedStart =
    currentRange.start <= previousRange.start
      ? currentRange.start
      : previousRange.start;
  const combinedEnd =
    currentRange.end >= previousRange.end
      ? currentRange.end
      : previousRange.end;

  const rows = await conn.query(
    `
      SELECT
        COALESCE(SUM(CASE WHEN event_type = 'CANCEL' AND order_created_date >= ? AND order_created_date <= ? THEN 1 ELSE 0 END), 0) AS current_cancelled_orders,
        COALESCE(SUM(CASE WHEN event_type = 'REFUND' AND order_created_date >= ? AND order_created_date <= ? THEN 1 ELSE 0 END), 0) AS current_refunded_orders,
        COALESCE(SUM(CASE WHEN event_type = 'CANCEL (RTO)' AND order_created_date >= ? AND order_created_date <= ? THEN 1 ELSE 0 END), 0) AS current_rto_orders,
        COALESCE(SUM(CASE WHEN event_type = 'CANCEL' AND order_created_date >= ? AND order_created_date <= ? THEN 1 ELSE 0 END), 0) AS previous_cancelled_orders,
        COALESCE(SUM(CASE WHEN event_type = 'REFUND' AND order_created_date >= ? AND order_created_date <= ? THEN 1 ELSE 0 END), 0) AS previous_refunded_orders,
        COALESCE(SUM(CASE WHEN event_type = 'CANCEL (RTO)' AND order_created_date >= ? AND order_created_date <= ? THEN 1 ELSE 0 END), 0) AS previous_rto_orders
      FROM returns_fact
      WHERE order_created_date >= ? AND order_created_date <= ?
    `,
    {
      type: QueryTypes.SELECT,
      replacements: [
        currentRange.start,
        currentRange.end,
        currentRange.start,
        currentRange.end,
        currentRange.start,
        currentRange.end,
        previousRange.start,
        previousRange.end,
        previousRange.start,
        previousRange.end,
        previousRange.start,
        previousRange.end,
        combinedStart,
        combinedEnd,
      ],
    },
  );
  const row = rows?.[0] || {};
  return {
    current: {
      cancelled_orders: Number(row.current_cancelled_orders || 0),
      refunded_orders: Number(row.current_refunded_orders || 0),
      rto_orders: Number(row.current_rto_orders || 0),
    },
    previous: {
      cancelled_orders: Number(row.previous_cancelled_orders || 0),
      refunded_orders: Number(row.previous_refunded_orders || 0),
      rto_orders: Number(row.previous_rto_orders || 0),
    },
  };
}

function buildSnapshotPayload(metrics = {}, returnsObj = {}, source = "db") {
  const total_orders = Number(metrics.total_orders || 0);
  const total_sales = Number(metrics.total_sales || 0);
  const total_sessions = Number(metrics.total_sessions || 0);
  const total_atc_sessions = Number(metrics.total_atc_sessions || 0);
  const total_ci_events = Number(metrics.total_ci_events || 0);
  const rto_orders = Number(returnsObj.rto_orders || 0);
  const average_order_value = total_orders > 0 ? total_sales / total_orders : 0;
  const conversion_rate = total_sessions > 0 ? total_orders / total_sessions : 0;
  const rto_rate = total_orders > 0 ? rto_orders / total_orders : 0;

  return {
    total_orders,
    total_sales,
    total_sessions,
    total_atc_sessions,
    total_ci_events,
    average_order_value,
    conversion_rate,
    conversion_rate_percent: conversion_rate * 100,
    cancelled_orders: Number(returnsObj.cancelled_orders || 0),
    refunded_orders: Number(returnsObj.refunded_orders || 0),
    rto_orders,
    rto_rate,
    rto_rate_percent: rto_rate * 100,
    source,
  };
}

function buildDiscountSnapshotPayload(metrics = {}, source = "db") {
  const total_orders = Number(metrics.total_orders || 0);
  const total_sales = Number(metrics.total_sales || 0);
  return {
    total_orders,
    total_sales,
    total_sessions: null,
    total_atc_sessions: null,
    total_ci_events: null,
    average_order_value: total_orders > 0 ? total_sales / total_orders : 0,
    conversion_rate: null,
    conversion_rate_percent: null,
    cancelled_orders: null,
    refunded_orders: null,
    rto_orders: null,
    rto_rate: null,
    rto_rate_percent: null,
    source,
  };
}

function buildProductTypeSnapshotPayload(metrics = {}, source = "db") {
  const total_orders = Number(metrics.total_orders || 0);
  const total_sales = Number(metrics.total_sales || 0);
  const total_sessions = Number(metrics.total_sessions || 0);
  const total_atc_sessions = Number(metrics.total_atc_sessions || 0);
  const conversion_rate = total_sessions > 0 ? total_orders / total_sessions : 0;
  return {
    total_orders,
    total_sales,
    total_sessions,
    total_atc_sessions,
    total_ci_events: null,
    average_order_value: total_orders > 0 ? total_sales / total_orders : 0,
    conversion_rate,
    conversion_rate_percent: conversion_rate * 100,
    cancelled_orders: null,
    refunded_orders: null,
    rto_orders: null,
    rto_rate: null,
    rto_rate_percent: null,
    source,
  };
}

function buildCachedSnapshot(
  cachedData = {},
  returnsObj = {},
  source = "cache",
  totalCiEvents = 0,
) {
  return {
    total_orders: Number(cachedData.total_orders || 0),
    total_sales: Number(cachedData.total_sales || 0),
    total_sessions: Number(cachedData.total_sessions || 0),
    total_atc_sessions: Number(cachedData.total_atc_sessions || 0),
    total_ci_events: Number(totalCiEvents || 0),
    average_order_value: Number(cachedData.average_order_value || 0),
    conversion_rate: Number(cachedData.conversion_rate || 0) / 100,
    conversion_rate_percent: Number(cachedData.conversion_rate || 0),
    cancelled_orders: Number(returnsObj.cancelled_orders || 0),
    refunded_orders: Number(returnsObj.refunded_orders || 0),
    rto_orders: Number(returnsObj.rto_orders || 0),
    rto_rate:
      Number(cachedData.total_orders || 0) > 0
        ? Number(returnsObj.rto_orders || 0) / Number(cachedData.total_orders || 0)
        : 0,
    rto_rate_percent:
      Number(cachedData.total_orders || 0) > 0
        ? (Number(returnsObj.rto_orders || 0) / Number(cachedData.total_orders || 0)) * 100
        : 0,
    source,
  };
}

function emptyIntentAggregate() {
  return {
    high_intent_sessions: 0,
    medium_intent_sessions: 0,
    low_intent_sessions: 0,
    high_intent_percent: 0,
    medium_intent_percent: 0,
    low_intent_percent: 0,
  };
}

async function queryIntentSummaryPair(conn, currentRange, previousRange) {
  try {
    const rows = await conn.query(
      `
        SELECT
          COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN high_sessions ELSE 0 END), 0) AS current_high_sessions,
          COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN medium_sessions ELSE 0 END), 0) AS current_medium_sessions,
          COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN low_sessions ELSE 0 END), 0) AS current_low_sessions,
          COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN (high_intent_pct * total_sessions) ELSE 0 END), 0) AS current_high_pct_weighted,
          COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN (medium_intent_pct * total_sessions) ELSE 0 END), 0) AS current_medium_pct_weighted,
          COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN (low_intent_pct * total_sessions) ELSE 0 END), 0) AS current_low_pct_weighted,
          COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN total_sessions ELSE 0 END), 0) AS current_total_sessions,
          COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN high_sessions ELSE 0 END), 0) AS previous_high_sessions,
          COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN medium_sessions ELSE 0 END), 0) AS previous_medium_sessions,
          COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN low_sessions ELSE 0 END), 0) AS previous_low_sessions,
          COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN (high_intent_pct * total_sessions) ELSE 0 END), 0) AS previous_high_pct_weighted,
          COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN (medium_intent_pct * total_sessions) ELSE 0 END), 0) AS previous_medium_pct_weighted,
          COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN (low_intent_pct * total_sessions) ELSE 0 END), 0) AS previous_low_pct_weighted,
          COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN total_sessions ELSE 0 END), 0) AS previous_total_sessions
        FROM daily_user_intent_summary
        WHERE (date >= ? AND date <= ?) OR (date >= ? AND date <= ?)
      `,
      {
        type: QueryTypes.SELECT,
        replacements: [
          currentRange.start, currentRange.end,
          currentRange.start, currentRange.end,
          currentRange.start, currentRange.end,
          currentRange.start, currentRange.end,
          currentRange.start, currentRange.end,
          currentRange.start, currentRange.end,
          currentRange.start, currentRange.end,
          previousRange.start, previousRange.end,
          previousRange.start, previousRange.end,
          previousRange.start, previousRange.end,
          previousRange.start, previousRange.end,
          previousRange.start, previousRange.end,
          previousRange.start, previousRange.end,
          previousRange.start, previousRange.end,
          currentRange.start, currentRange.end,
          previousRange.start, previousRange.end,
        ],
      },
    );

    const row = rows?.[0] || {};
    const currentTotalSessions = Number(row.current_total_sessions || 0);
    const previousTotalSessions = Number(row.previous_total_sessions || 0);

    return {
      current: {
        high_intent_sessions: Number(row.current_high_sessions || 0),
        medium_intent_sessions: Number(row.current_medium_sessions || 0),
        low_intent_sessions: Number(row.current_low_sessions || 0),
        high_intent_percent:
          currentTotalSessions > 0
            ? Number(row.current_high_pct_weighted || 0) / currentTotalSessions
            : 0,
        medium_intent_percent:
          currentTotalSessions > 0
            ? Number(row.current_medium_pct_weighted || 0) / currentTotalSessions
            : 0,
        low_intent_percent:
          currentTotalSessions > 0
            ? Number(row.current_low_pct_weighted || 0) / currentTotalSessions
            : 0,
      },
      previous: {
        high_intent_sessions: Number(row.previous_high_sessions || 0),
        medium_intent_sessions: Number(row.previous_medium_sessions || 0),
        low_intent_sessions: Number(row.previous_low_sessions || 0),
        high_intent_percent:
          previousTotalSessions > 0
            ? Number(row.previous_high_pct_weighted || 0) / previousTotalSessions
            : 0,
        medium_intent_percent:
          previousTotalSessions > 0
            ? Number(row.previous_medium_pct_weighted || 0) / previousTotalSessions
            : 0,
        low_intent_percent:
          previousTotalSessions > 0
            ? Number(row.previous_low_pct_weighted || 0) / previousTotalSessions
            : 0,
      },
    };
  } catch (error) {
    console.error("[metrics-summary] intent summary query failed", {
      currentRange,
      previousRange,
      message: error?.message || error,
    });
    return {
      current: emptyIntentAggregate(),
      previous: emptyIntentAggregate(),
    };
  }
}

async function queryDailyIntentRows(conn, start, end) {
  try {
    const rows = await conn.query(
      `
        SELECT
          DATE_FORMAT(date, '%Y-%m-%d') AS date,
          COALESCE(SUM(high_intent_pct * total_sessions), 0) AS high_pct_weighted,
          COALESCE(SUM(medium_intent_pct * total_sessions), 0) AS medium_pct_weighted,
          COALESCE(SUM(low_intent_pct * total_sessions), 0) AS low_pct_weighted,
          COALESCE(SUM(total_sessions), 0) AS total_sessions,
          COALESCE(SUM(high_sessions), 0) AS high_sessions,
          COALESCE(SUM(medium_sessions), 0) AS medium_sessions,
          COALESCE(SUM(low_sessions), 0) AS low_sessions
        FROM daily_user_intent_summary
        WHERE date >= ? AND date <= ?
        GROUP BY date
        ORDER BY date ASC
      `,
      {
        type: QueryTypes.SELECT,
        replacements: [start, end],
      },
    );
    return (Array.isArray(rows) ? rows : []).map((row) => {
      const totalSessions = Number(row.total_sessions || 0);
      return {
        date: String(row.date),
        high_intent_pct:
          totalSessions > 0 ? Number(row.high_pct_weighted || 0) / totalSessions : 0,
        medium_intent_pct:
          totalSessions > 0 ? Number(row.medium_pct_weighted || 0) / totalSessions : 0,
        low_intent_pct:
          totalSessions > 0 ? Number(row.low_pct_weighted || 0) / totalSessions : 0,
        high_intent_sessions: Number(row.high_sessions || 0),
        medium_intent_sessions: Number(row.medium_sessions || 0),
        low_intent_sessions: Number(row.low_sessions || 0),
      };
    });
  } catch (error) {
    console.error("[metrics-summary] daily intent rows query failed", {
      start,
      end,
      message: error?.message || error,
    });
    return [];
  }
}

function buildSummaryMetric(currentValue, previousValue, deltaCurrent = currentValue, deltaPrevious = previousValue) {
  const diff = Number(deltaCurrent || 0) - Number(deltaPrevious || 0);
  const pct = computePercentDelta(Number(deltaCurrent || 0), Number(deltaPrevious || 0));
  return {
    value: Number(currentValue || 0),
    previous: Number(previousValue || 0),
    diff,
    diff_pct: pct.diff_pct,
    direction: pct.direction,
  };
}

function buildUnavailableSummaryMetric() {
  return {
    value: null,
    previous: null,
    diff: null,
    diff_pct: null,
    direction: "unavailable",
    unavailable: true,
  };
}

function computeRatePercent(numerator, denominator) {
  const den = Number(denominator || 0);
  return den > 0 ? (Number(numerator || 0) / den) * 100 : 0;
}

async function getRowTwoComparisonSnapshots({
  conn,
  currentRange,
  previousRange,
  filters = {},
  cutoffCtx,
}) {
  if (!(cutoffCtx?.includesToday || cutoffCtx?.currentRangeIncludesToday)) {
    return null;
  }

  const {
    currentCutoffHour,
    currentOrderCutoffTime,
    previousSessionCutoffHour,
    previousOrderCutoffTime,
  } = buildRowTwoComparisonCutoffs(cutoffCtx);

  if (getUtmAggregateSource(filters, "hourly")) {
    const [currentTotals, previousTotals] = await Promise.all([
      queryUtmAggregateTotals(conn, currentRange.start, currentRange.end, filters, {
        granularity: "hourly",
        cutoffHour: currentCutoffHour,
      }),
      queryUtmAggregateTotals(conn, previousRange.start, previousRange.end, filters, {
        granularity: "hourly",
        cutoffHour: previousSessionCutoffHour,
      }),
    ]);

    const currentTotalOrders = Number(currentTotals?.total_orders || 0);
    const currentTotalSessions = Number(currentTotals?.total_sessions || 0);
    const currentTotalAtcSessions = Number(currentTotals?.total_atc_sessions || 0);
    const previousTotalOrders = Number(previousTotals?.total_orders || 0);
    const previousTotalSessions = Number(previousTotals?.total_sessions || 0);
    const previousTotalAtcSessions = Number(previousTotals?.total_atc_sessions || 0);

    return {
      current: {
        total_orders: currentTotalOrders,
        total_sessions: currentTotalSessions,
        total_atc_sessions: currentTotalAtcSessions,
        conversion_rate_percent:
          currentTotalSessions > 0
            ? (currentTotalOrders / currentTotalSessions) * 100
            : 0,
      },
      previous: {
        total_orders: previousTotalOrders,
        total_sessions: previousTotalSessions,
        total_atc_sessions: previousTotalAtcSessions,
        conversion_rate_percent:
          previousTotalSessions > 0
            ? (previousTotalOrders / previousTotalSessions) * 100
            : 0,
      },
    };
  }

  if (hasCityFilter(filters)) {
    const [currentOrders, currentSessions, previousOrders, previousSessions] =
      await Promise.all([
        queryCityOrderSalesTotals(
          conn,
          currentRange.start,
          currentRange.end,
          filters,
          currentCutoffHour,
        ),
        queryCitySessionTotals(
          conn,
          currentRange.start,
          currentRange.end,
          filters,
          currentCutoffHour,
        ),
        queryCityOrderSalesTotals(
          conn,
          previousRange.start,
          previousRange.end,
          filters,
          previousSessionCutoffHour,
        ),
        queryCitySessionTotals(
          conn,
          previousRange.start,
          previousRange.end,
          filters,
          previousSessionCutoffHour,
        ),
      ]);

    const currentTotalOrders = Number(currentOrders?.total_orders || 0);
    const currentTotalSessions = Number(currentSessions?.total_sessions || 0);
    const currentTotalAtcSessions = Number(
      currentSessions?.total_atc_sessions || 0,
    );
    const previousTotalOrders = Number(previousOrders?.total_orders || 0);
    const previousTotalSessions = Number(previousSessions?.total_sessions || 0);
    const previousTotalAtcSessions = Number(
      previousSessions?.total_atc_sessions || 0,
    );

    return {
      current: {
        total_orders: currentTotalOrders,
        total_sessions: currentTotalSessions,
        total_atc_sessions: currentTotalAtcSessions,
        conversion_rate_percent:
          currentTotalSessions > 0
            ? (currentTotalOrders / currentTotalSessions) * 100
            : 0,
      },
      previous: {
        total_orders: previousTotalOrders,
        total_sessions: previousTotalSessions,
        total_atc_sessions: previousTotalAtcSessions,
        conversion_rate_percent:
          previousTotalSessions > 0
            ? (previousTotalOrders / previousTotalSessions) * 100
            : 0,
      },
    };
  }

  const [currentOrders, currentSessions, previousOrders, previousSessions] =
    await Promise.all([
      queryOrderSalesTotals(
        conn,
        currentRange.start,
        currentRange.end,
        filters,
        currentOrderCutoffTime,
      ),
      queryCurrentRowTwoSessionTotals(
        conn,
        currentRange.start,
        currentRange.end,
        filters,
        currentCutoffHour,
      ),
      queryOrderSalesTotals(
        conn,
        previousRange.start,
        previousRange.end,
        filters,
        previousOrderCutoffTime,
      ),
      queryPreviousRowTwoSessionTotals(
        conn,
        previousRange.start,
        previousRange.end,
        filters,
        previousSessionCutoffHour,
      ),
    ]);

  const currentTotalOrders = Number(currentOrders?.total_orders || 0);
  const currentTotalSessions = Number(currentSessions?.total_sessions || 0);
  const currentTotalAtcSessions = Number(currentSessions?.total_atc_sessions || 0);
  const previousTotalOrders = Number(previousOrders?.total_orders || 0);
  const previousTotalSessions = Number(previousSessions?.total_sessions || 0);
  const previousTotalAtcSessions = Number(previousSessions?.total_atc_sessions || 0);

  return {
    current: {
      total_orders: currentTotalOrders,
      total_sessions: currentTotalSessions,
      total_atc_sessions: currentTotalAtcSessions,
      conversion_rate_percent:
        currentTotalSessions > 0
          ? (currentTotalOrders / currentTotalSessions) * 100
          : 0,
    },
    previous: {
      total_orders: previousTotalOrders,
      total_sessions: previousTotalSessions,
      total_atc_sessions: previousTotalAtcSessions,
      conversion_rate_percent:
        previousTotalSessions > 0
          ? (previousTotalOrders / previousTotalSessions) * 100
          : 0,
    },
  };
}

function getComparableRange(start, end, compareStart, compareEnd) {
  return resolveCompareRange(start, end, compareStart, compareEnd);
}

function isCacheEligible(range, filters, cutoffTime) {
  return !!range.start &&
    !!range.end &&
    range.start === range.end &&
    !hasAnyFilters(filters) &&
    !cutoffTime;
}

function monthBucket(dateStr) {
  return `${dateStr.slice(0, 7)}-01`;
}

function buildSeriesBuckets(start, end) {
  const list = [];
  for (let ts = parseIsoDate(start).getTime(); ts <= parseIsoDate(end).getTime(); ts += DAY_MS) {
    list.push(formatIsoDate(new Date(ts)));
  }
  return list;
}

function buildMetricShape(metrics) {
  const sessions = Number(metrics.sessions || 0);
  const orders = Number(metrics.orders || 0);
  const atc = Number(metrics.atc || 0);
  const ciEvents = Number(metrics.ci_events || 0);
  const sales = Number(metrics.sales || 0);
  const cvrRatio = sessions > 0 ? orders / sessions : 0;
  return {
    sales,
    orders,
    sessions,
    adjusted_sessions: sessions,
    raw_sessions: sessions,
    atc,
    ci_events: ciEvents,
    cvr_ratio: cvrRatio,
    cvr_percent: cvrRatio * 100,
    high_intent_pct: Number(metrics.high_intent_pct || 0),
    medium_intent_pct: Number(metrics.medium_intent_pct || 0),
    low_intent_pct: Number(metrics.low_intent_pct || 0),
    high_intent_sessions: Number(metrics.high_intent_sessions || 0),
    medium_intent_sessions: Number(metrics.medium_intent_sessions || 0),
    low_intent_sessions: Number(metrics.low_intent_sessions || 0),
  };
}

async function fetchHourlyRows(conn, start, end, filters = {}, cutoffHour = 23, brandKey = null) {
  const hasProduct = !!filters.product_id;
  const hasDevice = !!filters.device_type;
  const hasSnapshot = hasSnapshotFilters(filters);
  const hasSalesChannel = !!filters.sales_channel;
  const hasCity = hasCityFilter(filters);

  if (getDiscountAggregateSource(filters, "hourly")) {
    return queryDiscountAggregateRows(conn, start, end, filters, {
      granularity: "hourly",
      cutoffHour,
    });
  }

  if (getUtmAggregateSource(filters, "hourly")) {
    return queryUtmAggregateRows(conn, start, end, filters, {
      granularity: "hourly",
      cutoffHour,
    });
  }

  if (hasCity) {
    return queryCityRows(conn, start, end, filters, "hourly", cutoffHour);
  }

  if (!hasProduct && !hasDevice && !hasSnapshot && !hasSalesChannel) {
    const sql = `
      SELECT
        DATE_FORMAT(hws.date, '%Y-%m-%d') AS date,
        hws.hour,
        hws.total_sales AS sales,
        hws.number_of_orders AS orders,
        COALESCE(hws.adjusted_number_of_sessions, hws.number_of_sessions) AS sessions,
        hws.number_of_atc_sessions AS atc,
        COALESCE(hsss.ci_events, 0) AS ci_events
      FROM hour_wise_sales hws
      LEFT JOIN hourly_sessions_summary_shopify hsss
        ON hsss.date = hws.date AND hsss.hour = hws.hour
      WHERE hws.date >= ? AND hws.date <= ? AND hws.hour <= ?
      ORDER BY hws.date ASC, hws.hour ASC
    `;
    return conn.query(sql, {
      type: QueryTypes.SELECT,
      replacements: [start, end, cutoffHour],
    });
  }

  let orderSql = `
    SELECT
      created_date AS date,
      HOUR(created_time) AS hour,
      COUNT(DISTINCT order_name) AS orders,
      ${filters.product_id ? `COALESCE(SUM((line_item_price - COALESCE(discount_amount_per_line_item, 0)) * line_item_quantity), 0)` : `COALESCE(SUM(total_price), 0)`} AS sales
    FROM shopify_orders
    WHERE created_date >= ? AND created_date <= ? AND HOUR(created_time) <= ?
  `;
  const orderReplacements = [start, end, cutoffHour];
  orderSql = appendUtmWhere(orderSql, orderReplacements, filters, true);
  orderSql = appendProductFilter(orderSql, orderReplacements, filters.product_id);
  orderSql += ` GROUP BY created_date, HOUR(created_time) ORDER BY created_date ASC, HOUR(created_time) ASC`;

  let sessionRowsPromise;
  if (hasProduct || hasSnapshot) {
    let sessionSql = `
      SELECT
        DATE_FORMAT(date, '%Y-%m-%d') AS date,
        hour,
        COALESCE(SUM(sessions), 0) AS sessions,
        COALESCE(SUM(sessions_with_cart_additions), 0) AS atc
      FROM hourly_product_sessions
      WHERE date >= ? AND date <= ? AND hour <= ?
    `;
    const sessionReplacements = [start, end, cutoffHour];
    sessionSql = appendUtmWhere(
      sessionSql,
      sessionReplacements,
      buildSnapshotSessionFilters(filters),
      true,
    );
    sessionSql = appendProductFilter(sessionSql, sessionReplacements, filters.product_id);
    sessionSql += ` GROUP BY date, hour ORDER BY date ASC, hour ASC`;
    sessionRowsPromise = conn.query(sessionSql, {
      type: QueryTypes.SELECT,
      replacements: sessionReplacements,
    });
  } else if (hasDevice) {
    const { sessionExpr, atcExpr } = buildDeviceExpressions(filters.device_type);
    const sessionSql = `
      SELECT
        DATE_FORMAT(date, '%Y-%m-%d') AS date,
        hour,
        (${sessionExpr}) AS sessions,
        (${atcExpr}) AS atc
      FROM hourly_sessions_summary_shopify
      WHERE date >= ? AND date <= ? AND hour <= ?
      ORDER BY date ASC, hour ASC
    `;
    sessionRowsPromise = conn.query(sessionSql, {
      type: QueryTypes.SELECT,
      replacements: [start, end, cutoffHour],
    });
  } else {
    const sessionSql = `
      SELECT
        DATE_FORMAT(date, '%Y-%m-%d') AS date,
        hour,
        COALESCE(adjusted_number_of_sessions, number_of_sessions) AS sessions,
        number_of_atc_sessions AS atc
      FROM hourly_sessions_summary_shopify
      WHERE date >= ? AND date <= ? AND hour <= ?
      ORDER BY date ASC, hour ASC
    `;
    sessionRowsPromise = conn.query(sessionSql, {
      type: QueryTypes.SELECT,
      replacements: [start, end, cutoffHour],
    });
  }

  const [orderRows, sessionRows, ciRows] = await Promise.all([
    conn.query(orderSql, {
      type: QueryTypes.SELECT,
      replacements: orderReplacements,
    }),
    sessionRowsPromise,
    queryCheckoutInitiatedRows(conn, start, end, "hourly", cutoffHour, brandKey),
  ]);

  const byKey = new Map();
  for (const row of orderRows) {
    const key = `${row.date}#${row.hour}`;
    byKey.set(key, {
      date: String(row.date),
      hour: Number(row.hour || 0),
      sales: Number(row.sales || 0),
      orders: Number(row.orders || 0),
      sessions: 0,
      atc: 0,
      ci_events: 0,
    });
  }
  for (const row of sessionRows) {
    const key = `${row.date}#${row.hour}`;
    const existing = byKey.get(key) || {
      date: String(row.date),
      hour: Number(row.hour || 0),
      sales: 0,
      orders: 0,
      sessions: 0,
      atc: 0,
      ci_events: 0,
    };
    existing.sessions += Number(row.sessions || 0);
    existing.atc += Number(row.atc || 0);
    byKey.set(key, existing);
  }
  for (const row of ciRows) {
    const key = `${row.date}#${row.hour}`;
    const existing = byKey.get(key) || {
      date: String(row.date),
      hour: Number(row.hour || 0),
      sales: 0,
      orders: 0,
      sessions: 0,
      atc: 0,
      ci_events: 0,
    };
    existing.ci_events += Number(row.ci_events || 0);
    byKey.set(key, existing);
  }

  return Array.from(byKey.values()).sort((a, b) => {
    if (a.date === b.date) return a.hour - b.hour;
    return a.date.localeCompare(b.date);
  });
}

async function fetchDailyRows(conn, start, end, filters = {}, brandKey = null) {
  const hasProduct = !!filters.product_id;
  const hasDevice = !!filters.device_type;
  const hasSnapshot = hasSnapshotFilters(filters);
  const hasSalesChannel = !!filters.sales_channel;
  const hasCity = hasCityFilter(filters);

  if (getDiscountAggregateSource(filters, "daily")) {
    return queryDiscountAggregateRows(conn, start, end, filters, {
      granularity: "daily",
    });
  }

  if (getProductTypeAggregateSource(filters, "daily")) {
    return queryProductTypeAggregateRows(conn, start, end, filters, {
      granularity: "daily",
    });
  }

  if (getUtmAggregateSource(filters, "daily")) {
    return queryUtmAggregateRows(conn, start, end, filters, {
      granularity: "daily",
    });
  }

  if (hasCity) {
    return queryCityRows(conn, start, end, filters, "daily");
  }

  if (!hasProduct && !hasDevice && !hasSnapshot && !hasSalesChannel) {
    const salesSql = `
      SELECT
        DATE_FORMAT(date, '%Y-%m-%d') AS date,
        COALESCE(SUM(total_sales), 0) AS sales,
        COALESCE(SUM(number_of_orders), 0) AS orders
      FROM hour_wise_sales
      WHERE date >= ? AND date <= ?
      GROUP BY date
      ORDER BY date ASC
    `;
    const sessionSql = `
      SELECT
        DATE_FORMAT(date, '%Y-%m-%d') AS date,
        COALESCE(SUM(COALESCE(adjusted_total_sessions, total_sessions)), 0) AS sessions,
        COALESCE(SUM(total_atc_sessions), 0) AS atc
      FROM overall_summary
      WHERE date >= ? AND date <= ?
      GROUP BY date
      ORDER BY date ASC
    `;
    const [salesRows, sessionRows, ciRows, intentRows] = await Promise.all([
      conn.query(salesSql, {
        type: QueryTypes.SELECT,
        replacements: [start, end],
      }),
      conn.query(sessionSql, {
        type: QueryTypes.SELECT,
        replacements: [start, end],
      }),
      queryCheckoutInitiatedRows(conn, start, end, "daily", null, brandKey),
      queryDailyIntentRows(conn, start, end),
    ]);
    const byDate = new Map();
    const emptyRow = () => ({
      sales: 0,
      orders: 0,
      sessions: 0,
      atc: 0,
      ci_events: 0,
      high_intent_pct: 0,
      medium_intent_pct: 0,
      low_intent_pct: 0,
      high_intent_sessions: 0,
      medium_intent_sessions: 0,
      low_intent_sessions: 0,
    });
    for (const row of salesRows) {
      byDate.set(String(row.date), {
        date: String(row.date),
        ...emptyRow(),
        sales: Number(row.sales || 0),
        orders: Number(row.orders || 0),
      });
    }
    for (const row of sessionRows) {
      const existing = byDate.get(String(row.date)) || {
        date: String(row.date),
        ...emptyRow(),
      };
      existing.sessions += Number(row.sessions || 0);
      existing.atc += Number(row.atc || 0);
      byDate.set(String(row.date), existing);
    }
    for (const row of ciRows) {
      const existing = byDate.get(String(row.date)) || {
        date: String(row.date),
        ...emptyRow(),
      };
      existing.ci_events += Number(row.ci_events || 0);
      byDate.set(String(row.date), existing);
    }
    for (const row of intentRows) {
      const existing = byDate.get(String(row.date)) || {
        date: String(row.date),
        ...emptyRow(),
      };
      existing.high_intent_pct = row.high_intent_pct;
      existing.medium_intent_pct = row.medium_intent_pct;
      existing.low_intent_pct = row.low_intent_pct;
      existing.high_intent_sessions = row.high_intent_sessions;
      existing.medium_intent_sessions = row.medium_intent_sessions;
      existing.low_intent_sessions = row.low_intent_sessions;
      byDate.set(String(row.date), existing);
    }
    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  let orderSql = `
    SELECT
      created_date AS date,
      COUNT(DISTINCT order_name) AS orders,
      ${filters.product_id ? `COALESCE(SUM((line_item_price - COALESCE(discount_amount_per_line_item, 0)) * line_item_quantity), 0)` : `COALESCE(SUM(total_price), 0)`} AS sales
    FROM shopify_orders
    WHERE created_date >= ? AND created_date <= ?
  `;
  const orderReplacements = [start, end];
  orderSql = appendUtmWhere(orderSql, orderReplacements, filters, true);
  orderSql = appendProductFilter(orderSql, orderReplacements, filters.product_id);
  orderSql += ` GROUP BY created_date ORDER BY created_date ASC`;

  let sessionRowsPromise;
  if (hasProduct) {
    let sessionSql = `
      SELECT
        DATE_FORMAT(date, '%Y-%m-%d') AS date,
        COALESCE(SUM(sessions), 0) AS sessions,
        COALESCE(SUM(sessions_with_cart_additions), 0) AS atc
      FROM mv_product_sessions_by_path_daily
      WHERE date >= ? AND date <= ?
    `;
    const sessionReplacements = [start, end];
    sessionSql = appendProductFilter(sessionSql, sessionReplacements, filters.product_id);
    sessionSql += ` GROUP BY date ORDER BY date ASC`;
    sessionRowsPromise = conn.query(sessionSql, {
      type: QueryTypes.SELECT,
      replacements: sessionReplacements,
    });
  } else if (hasDevice) {
    const { sessionExpr, atcExpr } = buildDeviceExpressions(filters.device_type);
    const sessionRows = await conn.query(
      `
        SELECT
          DATE_FORMAT(date, '%Y-%m-%d') AS date,
          COALESCE(SUM(${sessionExpr}), 0) AS sessions,
          COALESCE(SUM(${atcExpr}), 0) AS atc
        FROM hourly_sessions_summary_shopify
        WHERE date >= ? AND date <= ?
        GROUP BY date
        ORDER BY date ASC
      `,
      {
        type: QueryTypes.SELECT,
        replacements: [start, end],
      },
    );
    sessionRowsPromise = Promise.resolve(sessionRows);
  } else if (hasSnapshot) {
    let sessionSql = `
      SELECT
        DATE_FORMAT(date, '%Y-%m-%d') AS date,
        COALESCE(SUM(sessions), 0) AS sessions,
        COALESCE(SUM(sessions_with_cart_additions), 0) AS atc
      FROM product_sessions_snapshot
      WHERE date >= ? AND date <= ?
    `;
    const sessionReplacements = [start, end];
    sessionSql = appendUtmWhere(sessionSql, sessionReplacements, buildSnapshotSessionFilters(filters), true);
    sessionSql += ` GROUP BY date ORDER BY date ASC`;
    sessionRowsPromise = conn.query(sessionSql, {
      type: QueryTypes.SELECT,
      replacements: sessionReplacements,
    });
  } else {
    const sessionSql = `
      SELECT
        DATE_FORMAT(date, '%Y-%m-%d') AS date,
        COALESCE(SUM(COALESCE(adjusted_total_sessions, total_sessions)), 0) AS sessions,
        COALESCE(SUM(total_atc_sessions), 0) AS atc
      FROM overall_summary
      WHERE date >= ? AND date <= ?
      GROUP BY date
      ORDER BY date ASC
    `;
    sessionRowsPromise = conn.query(sessionSql, {
      type: QueryTypes.SELECT,
      replacements: [start, end],
    });
  }

  const [orderRows, sessionRows, ciRows] = await Promise.all([
    conn.query(orderSql, {
      type: QueryTypes.SELECT,
      replacements: orderReplacements,
    }),
    sessionRowsPromise,
    queryCheckoutInitiatedRows(conn, start, end, "daily", null, brandKey),
  ]);
  const byDate = new Map();
  for (const row of orderRows) {
    byDate.set(String(row.date), {
      date: String(row.date),
      sales: Number(row.sales || 0),
      orders: Number(row.orders || 0),
      sessions: 0,
      atc: 0,
      ci_events: 0,
    });
  }
  for (const row of sessionRows) {
    const existing = byDate.get(String(row.date)) || {
      date: String(row.date),
      sales: 0,
      orders: 0,
      sessions: 0,
      atc: 0,
      ci_events: 0,
    };
    existing.sessions += Number(row.sessions || 0);
    existing.atc += Number(row.atc || 0);
    byDate.set(String(row.date), existing);
  }
  for (const row of ciRows) {
    const existing = byDate.get(String(row.date)) || {
      date: String(row.date),
      sales: 0,
      orders: 0,
      sessions: 0,
      atc: 0,
      ci_events: 0,
    };
    existing.ci_events += Number(row.ci_events || 0);
    byDate.set(String(row.date), existing);
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchMonthlyRows(conn, start, end, filters = {}, brandKey = null) {
  const dailyRows = await fetchDailyRows(conn, start, end, filters, brandKey);
  const byMonth = new Map();
  for (const row of dailyRows) {
    const bucket = monthBucket(row.date);
    const existing = byMonth.get(bucket) || {
      startDate: row.date,
      endDate: row.date,
      sales: 0,
      orders: 0,
      sessions: 0,
      atc: 0,
      ci_events: 0,
    };
    existing.startDate = row.date < existing.startDate ? row.date : existing.startDate;
    existing.endDate = row.date > existing.endDate ? row.date : existing.endDate;
    existing.sales += Number(row.sales || 0);
    existing.orders += Number(row.orders || 0);
    existing.sessions += Number(row.sessions || 0);
    existing.atc += Number(row.atc || 0);
    existing.ci_events += Number(row.ci_events || 0);
    byMonth.set(bucket, existing);
  }

  return Array.from(byMonth.entries())
    .map(([date, metrics]) => ({
      date,
      startDate: metrics.startDate,
      endDate: metrics.endDate,
      metrics: buildMetricShape(metrics),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function buildHourlyPoints(rows, start, end, aggregate = "", timezone = DEFAULT_TIMEZONE) {
  const resolvedTimezone = normalizeTimezone(timezone);
  const tzCtx = getTimezoneContext(new Date(), resolvedTimezone);
  const alignHour = end === tzCtx.today ? tzCtx.currentHour : 23;
  const rowMap = new Map(rows.map((row) => [`${row.date}#${row.hour}`, row]));
  const buckets = [];
  for (const day of buildSeriesBuckets(start, end)) {
    const maxHour = day === end ? alignHour : 23;
    for (let hour = 0; hour <= maxHour; hour += 1) {
      buckets.push({ date: day, hour });
    }
  }

  if (aggregate === "avg-by-hour" || aggregate === "avg-hour" || aggregate === "avg") {
    const acc = Array.from({ length: 24 }, () => ({
      count: 0,
      sales: 0,
      orders: 0,
      sessions: 0,
      atc: 0,
      ci_events: 0,
    }));
    for (const bucket of buckets) {
      const row = rowMap.get(`${bucket.date}#${bucket.hour}`) || {};
      const target = acc[bucket.hour];
      target.count += 1;
      target.sales += Number(row.sales || 0);
      target.orders += Number(row.orders || 0);
      target.sessions += Number(row.sessions || 0);
      target.atc += Number(row.atc || 0);
      target.ci_events += Number(row.ci_events || 0);
    }
    return acc.slice(0, alignHour + 1).map((metrics, hour) => ({
      hour,
      label: `${pad2(hour)}:00`,
      metrics: buildMetricShape({
        sales: metrics.count ? metrics.sales / metrics.count : 0,
        orders: metrics.count ? metrics.orders / metrics.count : 0,
        sessions: metrics.count ? metrics.sessions / metrics.count : 0,
        atc: metrics.count ? metrics.atc / metrics.count : 0,
        ci_events: metrics.count ? metrics.ci_events / metrics.count : 0,
      }),
    }));
  }

  return buckets.map((bucket) => ({
    date: bucket.date,
    hour: bucket.hour,
    label: `${bucket.date.slice(8, 10)} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(bucket.date.slice(5, 7)) - 1]} ${pad2(bucket.hour)}:00`,
    metrics: buildMetricShape(rowMap.get(`${bucket.date}#${bucket.hour}`) || {}),
  }));
}

function buildDailyPoints(rows, start, end) {
  const rowMap = new Map(rows.map((row) => [row.date, row]));
  return buildSeriesBuckets(start, end).map((date) => ({
    date,
    metrics: buildMetricShape(rowMap.get(date) || {}),
  }));
}

function buildMetricsSnapshotService(deps = {}) {
  const { fetchCachedMetricsBatch, getDatePresetsCache } = deps;
  const now = deps.now || (() => new Date());

  async function getSnapshot({ conn, range, filters = {}, cutoffTime = null, cachedData = null, brandKey = null }) {
    if (!conn) throw new Error("Database connection unavailable");
    const { start, end } = range;

    if (cachedData && isCacheEligible(range, filters, cutoffTime)) {
      const [returnsObj, totalCiEvents] = await Promise.all([
        getReturnsSnapshot(conn, start, end, filters),
        queryCheckoutInitiatedTotals(conn, start, end, null, brandKey),
      ]);
      return buildCachedSnapshot(
        cachedData,
        returnsObj,
        "cache+db_returns",
        totalCiEvents,
      );
    }

    if (getDiscountAggregateSource(filters, cutoffTime ? "hourly" : "daily")) {
      const cutoffHour = cutoffTime ? parseHourFromCutoff(cutoffTime) : null;
      const totals = await queryDiscountAggregateTotals(conn, start, end, filters, {
        granularity: cutoffTime ? "hourly" : "daily",
        cutoffHour,
      });
      return buildDiscountSnapshotPayload(totals, "db");
    }

    // mv_product_type_funnel_daily has no hourly grain — a same-day
    // cutoff-hour comparison isn't possible, so always use the full-day
    // total rather than silently falling through to unfiltered data.
    if (getProductTypeAggregateSource(filters, "daily")) {
      const totals = await queryProductTypeAggregateTotals(conn, start, end, filters, {
        granularity: "daily",
      });
      return buildProductTypeSnapshotPayload(totals, "db");
    }

    if (getUtmAggregateSource(filters, cutoffTime ? "hourly" : "daily")) {
      const cutoffHour = cutoffTime ? parseHourFromCutoff(cutoffTime) : null;
      const totals = await queryUtmAggregateTotals(conn, start, end, filters, {
        granularity: cutoffTime ? "hourly" : "daily",
        cutoffHour,
      });
      return buildSnapshotPayload(
        totals,
        {
          cancelled_orders: totals.cancelled_orders,
          refunded_orders: totals.refunded_orders,
        },
        "db",
      );
    }

    let metrics;
    if (!cutoffTime && !hasAnyFilters(filters)) {
      metrics = await queryOverallSummaryTotals(conn, start, end, brandKey);
    } else {
      const cutoffHour = cutoffTime ? parseHourFromCutoff(cutoffTime) : 23;
      const [orderSales, sessionTotals, returnsObj] = await Promise.all([
        hasCityFilter(filters)
          ? queryCityOrderSalesTotals(conn, start, end, filters, cutoffHour)
          : queryOrderSalesTotals(conn, start, end, filters, cutoffTime),
        (() => {
          if (hasCityFilter(filters)) {
            return queryCitySessionTotals(conn, start, end, filters, cutoffHour);
          }
          if (cutoffTime) {
            if (filters.product_id || hasSnapshotFilters(filters)) {
              return queryHourlyProductSessionTotals(
                conn,
                start,
                end,
                cutoffHour,
                filters,
              );
            }
            if (filters.device_type) {
              return queryDeviceHourlyTotals(conn, start, end, filters, cutoffHour);
            }
            return queryHourlySessionTotals(conn, start, end, cutoffHour);
          }
          if (filters.product_id) {
            return queryProductDailySessionTotals(conn, start, end, filters);
          }
          if (filters.device_type) {
            return queryDeviceHourlyTotals(conn, start, end, filters, 23);
          }
          if (hasSnapshotFilters(filters)) {
            return querySnapshotSessionTotals(conn, start, end, filters);
          }
          return queryOverallSummaryTotals(conn, start, end, brandKey);
        })(),
        getReturnsSnapshot(conn, start, end, filters),
      ]);
      return buildSnapshotPayload(
        {
          total_orders: orderSales.total_orders,
          total_sales: orderSales.total_sales,
          total_sessions: sessionTotals.total_sessions,
          total_atc_sessions: sessionTotals.total_atc_sessions,
        },
        returnsObj,
        "db",
      );
    }

    const returnsObj = await getReturnsSnapshot(conn, start, end, filters);
    return buildSnapshotPayload(metrics, returnsObj, "db");
  }

  async function getSnapshotPair({
    conn,
    brandKey,
    currentRange,
    previousRange,
    filters = {},
    cutoffTime = null,
    currentCutoffHour = null,
    previousCutoffHour = null,
  }) {
    let cachedCurrent = null;
    let cachedPrevious = null;
    if (
      fetchCachedMetricsBatch &&
      isCacheEligible(currentRange, filters, cutoffTime) &&
      isCacheEligible(previousRange, filters, cutoffTime)
    ) {
      const [currentCached, previousCached] = await fetchCachedMetricsBatch(
        brandKey,
        [currentRange.start, previousRange.start],
      );
      cachedCurrent = currentCached;
      cachedPrevious = previousCached;
    }

    if (
      !cachedCurrent &&
      !cachedPrevious &&
      getDiscountAggregateSource(
        filters,
        cutoffTime !== null ||
          currentCutoffHour !== null ||
          previousCutoffHour !== null
          ? "hourly"
          : "daily",
      )
    ) {
      const resolvedCurrentCutoffHour =
        currentCutoffHour !== null && currentCutoffHour !== undefined
          ? currentCutoffHour
          : cutoffTime
            ? parseHourFromCutoff(cutoffTime)
            : null;
      const resolvedPreviousCutoffHour =
        previousCutoffHour !== null && previousCutoffHour !== undefined
          ? previousCutoffHour
          : resolvedCurrentCutoffHour;
      const pair = await queryDiscountAggregatePair(
        conn,
        currentRange,
        previousRange,
        filters,
        {
          granularity:
            cutoffTime !== null ||
            resolvedCurrentCutoffHour !== null ||
            resolvedPreviousCutoffHour !== null
              ? "hourly"
              : "daily",
          currentCutoffHour: resolvedCurrentCutoffHour,
          previousCutoffHour: resolvedPreviousCutoffHour,
        },
      );

      return {
        current: buildDiscountSnapshotPayload(pair.current, "db"),
        previous: buildDiscountSnapshotPayload(pair.previous, "db"),
      };
    }

    // mv_product_type_funnel_daily has no hourly grain — always use the
    // full-day daily source here too, even when a cutoff-hour comparison
    // was requested, rather than falling through to unfiltered data.
    if (
      !cachedCurrent &&
      !cachedPrevious &&
      getProductTypeAggregateSource(filters, "daily")
    ) {
      const pair = await queryProductTypeAggregatePair(conn, currentRange, previousRange, filters, {
        granularity: "daily",
      });

      return {
        current: buildProductTypeSnapshotPayload(pair.current, "db"),
        previous: buildProductTypeSnapshotPayload(pair.previous, "db"),
      };
    }

    if (
      !cachedCurrent &&
      !cachedPrevious &&
      getUtmAggregateSource(
        filters,
        cutoffTime !== null ||
          currentCutoffHour !== null ||
          previousCutoffHour !== null
          ? "hourly"
          : "daily",
      )
    ) {
      const resolvedCurrentCutoffHour =
        currentCutoffHour !== null && currentCutoffHour !== undefined
          ? currentCutoffHour
          : cutoffTime
            ? parseHourFromCutoff(cutoffTime)
            : null;
      const resolvedPreviousCutoffHour =
        previousCutoffHour !== null && previousCutoffHour !== undefined
          ? previousCutoffHour
          : resolvedCurrentCutoffHour;
      const pair = await queryUtmAggregatePair(
        conn,
        currentRange,
        previousRange,
        filters,
        {
          granularity:
            cutoffTime !== null ||
            resolvedCurrentCutoffHour !== null ||
            resolvedPreviousCutoffHour !== null
              ? "hourly"
              : "daily",
          currentCutoffHour: resolvedCurrentCutoffHour,
          previousCutoffHour: resolvedPreviousCutoffHour,
        },
      );

      return {
        current: buildSnapshotPayload(
          pair.current,
          {
            cancelled_orders: pair.current.cancelled_orders,
            refunded_orders: pair.current.refunded_orders,
          },
          "db",
        ),
        previous: buildSnapshotPayload(
          pair.previous,
          {
            cancelled_orders: pair.previous.cancelled_orders,
            refunded_orders: pair.previous.refunded_orders,
          },
          "db",
        ),
      };
    }

    if (
      !cachedCurrent &&
      !cachedPrevious &&
      !cutoffTime &&
      !hasAnyFilters(filters)
    ) {
      // Try the pipeline's pre-computed date-range presets for the current
      // period. On a hit, the previous period only needs a single-range
      // query (queryOverallSummaryTotals) instead of the combined
      // current+previous conditional-sum query — lighter on the DB even
      // though a round trip still happens for the previous side. CI events
      // aren't in the preset payload, so still fetched live either way.
      let presetCurrent = null;
      if (getDatePresetsCache && brandKey) {
        const presetsData = await getDatePresetsCache(brandKey);
        presetCurrent = matchDatePreset(presetsData, currentRange.start, currentRange.end);
      }

      if (presetCurrent) {
        const [previousMetrics, currentCiEvents, returnsPair] = await Promise.all([
          queryOverallSummaryTotals(conn, previousRange.start, previousRange.end, brandKey),
          queryCheckoutInitiatedTotals(conn, currentRange.start, currentRange.end, null, brandKey),
          getReturnsSnapshotPair(conn, currentRange, previousRange, filters),
        ]);

        return {
          current: buildSnapshotPayload(
            { ...presetCurrent, total_ci_events: currentCiEvents },
            returnsPair.current,
            "preset-cache",
          ),
          previous: buildSnapshotPayload(previousMetrics, returnsPair.previous, "db"),
        };
      }

      const [metricsPair, returnsPair] = await Promise.all([
        queryOverallSummaryPair(conn, currentRange, previousRange, brandKey),
        getReturnsSnapshotPair(conn, currentRange, previousRange, filters),
      ]);

      return {
        current: buildSnapshotPayload(metricsPair.current, returnsPair.current, "db"),
        previous: buildSnapshotPayload(
          metricsPair.previous,
          returnsPair.previous,
          "db",
        ),
      };
    }

    const [current, previous] = await Promise.all([
      getSnapshot({
        conn,
        range: currentRange,
        filters,
        cutoffTime,
        cachedData: cachedCurrent,
        brandKey,
      }),
      getSnapshot({
        conn,
        range: previousRange,
        filters,
        cutoffTime,
        cachedData: cachedPrevious,
        brandKey,
      }),
    ]);

    return { current, previous };
  }

  async function getDashboardSummary(spec) {
    const timezone = normalizeTimezone(spec.timezone);
    const compareRange = getComparableRange(
      spec.start,
      spec.end,
      spec.compareStart,
      spec.compareEnd,
    );
    if (!compareRange) {
      throw new Error("Previous range unavailable");
    }
    const cutoffCtx = buildCutoffContext(spec.start, spec.end, now(), timezone);
    const cutoffTime = cutoffCtx.includesToday ? cutoffCtx.cutoffTime : null;
    const rowTwoCutoffCtx = buildCompletedHourCutoffContext(
      spec.start,
      spec.end,
      now(),
      timezone,
    );
    const useCompletedHourSummaryForUtm =
      !!getUtmAggregateSource(spec.filters, "daily") &&
      !!rowTwoCutoffCtx.currentRangeIncludesToday;
    const useCompletedHourSummaryForDiscount =
      !!getDiscountAggregateSource(spec.filters, "daily") &&
      !!rowTwoCutoffCtx.currentRangeIncludesToday;
    const totalPair = await getSnapshotPair({
      conn: spec.conn,
      brandKey: spec.brandKey,
      currentRange: { start: spec.start, end: spec.end },
      previousRange: compareRange,
      filters: spec.filters,
    });
    const { current, previous } = totalPair;

    const deltaPair = cutoffTime || useCompletedHourSummaryForUtm || useCompletedHourSummaryForDiscount
      ? await getSnapshotPair({
          conn: spec.conn,
          brandKey: spec.brandKey,
          currentRange: { start: spec.start, end: spec.end },
          previousRange: compareRange,
          filters: spec.filters,
          cutoffTime,
          currentCutoffHour: useCompletedHourSummaryForUtm || useCompletedHourSummaryForDiscount
            ? rowTwoCutoffCtx.cutoffHour
            : null,
          previousCutoffHour: useCompletedHourSummaryForUtm || useCompletedHourSummaryForDiscount
            ? rowTwoCutoffCtx.cutoffHour
            : null,
        })
      : totalPair;

    let deltaCurrent = deltaPair.current;
    let deltaPrevious = deltaPair.previous;
    if (spec.filters.sales_channel) {
      const { sales_channel, ...filtersWithoutChannel } = spec.filters;
      const pair = await getSnapshotPair({
        conn: spec.conn,
        brandKey: spec.brandKey,
        currentRange: { start: spec.start, end: spec.end },
        previousRange: compareRange,
        filters: filtersWithoutChannel,
        cutoffTime,
        currentCutoffHour: useCompletedHourSummaryForUtm || useCompletedHourSummaryForDiscount
          ? rowTwoCutoffCtx.cutoffHour
          : null,
        previousCutoffHour: useCompletedHourSummaryForUtm || useCompletedHourSummaryForDiscount
          ? rowTwoCutoffCtx.cutoffHour
          : null,
      });
      deltaCurrent = pair.current;
      deltaPrevious = pair.previous;
      void sales_channel;
    }

    const discountActive = hasDiscountFilter(spec.filters);
    const cityActive = hasCityFilter(spec.filters);
    const combinedProductUtmSourceActive = isCombinedProductUtmSourceFilter(spec.filters);
    const productTypeActive = hasProductTypeFilter(spec.filters);
    const rowTwoComparison = discountActive || productTypeActive
      ? null
      : await getRowTwoComparisonSnapshots({
          conn: spec.conn,
          currentRange: { start: spec.start, end: spec.end },
          previousRange: compareRange,
          filters: spec.filters,
          cutoffCtx: rowTwoCutoffCtx,
        });
    const deltaRowTwoComparison =
      spec.filters.sales_channel && rowTwoComparison
        ? await getRowTwoComparisonSnapshots({
            conn: spec.conn,
            currentRange: { start: spec.start, end: spec.end },
            previousRange: compareRange,
            filters: {
              ...spec.filters,
              sales_channel: undefined,
            },
            cutoffCtx: rowTwoCutoffCtx,
          })
        : rowTwoComparison;

    const deltaCurrentRowTwo = deltaRowTwoComparison?.current || deltaCurrent;
    const deltaPreviousRowTwo =
      deltaRowTwoComparison?.previous || deltaPrevious;
    const intentPair = await queryIntentSummaryPair(
      spec.conn,
      { start: spec.start, end: spec.end },
      compareRange,
    );
    const currentIntent = intentPair.current || emptyIntentAggregate();
    const previousIntent = intentPair.previous || emptyIntentAggregate();
    const checkoutInitiatedPair = cityActive
      ? { current: null, previous: null }
      : await queryCheckoutInitiatedPair(
          spec.conn,
          { start: spec.start, end: spec.end },
          compareRange,
          null,
          null,
          spec.brandKey,
        );
    const checkoutInitiatedDeltaPair = cityActive
      ? checkoutInitiatedPair
      : rowTwoCutoffCtx.currentRangeIncludesToday
        ? await queryCheckoutInitiatedPair(
            spec.conn,
            { start: spec.start, end: spec.end },
            compareRange,
            rowTwoCutoffCtx.cutoffHour,
            rowTwoCutoffCtx.cutoffHour,
            spec.brandKey,
          )
        : checkoutInitiatedPair;

    return {
      filter_options: null,
      timezone,
      range: { start: spec.start, end: spec.end },
      prev_range: compareRange,
      metrics: {
        total_orders: buildSummaryMetric(
          current.total_orders,
          previous.total_orders,
          deltaCurrent.total_orders,
          deltaPrevious.total_orders,
        ),
        total_sales: buildSummaryMetric(
          current.total_sales,
          previous.total_sales,
          deltaCurrent.total_sales,
          deltaPrevious.total_sales,
        ),
        average_order_value: buildSummaryMetric(
          current.average_order_value,
          previous.average_order_value,
          deltaCurrent.average_order_value,
          deltaPrevious.average_order_value,
        ),
        conversion_rate: discountActive
          ? buildUnavailableSummaryMetric()
          : buildSummaryMetric(
              current.conversion_rate_percent,
              previous.conversion_rate_percent,
              deltaCurrentRowTwo.conversion_rate_percent,
              deltaPreviousRowTwo.conversion_rate_percent,
            ),
        total_sessions: discountActive
          ? buildUnavailableSummaryMetric()
          : buildSummaryMetric(
              current.total_sessions,
              previous.total_sessions,
              deltaCurrentRowTwo.total_sessions,
              deltaPreviousRowTwo.total_sessions,
            ),
        total_atc_sessions: discountActive
          ? buildUnavailableSummaryMetric()
          : buildSummaryMetric(
              current.total_atc_sessions,
              previous.total_atc_sessions,
              deltaCurrentRowTwo.total_atc_sessions,
              deltaPreviousRowTwo.total_atc_sessions,
            ),
        total_ci_events: discountActive || cityActive || combinedProductUtmSourceActive || productTypeActive
          ? buildUnavailableSummaryMetric()
          : buildSummaryMetric(
              checkoutInitiatedPair.current,
              checkoutInitiatedPair.previous,
              checkoutInitiatedDeltaPair.current,
              checkoutInitiatedDeltaPair.previous,
            ),
        checkout_rate: discountActive || cityActive || combinedProductUtmSourceActive || productTypeActive
          ? buildUnavailableSummaryMetric()
          : buildSummaryMetric(
              computeRatePercent(checkoutInitiatedPair.current, current.total_sessions),
              computeRatePercent(checkoutInitiatedPair.previous, previous.total_sessions),
              computeRatePercent(
                checkoutInitiatedDeltaPair.current,
                deltaCurrentRowTwo.total_sessions,
              ),
              computeRatePercent(
                checkoutInitiatedDeltaPair.previous,
                deltaPreviousRowTwo.total_sessions,
              ),
            ),
        atc_rate: discountActive
          ? buildUnavailableSummaryMetric()
          : buildSummaryMetric(
              computeRatePercent(current.total_atc_sessions, current.total_sessions),
              computeRatePercent(previous.total_atc_sessions, previous.total_sessions),
              computeRatePercent(
                deltaCurrentRowTwo.total_atc_sessions,
                deltaCurrentRowTwo.total_sessions,
              ),
              computeRatePercent(
                deltaPreviousRowTwo.total_atc_sessions,
                deltaPreviousRowTwo.total_sessions,
              ),
            ),
        cancelled_orders: discountActive || cityActive || productTypeActive
          ? buildUnavailableSummaryMetric()
          : buildSummaryMetric(
              current.cancelled_orders,
              previous.cancelled_orders,
              deltaCurrent.cancelled_orders,
              deltaPrevious.cancelled_orders,
            ),
        refunded_orders: discountActive || cityActive || productTypeActive
          ? buildUnavailableSummaryMetric()
          : buildSummaryMetric(
              current.refunded_orders,
              previous.refunded_orders,
              deltaCurrent.refunded_orders,
              deltaPrevious.refunded_orders,
            ),
        rto_orders: discountActive || cityActive || combinedProductUtmSourceActive || productTypeActive
          ? buildUnavailableSummaryMetric()
          : buildSummaryMetric(
              current.rto_orders,
              previous.rto_orders,
              deltaCurrent.rto_orders,
              deltaPrevious.rto_orders,
            ),
        rto_rate: discountActive || cityActive || combinedProductUtmSourceActive || productTypeActive
          ? buildUnavailableSummaryMetric()
          : buildSummaryMetric(
              current.rto_rate_percent,
              previous.rto_rate_percent,
              deltaCurrent.rto_rate_percent,
              deltaPrevious.rto_rate_percent,
            ),
        high_intent_sessions: buildSummaryMetric(
          currentIntent.high_intent_sessions,
          previousIntent.high_intent_sessions,
        ),
        medium_intent_sessions: buildSummaryMetric(
          currentIntent.medium_intent_sessions,
          previousIntent.medium_intent_sessions,
        ),
        low_intent_sessions: buildSummaryMetric(
          currentIntent.low_intent_sessions,
          previousIntent.low_intent_sessions,
        ),
        high_intent_percent: buildSummaryMetric(
          currentIntent.high_intent_percent,
          previousIntent.high_intent_percent,
        ),
        medium_intent_percent: buildSummaryMetric(
          currentIntent.medium_intent_percent,
          previousIntent.medium_intent_percent,
        ),
        low_intent_percent: buildSummaryMetric(
          currentIntent.low_intent_percent,
          previousIntent.low_intent_percent,
        ),
      },
      sources: {
        current: current.source,
        previous: previous.source,
        hourly_cutoff: cutoffTime,
      },
    };
  }

  async function getSummaryFilterOptions({ conn, start, end, filters = {} }) {
    return queryUtmSummaryFilterOptions(conn, start, end, filters);
  }

  async function getTrend(spec, granularity) {
    const timezone = normalizeTimezone(spec.timezone);
    const compareRange = getComparableRange(
      spec.start,
      spec.end,
      spec.compareStart,
      spec.compareEnd,
    );
    const cutoffCtx = buildCutoffContext(spec.start, spec.end, now(), timezone);
    const cutoffHour = cutoffCtx.includesToday ? cutoffCtx.cutoffHour : 23;
    let currentRows;
    let previousRows = [];

    if (granularity === "hourly") {
      [currentRows, previousRows] = await Promise.all([
        fetchHourlyRows(spec.conn, spec.start, spec.end, spec.filters, cutoffHour, spec.brandKey),
        compareRange
          ? fetchHourlyRows(
              spec.conn,
              compareRange.start,
              compareRange.end,
              spec.filters,
              cutoffCtx.includesToday ? cutoffHour : 23,
              spec.brandKey,
            )
          : Promise.resolve([]),
      ]);
      const points = buildHourlyPoints(currentRows, spec.start, spec.end, spec.aggregate, timezone);
      const comparison = compareRange
        ? {
            range: compareRange,
            points: buildHourlyPoints(previousRows, compareRange.start, compareRange.end, "avg", timezone),
            hourSampleCount: null,
          }
        : null;
      return {
        range: { start: spec.start, end: spec.end },
        timezone,
        alignHour: cutoffHour,
        points,
        comparison,
      };
    }

    if (granularity === "daily") {
      [currentRows, previousRows] = await Promise.all([
        fetchDailyRows(spec.conn, spec.start, spec.end, spec.filters, spec.brandKey),
        compareRange
          ? fetchDailyRows(spec.conn, compareRange.start, compareRange.end, spec.filters, spec.brandKey)
          : Promise.resolve([]),
      ]);
      const points = buildDailyPoints(currentRows, spec.start, spec.end);
      const comparison = compareRange
        ? {
            range: compareRange,
            points: buildDailyPoints(previousRows, compareRange.start, compareRange.end),
          }
        : null;
      return {
        range: { start: spec.start, end: spec.end },
        timezone,
        points,
        days: points,
        comparison: comparison ? { ...comparison, days: comparison.points } : null,
      };
    }

    [currentRows, previousRows] = await Promise.all([
      fetchMonthlyRows(spec.conn, spec.start, spec.end, spec.filters, spec.brandKey),
      compareRange
        ? fetchMonthlyRows(spec.conn, compareRange.start, compareRange.end, spec.filters, spec.brandKey)
        : Promise.resolve([]),
    ]);
    return {
      range: { start: spec.start, end: spec.end },
      timezone,
      points: currentRows,
      months: currentRows,
      comparison: compareRange
        ? {
            range: compareRange,
            points: previousRows,
            months: previousRows,
          }
        : null,
      };
  }

  async function getDailyFunnel(spec) {
    const timezone = normalizeTimezone(spec.timezone);
    const includeDaily = spec.includeDaily !== false;
    const includeUtm = spec.includeUtm === true;
    const utmEndDateResolved = spec.utmEndDate || spec.utmDate || spec.end;
    const utmCutoffCtx = includeUtm
      ? buildCompletedHourCutoffContext(
          spec.utmDate || spec.end,
          utmEndDateResolved,
          now(),
          timezone,
        )
      : null;
    const [baseRows, paymentRows, discountRows, utmRows] = await Promise.all([
      includeDaily
        ? fetchDailyRows(spec.conn, spec.start, spec.end, {}, spec.brandKey)
        : Promise.resolve([]),
      includeDaily
        ? spec.conn.query(
            `
              SELECT
                DATE_FORMAT(date, '%Y-%m-%d') AS date,
                COALESCE(SUM(prepaid_orders), 0) AS prepaid_orders,
                COALESCE(SUM(cod_orders), 0) AS cod_orders,
                COALESCE(SUM(partially_paid_orders), 0) AS partially_paid_orders
              FROM overall_summary
              WHERE date >= ? AND date <= ?
              GROUP BY date
              ORDER BY date ASC
            `,
            {
              type: QueryTypes.SELECT,
              replacements: [spec.start, spec.end],
            },
          )
        : Promise.resolve([]),
      includeDaily
        ? spec.conn.query(
            `
              SELECT
                DATE_FORMAT(date, '%Y-%m-%d') AS date,
                COALESCE(SUM(total_discounts_given), 0) AS discount_amount
              FROM discount_summary
              WHERE date >= ? AND date <= ?
              GROUP BY date
              ORDER BY date ASC
            `,
            {
              type: QueryTypes.SELECT,
              replacements: [spec.start, spec.end],
            },
          )
        : Promise.resolve([]),
      includeUtm
        ? (spec.utmSource
            ? queryDailyFunnelUtmCampaignRowsWithDelta(
                spec.conn,
                spec.utmDate || spec.end,
                spec.compareUtmDate,
                spec.utmSource,
                utmCutoffCtx,
                { endDate: utmEndDateResolved, compareEndDate: spec.compareUtmEndDate },
              )
            : queryDailyFunnelUtmRowsWithDelta(
                spec.conn,
                spec.utmDate || spec.end,
                spec.compareUtmDate,
                utmCutoffCtx,
                { endDate: utmEndDateResolved, compareEndDate: spec.compareUtmEndDate },
              ))
        : Promise.resolve([]),
    ]);

    const baseMap = new Map(
      (Array.isArray(baseRows) ? baseRows : []).map((row) => [String(row.date), row]),
    );
    const paymentMap = new Map(
      (Array.isArray(paymentRows) ? paymentRows : []).map((row) => [String(row.date), row]),
    );
    const discountMap = new Map(
      (Array.isArray(discountRows) ? discountRows : []).map((row) => [String(row.date), row]),
    );

    const rows = includeDaily
      ? buildSeriesBuckets(spec.start, spec.end)
          .map((date) => {
            const base = baseMap.get(date) || {};
            const payment = paymentMap.get(date) || {};
            const discount = discountMap.get(date) || {};

            return {
              date,
              sales: Number(base.sales || 0),
              sessions: Number(base.sessions || 0),
              atc_sessions: Number(base.atc || 0),
              ci_events: Number(base.ci_events || 0),
              orders: Number(base.orders || 0),
              discount_amount: Number(discount.discount_amount || 0),
              prepaid_orders: Number(payment.prepaid_orders || 0),
              cod_orders: Number(payment.cod_orders || 0),
              partially_paid_orders: Number(payment.partially_paid_orders || 0),
            };
          })
          .sort((left, right) => right.date.localeCompare(left.date))
      : [];

    const utmDateResolved = spec.utmDate || spec.end;
    const utmCutoffApplied =
      includeUtm &&
      !!utmCutoffCtx?.today &&
      utmDateResolved === utmCutoffCtx.today &&
      utmEndDateResolved === utmCutoffCtx.today &&
      Number.isInteger(utmCutoffCtx?.cutoffHour);

    return {
      timezone,
      range: { start: spec.start, end: spec.end },
      rows,
      utmDate: includeUtm ? utmDateResolved : null,
      utmEndDate: includeUtm ? utmEndDateResolved : null,
      utmSource: includeUtm ? (spec.utmSource || null) : null,
      utmCutoffHour: utmCutoffApplied ? utmCutoffCtx.cutoffHour : null,
      utmRows: includeUtm ? utmRows : [],
    };
  }

  return {
    getSnapshot,
    getSnapshotPair,
    getDashboardSummary,
    getTrend,
    getDailyFunnel,
    getSummaryFilterOptions,
  };
}

module.exports = {
  normalizeMetricRequest,
  buildMetricsSnapshotService,
};
