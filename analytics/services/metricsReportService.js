const { QueryTypes } = require("sequelize");
const { shiftDays } = require("../shared/utils/date");
const { buildWhereClause } = require("../shared/utils/sql");
const { appendUtmWhere, hasUtmFilters } = require("../shared/utils/filters");
const {
  resolveUtmAggregateSource,
  resolveDiscountAggregateSource,
  queryDiscountPaymentModeSplit,
  resolveProductTypeAggregateSource,
  appendProductTypeWhere,
} = require("./metricsAggregateService");
const {
  pad2,
  DEFAULT_TIMEZONE,
  getTimezoneContext,
  normalizeTimezone,
  formatUtcDate,
  resolveCompareRange,
  buildCompletedHourOrderCutoffTime,
} = require("./metricsFoundation");
const { matchDatePreset } = require("./metricsCacheService");

const PAYMENT_TYPE_CASE_SQL = `
  CASE
    WHEN payment_gateway_names LIKE '%Gokwik PPCOD%' THEN 'Partial'
    WHEN (payment_gateway_names IS NULL 
    OR payment_gateway_names = '' 
    OR payment_gateway_names LIKE '%Cash on Delivery (COD)%' 
    OR payment_gateway_names LIKE '%cash_on_delivery%')
    AND (payment_gateway_names NOT LIKE '%Gokwik PPCOD%' OR payment_gateway_names IS NULL)
    THEN 'COD'
    ELSE 'Prepaid'
  END
`;

function parseHourLte(hourLteRaw) {
  const hasHourLte =
    hourLteRaw !== undefined &&
    hourLteRaw !== null &&
    `${hourLteRaw}`.trim() !== "";
  if (!hasHourLte) {
    return { hasHourLte: false, hourLte: null };
  }
  const hourLte = Number.parseInt(`${hourLteRaw}`.trim(), 10);
  if (!Number.isInteger(hourLte) || hourLte < 0 || hourLte > 23) {
    const error = new Error(
      "Invalid hour_lte. Expected an integer between 0 and 23.",
    );
    error.status = 400;
    throw error;
  }
  return { hasHourLte: true, hourLte };
}

function buildClosedOpenTimestampRange(start, end, hourLte = null) {
  const effectiveStart = start || end;
  const effectiveEnd = end || start;
  if (!effectiveStart || !effectiveEnd) {
    return null;
  }
  const startTs = `${effectiveStart} 00:00:00`;
  const endTsExclusive = new Date(`${effectiveEnd}T00:00:00Z`);
  if (Number.isInteger(hourLte)) {
    endTsExclusive.setUTCHours(hourLte + 1, 0, 0, 0);
  } else {
    endTsExclusive.setUTCDate(endTsExclusive.getUTCDate() + 1);
  }
  return {
    effectiveStart,
    effectiveEnd,
    startTs,
    endTs: endTsExclusive.toISOString().slice(0, 19).replace("T", " "),
  };
}

function hasCityFilter(filters = {}) {
  return Array.isArray(filters.city) ? filters.city.length > 0 : !!filters.city;
}

// True only when NO filter of any kind is active (product, city, UTM/sales
// channel/device — hasUtmFilters covers those three plus city, discount,
// product type). Explicit and independent of branch ordering elsewhere in
// this file, so it never silently reads the unfiltered rollup for a request
// that actually has a filter applied.
function isUnfilteredPaymentRequest(filters = {}, productId = "") {
  const hasProductType = Array.isArray(filters.product_type)
    ? filters.product_type.length > 0
    : !!filters.product_type;
  return !(
    productId ||
    hasCityFilter(filters) ||
    hasUtmFilters(filters) ||
    filters.discount_code ||
    hasProductType
  );
}

function appendCityOrderWhere(whereSql, replacements, city) {
  const cities = Array.isArray(city) ? city.filter(Boolean) : city ? [city] : [];
  if (cities.length === 0) return whereSql;
  const normalizedExpr =
    "LOWER(TRIM(COALESCE(NULLIF(shipping_city, ''), NULLIF(billing_city, ''))))";
  if (cities.length === 1) {
    replacements.push(cities[0].toString().trim().toLowerCase());
    return `${whereSql} AND ${normalizedExpr} = ?`;
  }
  replacements.push(...cities.map((value) => value.toString().trim().toLowerCase()));
  return `${whereSql} AND ${normalizedExpr} IN (${cities.map(() => "?").join(", ")})`;
}

function computeOrderSplitPayload({
  start,
  end,
  timezone = DEFAULT_TIMEZONE,
  hourLte = null,
  productId = "",
  codOrders = 0,
  prepaidOrders = 0,
  partiallyPaidOrders = 0,
  includeSql = false,
  sql = "",
}) {
  const total = codOrders + prepaidOrders + partiallyPaidOrders;
  return {
    metric: "ORDER_SPLIT",
    timezone: normalizeTimezone(timezone),
    range: {
      start: start || null,
      end: end || null,
      hour_lte: Number.isInteger(hourLte) ? hourLte : null,
      ...(productId ? { product_id: productId } : {}),
    },
    cod_orders: codOrders,
    prepaid_orders: prepaidOrders,
    partially_paid_orders: partiallyPaidOrders,
    total_orders_from_split: total,
    cod_percent: total > 0 ? (codOrders / total) * 100 : 0,
    prepaid_percent: total > 0 ? (prepaidOrders / total) * 100 : 0,
    partially_paid_percent:
      total > 0 ? (partiallyPaidOrders / total) * 100 : 0,
    sql_used: includeSql ? sql : undefined,
  };
}

function buildTimezoneBuckets(days, timezone = DEFAULT_TIMEZONE, now = new Date()) {
  const buckets = [];
  const resolvedTimezone = normalizeTimezone(timezone);
  const nowLocal = getTimezoneContext(now, resolvedTimezone).nowLocal;
  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(nowLocal.getTime());
    day.setUTCDate(day.getUTCDate() - offset);
    const date = formatUtcDate(day);
    const maxHour = offset === 0 ? day.getUTCHours() : 23;
    for (let hour = 0; hour <= maxHour; hour += 1) {
      buckets.push({ date, hour });
    }
  }
  return buckets;
}

const buildIstBuckets = (days, now = new Date()) => buildTimezoneBuckets(days, DEFAULT_TIMEZONE, now);

function shiftBucketDays(buckets, deltaDays) {
  return buckets.map((bucket) => ({
    date: shiftDays(bucket.date, deltaDays),
    hour: bucket.hour,
  }));
}

function getBucketSpan(buckets) {
  if (!Array.isArray(buckets) || buckets.length === 0) {
    return null;
  }
  const dates = buckets.map((bucket) => bucket.date).sort();
  return {
    start: dates[0],
    end: dates[dates.length - 1],
  };
}

function normalizeProductIds(productId) {
  if (Array.isArray(productId)) {
    return productId
      .map((value) => (value == null ? "" : String(value).trim()))
      .filter(Boolean);
  }
  const normalized = productId == null ? "" : String(productId).trim();
  return normalized ? [normalized] : [];
}

async function fetchHourlySalesRange(conn, start, end) {
  if (!start || !end) return [];
  return conn.query(
    `
      SELECT
        DATE_FORMAT(date, '%Y-%m-%d') AS date,
        hour,
        total_sales
      FROM hour_wise_sales
      WHERE date >= ? AND date <= ?
      ORDER BY date ASC, hour ASC
    `,
    {
      type: QueryTypes.SELECT,
      replacements: [start, end],
    },
  );
}

function buildMetricsReportService(deps = {}) {
  const { getDatePresetsCache } = deps;

  // Checks the pipeline's date_presets:<brand> cache for an exact
  // start/end match (see matchDatePreset — never independently recomputed,
  // only trusted on an exact string match against the preset's own stored
  // boundaries) and returns its payment_breakdown, or null on any miss.
  async function getPresetPaymentBreakdown(brandKey, start, end) {
    if (!getDatePresetsCache || !brandKey) return null;
    const presetsData = await getDatePresetsCache(brandKey);
    const preset = matchDatePreset(presetsData, start, end);
    return preset?.payment_breakdown || null;
  }

  async function getTrafficSourceSplit({
    conn,
    start,
    end,
    compareStart = null,
    compareEnd = null,
    productId = "",
  }) {
    const previousRange = resolveCompareRange(
      start,
      end,
      compareStart,
      compareEnd,
    );
    const productIds = normalizeProductIds(productId);
    const useProductScopedSource = productIds.length > 0;
    const dateReplacements = [
      start,
      end,
      previousRange?.start || start,
      previousRange?.end || end,
    ];

    let sql = `
      SELECT date, utm_source
      FROM ${useProductScopedSource ? "product_traffic_split" : "overall_traffic_split"}
      WHERE ((date >= ? AND date <= ?) OR (date >= ? AND date <= ?))
    `;
    const replacements = [...dateReplacements];

    if (useProductScopedSource) {
      if (productIds.length === 1) {
        sql += ` AND product_id = ?`;
        replacements.push(productIds[0]);
      } else {
        sql += ` AND product_id IN (?)`;
        replacements.push(productIds);
      }
    }

    const rows = await conn.query(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
    return {
      rows,
      prev_range: previousRange,
    };
  }

  async function getPaymentSalesSplit({
    conn,
    brandKey = "",
    start,
    end,
    hourLte = null,
    productId = "",
    filters = {},
    includeSql = false,
    timezone = DEFAULT_TIMEZONE,
  }) {
    const resolvedTimezone = normalizeTimezone(timezone);
    const effectiveStart = start || end;
    const effectiveEnd = end || start;
    if (!effectiveStart || !effectiveEnd) {
      return {
        metric: "PAYMENT_SPLIT_SALES",
        timezone: resolvedTimezone,
        range: { start: null, end: null },
        cod_sales: 0,
        prepaid_sales: 0,
        partial_sales: 0,
        total_sales_from_split: 0,
        cod_percent: 0,
        prepaid_percent: 0,
        partial_percent: 0,
      };
    }

    const isSingleDay = effectiveStart === effectiveEnd;
    const useHourlyCutoff = Number.isInteger(hourLte);

    const discountSource = resolveDiscountAggregateSource(
      filters,
      useHourlyCutoff ? "hourly" : "daily",
    );
    if (discountSource && !productId) {
      const split = await queryDiscountPaymentModeSplit(
        conn,
        {
          table: useHourlyCutoff
            ? "dashboard_discount_payment_hourly"
            : "dashboard_discount_payment_daily",
          start: effectiveStart,
          end: effectiveEnd,
          hourLte: useHourlyCutoff ? hourLte : null,
          valueColumn: "gross_revenue",
        },
        filters,
      );
      const sql = split.sql;
      const codSales = split.cod;
      const prepaidSales = split.prepaid;
      const partialSales = split.partially_paid;
      const total = codSales + prepaidSales + partialSales;
      return {
        metric: "PAYMENT_SPLIT_SALES",
        timezone: resolvedTimezone,
        range: {
          start: effectiveStart,
          end: effectiveEnd,
          hour_lte: useHourlyCutoff ? hourLte : null,
        },
        cod_sales: codSales,
        prepaid_sales: prepaidSales,
        partial_sales: partialSales,
        total_sales_from_split: total,
        cod_percent: total > 0 ? (codSales / total) * 100 : 0,
        prepaid_percent: total > 0 ? (prepaidSales / total) * 100 : 0,
        partial_percent: total > 0 ? (partialSales / total) * 100 : 0,
        sql_used: includeSql ? sql : undefined,
      };
    }

    // mv_product_type_funnel_daily has no payment-mode breakdown — surface
    // the real gross_revenue total (for the donut center) but mark the
    // cod/prepaid/partial split unavailable so the UI shows "-" instead of
    // a misleading 0.
    const productTypeSource = resolveProductTypeAggregateSource(filters, "daily");
    if (productTypeSource && !productId) {
      let sql = `
        SELECT COALESCE(SUM(gross_revenue), 0) AS gross_sales
        FROM ${productTypeSource.table}
        WHERE date >= ? AND date <= ?
      `;
      const replacements = [effectiveStart, effectiveEnd];
      sql = appendProductTypeWhere(sql, replacements, productTypeSource.filters);

      const rows = await conn.query(sql, {
        type: QueryTypes.SELECT,
        replacements,
      });
      const total = Number(rows?.[0]?.gross_sales || 0);

      return {
        metric: "PAYMENT_SPLIT_SALES",
        timezone: resolvedTimezone,
        range: {
          start: effectiveStart,
          end: effectiveEnd,
          hour_lte: null,
        },
        cod_sales: null,
        prepaid_sales: null,
        partial_sales: null,
        total_sales_from_split: total,
        cod_percent: null,
        prepaid_percent: null,
        partial_percent: null,
        payment_mode_unavailable: true,
        sql_used: includeSql ? sql : undefined,
      };
    }

    // Preset-cache fast path — for the 5 fixed windows the pipeline
    // pre-computes (last 7/30/90 days, last month, month-to-date), the
    // payment split comes straight from Redis, zero DB round trips. Only
    // applies to whole-range (no hourly cutoff), unfiltered requests whose
    // start/end exactly match a preset's own stored boundaries.
    if (!useHourlyCutoff && isUnfilteredPaymentRequest(filters, productId)) {
      const breakdown = await getPresetPaymentBreakdown(brandKey, effectiveStart, effectiveEnd);
      if (breakdown) {
        const codSales = Number(breakdown.cod_sales || 0);
        const prepaidSales = Number(breakdown.prepaid_sales || 0);
        const partialSales = Number(breakdown.partially_paid_sales || 0);
        const total = codSales + prepaidSales + partialSales;
        return {
          metric: "PAYMENT_SPLIT_SALES",
          timezone: resolvedTimezone,
          range: { start: effectiveStart, end: effectiveEnd, hour_lte: null },
          cod_sales: codSales,
          prepaid_sales: prepaidSales,
          partial_sales: partialSales,
          total_sales_from_split: total,
          cod_percent: total > 0 ? (codSales / total) * 100 : 0,
          prepaid_percent: total > 0 ? (prepaidSales / total) * 100 : 0,
          partial_percent: total > 0 ? (partialSales / total) * 100 : 0,
        };
      }
    }

    // Unfiltered fast path — the pipeline now maintains cod_sales/
    // prepaid_sales/partially_prepaid_sales on the daily and hourly rollup
    // tables, so this no longer needs to scan shopify_orders at all when no
    // filter is active. Any filter falls through to the raw-table path below.
    if (isUnfilteredPaymentRequest(filters, productId)) {
      let sql;
      const replacements = [effectiveStart, effectiveEnd];
      if (useHourlyCutoff) {
        sql = `
          SELECT
            COALESCE(SUM(cod_sales), 0) AS cod_sales,
            COALESCE(SUM(prepaid_sales), 0) AS prepaid_sales,
            COALESCE(SUM(partially_prepaid_sales), 0) AS partial_sales
          FROM hour_wise_sales
          WHERE date >= ? AND date <= ? AND hour <= ?
        `;
        replacements.push(hourLte);
      } else {
        sql = `
          SELECT
            COALESCE(SUM(cod_sales), 0) AS cod_sales,
            COALESCE(SUM(prepaid_sales), 0) AS prepaid_sales,
            COALESCE(SUM(partially_prepaid_sales), 0) AS partial_sales
          FROM overall_summary
          WHERE date >= ? AND date <= ?
        `;
      }

      const rows = await conn.query(sql, {
        type: QueryTypes.SELECT,
        replacements,
      });
      const row = rows?.[0] || {};
      const codSales = Number(row.cod_sales || 0);
      const prepaidSales = Number(row.prepaid_sales || 0);
      const partialSales = Number(row.partial_sales || 0);
      const total = codSales + prepaidSales + partialSales;

      return {
        metric: "PAYMENT_SPLIT_SALES",
        timezone: resolvedTimezone,
        range: {
          start: effectiveStart,
          end: effectiveEnd,
          hour_lte: useHourlyCutoff ? hourLte : null,
        },
        cod_sales: codSales,
        prepaid_sales: prepaidSales,
        partial_sales: partialSales,
        total_sales_from_split: total,
        cod_percent: total > 0 ? (codSales / total) * 100 : 0,
        prepaid_percent: total > 0 ? (prepaidSales / total) * 100 : 0,
        partial_percent: total > 0 ? (partialSales / total) * 100 : 0,
        sql_used: includeSql ? sql : undefined,
      };
    }

    let whereSql = isSingleDay
      ? `WHERE created_date = ?`
      : `WHERE created_date >= ? AND created_date <= ?`;
    const replacements = isSingleDay
      ? [effectiveStart]
      : [effectiveStart, effectiveEnd];

    if (productId || hasCityFilter(filters)) {
      whereSql += ` AND product_id = ?`;
      if (productId) {
        replacements.push(productId);
      } else {
        whereSql = whereSql.replace(" AND product_id = ?", "");
      }
    }
    if (useHourlyCutoff) {
      whereSql += ` AND created_time < ?`;
      replacements.push(buildCompletedHourOrderCutoffTime(hourLte));
    }
    whereSql = appendUtmWhere(whereSql, replacements, filters, true);
    whereSql = appendCityOrderWhere(whereSql, replacements, filters.city);

    const sql = `
      SELECT payment_type, SUM(max_price) AS sales
      FROM (
        SELECT
          ${PAYMENT_TYPE_CASE_SQL} AS payment_type,
          order_name,
          MAX(total_price) AS max_price
        FROM shopify_orders
        ${whereSql}
        GROUP BY payment_gateway_names, order_name
      ) sub
      GROUP BY payment_type
    `;

    const rows = await conn.query(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });

    let codSales = 0;
    let prepaidSales = 0;
    let partialSales = 0;
    for (const row of rows) {
      if (row.payment_type === "COD") {
        codSales = Number(row.sales || 0);
      } else if (row.payment_type === "Prepaid") {
        prepaidSales = Number(row.sales || 0);
      } else if (row.payment_type === "Partial") {
        partialSales = Number(row.sales || 0);
      }
    }

    const total = codSales + prepaidSales + partialSales;
    return {
      metric: "PAYMENT_SPLIT_SALES",
      timezone: resolvedTimezone,
      range: {
        start: effectiveStart,
        end: effectiveEnd,
        hour_lte: null,
      },
      cod_sales: codSales,
      prepaid_sales: prepaidSales,
      partial_sales: partialSales,
      total_sales_from_split: total,
      cod_percent: total > 0 ? (codSales / total) * 100 : 0,
      prepaid_percent: total > 0 ? (prepaidSales / total) * 100 : 0,
      partial_percent: total > 0 ? (partialSales / total) * 100 : 0,
      sql_used: includeSql ? sql : undefined,
    };
  }

  async function getOrderSplit({
    conn,
    brandKey = "",
    start,
    end,
    hourLte = null,
    productId = "",
    filters = {},
    includeSql = false,
    timezone = DEFAULT_TIMEZONE,
  }) {
    const resolvedTimezone = normalizeTimezone(timezone);
    const effectiveStart = start || end;
    const effectiveEnd = end || start;
    const useHourlyCutoff = Number.isInteger(hourLte);

    if (productId || hasCityFilter(filters)) {
      if (!effectiveStart || !effectiveEnd) {
        return computeOrderSplitPayload({
          start: effectiveStart,
          end: effectiveEnd,
          timezone: resolvedTimezone,
          productId,
        });
      }

      const isSingleDay = effectiveStart === effectiveEnd;
      let whereSql = isSingleDay
        ? `WHERE created_date = ?`
        : `WHERE created_date >= ? AND created_date <= ?`;
      const replacements = isSingleDay
        ? [effectiveStart]
        : [effectiveStart, effectiveEnd];

      if (productId) {
        whereSql += ` AND product_id = ?`;
        replacements.push(productId);
      }
      if (useHourlyCutoff) {
        whereSql += ` AND created_time < ?`;
        replacements.push(buildCompletedHourOrderCutoffTime(hourLte));
      }
      whereSql = appendUtmWhere(whereSql, replacements, filters, true);
      whereSql = appendCityOrderWhere(whereSql, replacements, filters.city);

      const sql = `
        SELECT payment_type, COUNT(DISTINCT order_name) AS cnt
        FROM (
          SELECT
            ${PAYMENT_TYPE_CASE_SQL} AS payment_type,
            order_name
          FROM shopify_orders
          ${whereSql}
          GROUP BY payment_gateway_names, order_name
        ) sub
        GROUP BY payment_type
      `;

      const rows = await conn.query(sql, {
        type: QueryTypes.SELECT,
        replacements,
      });

      let codOrders = 0;
      let prepaidOrders = 0;
      let partiallyPaidOrders = 0;
      for (const row of rows) {
        if (row.payment_type === "COD") {
          codOrders = Number(row.cnt || 0);
        } else if (row.payment_type === "Prepaid") {
          prepaidOrders = Number(row.cnt || 0);
        } else if (row.payment_type === "Partial") {
          partiallyPaidOrders = Number(row.cnt || 0);
        }
      }

      return computeOrderSplitPayload({
        start: effectiveStart,
        end: effectiveEnd,
        timezone: resolvedTimezone,
        hourLte: useHourlyCutoff ? hourLte : null,
        productId,
        codOrders,
        prepaidOrders,
        partiallyPaidOrders,
        includeSql,
        sql,
      });
    }

    const discountSource = resolveDiscountAggregateSource(
      filters,
      useHourlyCutoff ? "hourly" : "daily",
    );
    if (discountSource && !productId) {
      const split = await queryDiscountPaymentModeSplit(
        conn,
        {
          table: useHourlyCutoff
            ? "dashboard_discount_payment_hourly"
            : "dashboard_discount_payment_daily",
          start: effectiveStart,
          end: effectiveEnd,
          hourLte: useHourlyCutoff ? hourLte : null,
          valueColumn: "total_orders",
        },
        filters,
      );

      return computeOrderSplitPayload({
        start: effectiveStart,
        end: effectiveEnd,
        timezone: resolvedTimezone,
        hourLte: useHourlyCutoff ? hourLte : null,
        codOrders: split.cod,
        prepaidOrders: split.prepaid,
        partiallyPaidOrders: split.partially_paid,
        includeSql,
        sql: split.sql,
      });
    }

    // mv_product_type_funnel_daily has no payment-mode breakdown — surface
    // the real total_orders (for the donut center) but mark the
    // cod/prepaid/partial split unavailable so the UI shows "-" instead of
    // a misleading 0.
    const productTypeSource = resolveProductTypeAggregateSource(filters, "daily");
    if (productTypeSource && !productId) {
      let sql = `
        SELECT COALESCE(SUM(total_orders), 0) AS total_orders
        FROM ${productTypeSource.table}
        WHERE date >= ? AND date <= ?
      `;
      const replacements = [effectiveStart, effectiveEnd];
      sql = appendProductTypeWhere(sql, replacements, productTypeSource.filters);

      const rows = await conn.query(sql, {
        type: QueryTypes.SELECT,
        replacements,
      });
      const total = Number(rows?.[0]?.total_orders || 0);

      return {
        metric: "ORDER_SPLIT",
        timezone: resolvedTimezone,
        range: {
          start: effectiveStart,
          end: effectiveEnd,
          hour_lte: null,
        },
        cod_orders: null,
        prepaid_orders: null,
        partially_paid_orders: null,
        total_orders_from_split: total,
        cod_percent: null,
        prepaid_percent: null,
        partially_paid_percent: null,
        payment_mode_unavailable: true,
        sql_used: includeSql ? sql : undefined,
      };
    }

    const aggregateSource = resolveUtmAggregateSource(
      filters,
      useHourlyCutoff ? "hourly" : "daily",
    );
    if (aggregateSource) {
      let sql = `
        SELECT
          COALESCE(SUM(cod_orders), 0) AS cod_orders,
          COALESCE(SUM(prepaid_orders), 0) AS prepaid_orders,
          COALESCE(SUM(ppcod_orders), 0) AS partially_paid_orders
        FROM ${aggregateSource.table}
        WHERE metric_date >= ? AND metric_date <= ?
      `;
      const replacements = [effectiveStart, effectiveEnd];
      if (useHourlyCutoff) {
        sql += ` AND metric_hour <= ?`;
        replacements.push(hourLte);
      }
      sql = appendUtmWhere(sql, replacements, aggregateSource.filters, true);

      const [row] = await conn.query(sql, {
        type: QueryTypes.SELECT,
        replacements,
      });

      return computeOrderSplitPayload({
        start: effectiveStart,
        end: effectiveEnd,
        timezone: resolvedTimezone,
        hourLte: useHourlyCutoff ? hourLte : null,
        codOrders: Number(row?.cod_orders || 0),
        prepaidOrders: Number(row?.prepaid_orders || 0),
        partiallyPaidOrders: Number(row?.partially_paid_orders || 0),
        includeSql,
        sql,
      });
    }

    if (useHourlyCutoff) {
      // Unfiltered fast path — hour_wise_sales now carries per-hour cod/
      // prepaid/ppcod order counts from the pipeline. Any filter falls
      // through to the raw-table path below.
      if (isUnfilteredPaymentRequest(filters, productId)) {
        const sql = `
          SELECT
            COALESCE(SUM(number_of_cod_orders), 0) AS cod_orders,
            COALESCE(SUM(number_of_prepaid_orders), 0) AS prepaid_orders,
            COALESCE(SUM(number_of_ppcod_orders), 0) AS partially_paid_orders
          FROM hour_wise_sales
          WHERE date >= ? AND date <= ? AND hour <= ?
        `;
        const [row] = await conn.query(sql, {
          type: QueryTypes.SELECT,
          replacements: [effectiveStart, effectiveEnd, hourLte],
        });

        return computeOrderSplitPayload({
          start: effectiveStart,
          end: effectiveEnd,
          timezone: resolvedTimezone,
          hourLte,
          codOrders: Number(row?.cod_orders || 0),
          prepaidOrders: Number(row?.prepaid_orders || 0),
          partiallyPaidOrders: Number(row?.partially_paid_orders || 0),
          includeSql,
          sql,
        });
      }

      const isSingleDay = effectiveStart === effectiveEnd;
      let whereSql = isSingleDay
        ? `WHERE created_date = ?`
        : `WHERE created_date >= ? AND created_date <= ?`;
      const replacements = isSingleDay
        ? [effectiveStart]
        : [effectiveStart, effectiveEnd];

      whereSql += ` AND created_time < ?`;
      replacements.push(buildCompletedHourOrderCutoffTime(hourLte));
      whereSql = appendUtmWhere(whereSql, replacements, filters, true);
      whereSql = appendCityOrderWhere(whereSql, replacements, filters.city);

      const sql = `
        SELECT payment_type, COUNT(DISTINCT order_name) AS cnt
        FROM (
          SELECT
            ${PAYMENT_TYPE_CASE_SQL} AS payment_type,
            order_name
          FROM shopify_orders
          ${whereSql}
          GROUP BY payment_gateway_names, order_name
        ) sub
        GROUP BY payment_type
      `;

      const rows = await conn.query(sql, {
        type: QueryTypes.SELECT,
        replacements,
      });

      let codOrders = 0;
      let prepaidOrders = 0;
      let partiallyPaidOrders = 0;
      for (const row of rows) {
        if (row.payment_type === "COD") {
          codOrders = Number(row.cnt || 0);
        } else if (row.payment_type === "Prepaid") {
          prepaidOrders = Number(row.cnt || 0);
        } else if (row.payment_type === "Partial") {
          partiallyPaidOrders = Number(row.cnt || 0);
        }
      }

      return computeOrderSplitPayload({
        start: effectiveStart,
        end: effectiveEnd,
        timezone: resolvedTimezone,
        hourLte,
        codOrders,
        prepaidOrders,
        partiallyPaidOrders,
        includeSql,
        sql,
      });
    }

    // Preset-cache fast path — same 5 fixed windows as getPaymentSalesSplit,
    // served straight from Redis on an exact start/end match. Only reaches
    // here when unfiltered and no hourly cutoff (see branches above).
    if (isUnfilteredPaymentRequest(filters, productId)) {
      const breakdown = await getPresetPaymentBreakdown(brandKey, effectiveStart, effectiveEnd);
      if (breakdown) {
        return computeOrderSplitPayload({
          start: effectiveStart,
          end: effectiveEnd,
          timezone: resolvedTimezone,
          codOrders: Number(breakdown.cod_orders || 0),
          prepaidOrders: Number(breakdown.prepaid_orders || 0),
          partiallyPaidOrders: Number(breakdown.partially_paid_orders || 0),
        });
      }
    }

    const { where, params } = buildWhereClause(start, end);
    const sql = `
      SELECT
        COALESCE(SUM(cod_orders), 0) AS cod_orders,
        COALESCE(SUM(prepaid_orders), 0) AS prepaid_orders,
        COALESCE(SUM(partially_paid_orders), 0) AS partially_paid_orders
      FROM overall_summary
      ${where}
    `;
    const [row] = await conn.query(sql, {
      type: QueryTypes.SELECT,
      replacements: params,
    });

    const codOrders = Number(row?.cod_orders || 0);
    const prepaidOrders = Number(row?.prepaid_orders || 0);
    const partiallyPaidOrders = Number(row?.partially_paid_orders || 0);
    return computeOrderSplitPayload({
      start,
      end,
      timezone: resolvedTimezone,
      hourLte: useHourlyCutoff ? hourLte : null,
      codOrders,
      prepaidOrders,
      partiallyPaidOrders,
    });
  }

  async function getHourlySalesCompare({ conn, days, now = new Date(), timezone = DEFAULT_TIMEZONE }) {
    const resolvedTimezone = normalizeTimezone(timezone);
    const currentBuckets = buildTimezoneBuckets(days, resolvedTimezone, now);
    const previousBuckets = shiftBucketDays(currentBuckets, -1);

    const currentSpan = getBucketSpan(currentBuckets);
    const previousSpan = getBucketSpan(previousBuckets);
    const [currentRows, previousRows] = await Promise.all([
      fetchHourlySalesRange(conn, currentSpan?.start, currentSpan?.end),
      fetchHourlySalesRange(conn, previousSpan?.start, previousSpan?.end),
    ]);

    const currentBucketKeys = new Set(
      currentBuckets.map((bucket) => `${bucket.date}#${bucket.hour}`),
    );
    const previousBucketKeys = new Set(
      previousBuckets.map((bucket) => `${bucket.date}#${bucket.hour}`),
    );
    const currentMap = new Map();
    const previousMap = new Map();

    for (const row of currentRows) {
      const key = `${row.date}#${row.hour}`;
      if (currentBucketKeys.has(key)) {
        currentMap.set(key, Number(row.total_sales || 0));
      }
    }
    for (const row of previousRows) {
      const key = `${row.date}#${row.hour}`;
      if (previousBucketKeys.has(key)) {
        previousMap.set(key, Number(row.total_sales || 0));
      }
    }

    return {
      labels: currentBuckets.map((bucket) => `${pad2(bucket.hour)}:00`),
      series: {
        current: currentBuckets.map(
          (bucket) => currentMap.get(`${bucket.date}#${bucket.hour}`) || 0,
        ),
        yesterday: previousBuckets.map(
          (bucket) => previousMap.get(`${bucket.date}#${bucket.hour}`) || 0,
        ),
      },
      timezone: resolvedTimezone,
      tz: resolvedTimezone,
    };
  }

  // Payment Split Trend — returns one bucketed (hourly or daily) series in a
  // single query instead of the frontend looping one single-total request
  // per hour/day (previously up to ~360 requests for a 90-day view). This is
  // a live aggregation over shopify_orders, same as getOrderSplit/
  // getPaymentSalesSplit's default path — no rollup table involved.
  async function getPaymentSplitTrend({
    conn,
    start,
    end,
    granularity = "daily",
    hourLte = null,
    productId = "",
    filters = {},
    includeSql = false,
    timezone = DEFAULT_TIMEZONE,
  }) {
    const resolvedTimezone = normalizeTimezone(timezone);
    const isHourly = granularity === "hourly";
    const useHourlyCutoff = isHourly && Number.isInteger(hourLte);

    if (!start || !end) {
      return {
        metric: "PAYMENT_SPLIT_TREND",
        timezone: resolvedTimezone,
        granularity,
        range: { start: null, end: null },
        points: [],
      };
    }

    // Unfiltered fast path — read directly from the daily/hourly rollup
    // tables (one row per bucket already, no payment-type pivoting needed)
    // instead of scanning shopify_orders. Any filter falls through below.
    if (isUnfilteredPaymentRequest(filters, productId)) {
      let sql;
      let rollupReplacements;
      if (isHourly) {
        sql = `
          SELECT
            date, hour,
            COALESCE(number_of_cod_orders, 0) AS cod_orders,
            COALESCE(number_of_prepaid_orders, 0) AS prepaid_orders,
            COALESCE(number_of_ppcod_orders, 0) AS partially_paid_orders,
            COALESCE(cod_sales, 0) AS cod_sales,
            COALESCE(prepaid_sales, 0) AS prepaid_sales,
            COALESCE(partially_prepaid_sales, 0) AS partial_sales
          FROM hour_wise_sales
          WHERE date >= ? AND date <= ?
          ${useHourlyCutoff ? "AND (date < ? OR hour <= ?)" : ""}
          ORDER BY date ASC, hour ASC
        `;
        rollupReplacements = useHourlyCutoff
          ? [start, end, end, hourLte]
          : [start, end];
      } else {
        sql = `
          SELECT
            date,
            COALESCE(cod_orders, 0) AS cod_orders,
            COALESCE(prepaid_orders, 0) AS prepaid_orders,
            COALESCE(partially_paid_orders, 0) AS partially_paid_orders,
            COALESCE(cod_sales, 0) AS cod_sales,
            COALESCE(prepaid_sales, 0) AS prepaid_sales,
            COALESCE(partially_prepaid_sales, 0) AS partial_sales
          FROM overall_summary
          WHERE date >= ? AND date <= ?
          ORDER BY date ASC
        `;
        rollupReplacements = [start, end];
      }

      const rollupRows = await conn.query(sql, {
        type: QueryTypes.SELECT,
        replacements: rollupReplacements,
      });

      const points = rollupRows.map((row) => {
        const cod_orders = Number(row.cod_orders || 0);
        const prepaid_orders = Number(row.prepaid_orders || 0);
        const partially_paid_orders = Number(row.partially_paid_orders || 0);
        const cod_sales = Number(row.cod_sales || 0);
        const prepaid_sales = Number(row.prepaid_sales || 0);
        const partial_sales = Number(row.partial_sales || 0);
        return {
          date: String(row.date),
          hour: isHourly ? Number(row.hour) : null,
          cod_orders,
          prepaid_orders,
          partially_paid_orders,
          cod_sales,
          prepaid_sales,
          partial_sales,
          total_orders: cod_orders + prepaid_orders + partially_paid_orders,
          total_sales: cod_sales + prepaid_sales + partial_sales,
        };
      });

      return {
        metric: "PAYMENT_SPLIT_TREND",
        timezone: resolvedTimezone,
        granularity,
        range: { start, end, hour_lte: useHourlyCutoff ? hourLte : null },
        points,
        sql_used: includeSql ? sql : undefined,
      };
    }

    let whereSql = `WHERE created_date >= ? AND created_date <= ?`;
    const replacements = [start, end];

    if (productId) {
      whereSql += ` AND product_id = ?`;
      replacements.push(productId);
    }
    if (useHourlyCutoff) {
      whereSql += ` AND (created_date < ? OR HOUR(created_time) <= ?)`;
      replacements.push(end, hourLte);
    }
    whereSql = appendUtmWhere(whereSql, replacements, filters, true);
    whereSql = appendCityOrderWhere(whereSql, replacements, filters.city);

    const bucketExpr = isHourly
      ? "created_date, HOUR(created_time)"
      : "created_date";
    const bucketSelect = isHourly
      ? "created_date AS date, HOUR(created_time) AS hour"
      : "created_date AS date";

    const sql = `
      SELECT
        date,
        ${isHourly ? "hour," : ""}
        payment_type,
        COUNT(order_name) AS order_count,
        SUM(max_price) AS sales
      FROM (
        SELECT
          ${bucketSelect},
          ${PAYMENT_TYPE_CASE_SQL} AS payment_type,
          order_name,
          MAX(total_price) AS max_price
        FROM shopify_orders
        ${whereSql}
        GROUP BY ${bucketExpr}, payment_gateway_names, order_name
      ) sub
      GROUP BY date${isHourly ? ", hour" : ""}, payment_type
      ORDER BY date ASC${isHourly ? ", hour ASC" : ""}
    `;

    const rows = await conn.query(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });

    const byBucket = new Map();
    for (const row of rows) {
      const key = isHourly ? `${row.date}#${row.hour}` : String(row.date);
      const existing = byBucket.get(key) || {
        date: String(row.date),
        hour: isHourly ? Number(row.hour) : null,
        cod_orders: 0,
        prepaid_orders: 0,
        partially_paid_orders: 0,
        cod_sales: 0,
        prepaid_sales: 0,
        partial_sales: 0,
      };
      const orders = Number(row.order_count || 0);
      const sales = Number(row.sales || 0);
      if (row.payment_type === "COD") {
        existing.cod_orders = orders;
        existing.cod_sales = sales;
      } else if (row.payment_type === "Prepaid") {
        existing.prepaid_orders = orders;
        existing.prepaid_sales = sales;
      } else if (row.payment_type === "Partial") {
        existing.partially_paid_orders = orders;
        existing.partial_sales = sales;
      }
      byBucket.set(key, existing);
    }

    const points = Array.from(byBucket.values())
      .sort((a, b) => {
        if (a.date === b.date) return (a.hour || 0) - (b.hour || 0);
        return a.date.localeCompare(b.date);
      })
      .map((point) => {
        const total_orders =
          point.cod_orders + point.prepaid_orders + point.partially_paid_orders;
        const total_sales =
          point.cod_sales + point.prepaid_sales + point.partial_sales;
        return { ...point, total_orders, total_sales };
      });

    return {
      metric: "PAYMENT_SPLIT_TREND",
      timezone: resolvedTimezone,
      granularity,
      range: { start, end, hour_lte: useHourlyCutoff ? hourLte : null },
      points,
      sql_used: includeSql ? sql : undefined,
    };
  }

  // Unfiltered-only: fetches order counts + sales amounts + current + previous
  // all in ONE query against the rollup table, instead of 4 separate calls.
  // Same conditional-SUM pattern as computeReturnCountsPair/
  // queryIntentSummaryPair earlier this session. hourLte (when set) applies
  // identically to both periods, matching getPaymentSplitSummary's existing
  // behavior of passing the same hourLte to all 4 of its underlying calls.
  async function getUnfilteredPaymentSplitPair({
    conn,
    start,
    end,
    compareStart,
    compareEnd,
    hourLte,
    timezone = DEFAULT_TIMEZONE,
  }) {
    const resolvedTimezone = normalizeTimezone(timezone);
    const useHourlyCutoff = Number.isInteger(hourLte);
    const table = useHourlyCutoff ? "hour_wise_sales" : "overall_summary";
    const orderCols = useHourlyCutoff
      ? { cod: "number_of_cod_orders", prepaid: "number_of_prepaid_orders", partial: "number_of_ppcod_orders" }
      : { cod: "cod_orders", prepaid: "prepaid_orders", partial: "partially_paid_orders" };
    const salesCols = { cod: "cod_sales", prepaid: "prepaid_sales", partial: "partially_prepaid_sales" };

    const periodCase = (periodStart, periodEnd, sourceCol, alias, params) => {
      if (useHourlyCutoff) {
        params.push(periodStart, periodEnd, periodEnd, hourLte);
        return `COALESCE(SUM(CASE WHEN date >= ? AND date <= ? AND (date < ? OR hour <= ?) THEN ${sourceCol} ELSE 0 END), 0) AS ${alias}`;
      }
      params.push(periodStart, periodEnd);
      return `COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN ${sourceCol} ELSE 0 END), 0) AS ${alias}`;
    };

    const params = [];
    const selectParts = [
      periodCase(start, end, orderCols.cod, "current_cod_orders", params),
      periodCase(start, end, orderCols.prepaid, "current_prepaid_orders", params),
      periodCase(start, end, orderCols.partial, "current_partially_paid_orders", params),
      periodCase(start, end, salesCols.cod, "current_cod_sales", params),
      periodCase(start, end, salesCols.prepaid, "current_prepaid_sales", params),
      periodCase(start, end, salesCols.partial, "current_partial_sales", params),
      periodCase(compareStart, compareEnd, orderCols.cod, "previous_cod_orders", params),
      periodCase(compareStart, compareEnd, orderCols.prepaid, "previous_prepaid_orders", params),
      periodCase(compareStart, compareEnd, orderCols.partial, "previous_partially_paid_orders", params),
      periodCase(compareStart, compareEnd, salesCols.cod, "previous_cod_sales", params),
      periodCase(compareStart, compareEnd, salesCols.prepaid, "previous_prepaid_sales", params),
      periodCase(compareStart, compareEnd, salesCols.partial, "previous_partial_sales", params),
    ];

    const sql = `
      SELECT ${selectParts.join(",\n        ")}
      FROM ${table}
      WHERE (date >= ? AND date <= ?) OR (date >= ? AND date <= ?)
    `;
    params.push(start, end, compareStart, compareEnd);

    const [row] = await conn.query(sql, { type: QueryTypes.SELECT, replacements: params });
    const n = (v) => Number(v || 0);
    const buildPeriod = (prefix) => {
      const codOrders = n(row?.[`${prefix}_cod_orders`]);
      const prepaidOrders = n(row?.[`${prefix}_prepaid_orders`]);
      const partiallyPaidOrders = n(row?.[`${prefix}_partially_paid_orders`]);
      const codSales = n(row?.[`${prefix}_cod_sales`]);
      const prepaidSales = n(row?.[`${prefix}_prepaid_sales`]);
      const partialSales = n(row?.[`${prefix}_partial_sales`]);
      const salesTotal = codSales + prepaidSales + partialSales;
      return {
        orders: computeOrderSplitPayload({
          start: prefix === "current" ? start : compareStart,
          end: prefix === "current" ? end : compareEnd,
          timezone: resolvedTimezone,
          hourLte: useHourlyCutoff ? hourLte : null,
          codOrders,
          prepaidOrders,
          partiallyPaidOrders,
        }),
        sales: {
          metric: "PAYMENT_SPLIT_SALES",
          timezone: resolvedTimezone,
          range: {
            start: prefix === "current" ? start : compareStart,
            end: prefix === "current" ? end : compareEnd,
            hour_lte: useHourlyCutoff ? hourLte : null,
          },
          cod_sales: codSales,
          prepaid_sales: prepaidSales,
          partial_sales: partialSales,
          total_sales_from_split: salesTotal,
          cod_percent: salesTotal > 0 ? (codSales / salesTotal) * 100 : 0,
          prepaid_percent: salesTotal > 0 ? (prepaidSales / salesTotal) * 100 : 0,
          partial_percent: salesTotal > 0 ? (partialSales / salesTotal) * 100 : 0,
        },
      };
    };

    return { current: buildPeriod("current"), previous: buildPeriod("previous"), sql_used: sql };
  }

  // Combines the 4 separate requests the Mode of Payment widget used to make
  // (order-count split + sales split, each for current and previous period)
  // into one round trip. When unfiltered, runs a single combined rollup
  // query (getUnfilteredPaymentSplitPair) instead of 4 calls. Any filter
  // falls back to running getOrderSplit/getPaymentSalesSplit in parallel —
  // same branch logic (discount/product-type/UTM rollups, live fallback).
  async function getPaymentSplitSummary({
    conn,
    start,
    end,
    compareStart = null,
    compareEnd = null,
    hourLte = null,
    productId = "",
    filters = {},
    includeSql = false,
    timezone = DEFAULT_TIMEZONE,
  }) {
    const hasPrevious = !!(compareStart && compareEnd);

    if (hasPrevious && isUnfilteredPaymentRequest(filters, productId)) {
      const pair = await getUnfilteredPaymentSplitPair({
        conn,
        start,
        end,
        compareStart,
        compareEnd,
        hourLte,
        timezone,
      });
      if (includeSql) {
        pair.current.orders.sql_used = pair.sql_used;
        pair.current.sales.sql_used = pair.sql_used;
        pair.previous.orders.sql_used = pair.sql_used;
        pair.previous.sales.sql_used = pair.sql_used;
      }
      return { current: pair.current, previous: pair.previous };
    }

    const [currentOrders, currentSales, previousOrders, previousSales] =
      await Promise.all([
        getOrderSplit({ conn, start, end, hourLte, productId, filters, includeSql, timezone }),
        getPaymentSalesSplit({ conn, start, end, hourLte, productId, filters, includeSql, timezone }),
        hasPrevious
          ? getOrderSplit({
              conn,
              start: compareStart,
              end: compareEnd,
              hourLte,
              productId,
              filters,
              includeSql,
              timezone,
            })
          : Promise.resolve(null),
        hasPrevious
          ? getPaymentSalesSplit({
              conn,
              start: compareStart,
              end: compareEnd,
              hourLte,
              productId,
              filters,
              includeSql,
              timezone,
            })
          : Promise.resolve(null),
      ]);

    return {
      current: { orders: currentOrders, sales: currentSales },
      previous: hasPrevious
        ? { orders: previousOrders, sales: previousSales }
        : { orders: null, sales: null },
    };
  }

  return {
    getTrafficSourceSplit,
    getPaymentSalesSplit,
    getOrderSplit,
    getPaymentSplitSummary,
    getPaymentSplitTrend,
    getHourlySalesCompare,
  };
}

module.exports = {
  buildMetricsReportService,
  resolveCompareRange,
  parseHourLte,
  buildClosedOpenTimestampRange,
  buildTimezoneBuckets,
  buildIstBuckets,
};
