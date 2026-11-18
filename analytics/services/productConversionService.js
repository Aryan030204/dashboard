const { QueryTypes } = require("sequelize");
const { normalizeRangeQuery } = require("./metricsRequestNormalizer");
const {
  buildCompletedHourCutoffContext,
  buildCompletedHourOrderCutoffTime,
} = require("./metricsFoundation");
const { shiftDays } = require("../shared/utils/date");

// hourly_product_sessions only retains a rolling window (rows older than
// this are archived to S3 and purged — see scripts/purge-hourly-product-sessions.js).
// Same env var/default used there and in duckdbQueryService.getRetentionDays().
function getHourlySessionsRetentionDays() {
  return parseInt(process.env.HOURLY_PRODUCT_SESSIONS_RETENTION_DAYS || "7", 10);
}

// Defensive ceiling for query paths where sorting/filtering happens in JS
// after the SQL fetch (inventory drr/doh sort, CSV export). These paths
// cannot use a real SQL LIMIT because the sort key isn't known to SQL, so
// this caps worst-case row count/memory instead of truncating results for
// any realistic catalog size. Live-measured product_id+landing_page_path
// pair counts (60-day window, no product-type filter) across 8 brands
// ranged up to ~96,466 (BBB) — this cap keeps >5x headroom above that
// observed max rather than truncating real data.
const UNBOUNDED_ROW_SAFETY_CAP = 500000;

const ALLOWED_SORT = new Map([
  ["sessions", "sessions"],
  ["atc", "atc"],
  ["atc_rate", "atc_rate"],
  ["ci_events", "ci_events"],
  ["checkout_rate", "checkout_rate"],
  ["orders", "orders"],
  ["sales", "sales"],
  ["cvr", "cvr"],
  ["landing_page_path", "landing_page_path"],
]);

const VALID_FILTER_FIELDS = new Set([
  "sessions",
  "atc",
  "atc_rate",
  "ci_events",
  "checkout_rate",
  "orders",
  "sales",
  "cvr",
  "drr",
  "doh",
]);

const CSV_HEADERS = [
  "landing_page_path",
  "sessions",
  "atc",
  "atc_rate",
  "ci_events",
  "checkout_rate",
  "orders",
  "sales",
  "cvr",
  "drr",
  "doh",
];

const PREVIOUS_HEADER_MAP = {
  sessions: "prev_sessions",
  atc: "prev_atc",
  atc_rate: "prev_atc_rate",
  ci_events: "prev_ci_events",
  checkout_rate: "prev_checkout_rate",
  orders: "prev_orders",
  sales: "prev_sales",
  cvr: "prev_cvr",
};

// Collection/PLP CVR (V1) lives in its own daily aggregate, built by
// products-pipeline-ec2 (mv_collection_sessions_by_path_daily). Collection
// rows have no product_id, so they never use the product-based orders join.
const COLLECTION_MV_TABLE = "mv_collection_sessions_by_path_daily";
// Same key the MV stores: lowercase, no trailing slash.
const COLLECTION_PATH_KEY = "LOWER(TRIM(TRAILING '/' FROM s.landing_page_path))";

function isMissingCollectionMvError(err) {
  const e = (err && (err.original || err.parent)) || err || {};
  const message = String(e.message || (err && err.message) || "");
  return (
    (e.code === "ER_NO_SUCH_TABLE" || e.errno === 1146) &&
    message.includes(COLLECTION_MV_TABLE)
  );
}

let defaultRedisClient;

function getDefaultRedisClient() {
  if (defaultRedisClient === undefined) {
    defaultRedisClient = require("../shared/db/redis");
  }
  return defaultRedisClient;
}

function hasCompareRange(spec) {
  return !!(spec.compareStart && spec.compareEnd);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeRequestFilters(query) {
  let filters = parseJsonArray(query.filters);
  const singleField = (query.filter_field || "").toString().toLowerCase();
  if (filters.length === 0 && singleField) {
    filters = [
      {
        field: singleField,
        operator: (query.filter_operator || "").toString().toLowerCase(),
        value: query.filter_value,
      },
    ];
  }
  return filters;
}

function buildMetricFilterExpression(field, withCollection = false) {
  switch (field) {
    case "sessions":
      return "s.sessions";
    case "atc":
      return "s.atc";
    case "atc_rate":
      return "(CASE WHEN s.sessions > 0 THEN s.atc / s.sessions * 100 ELSE 0 END)";
    case "ci_events":
      return "COALESCE(c.ci_events, 0)";
    case "checkout_rate":
      return "(CASE WHEN s.sessions > 0 THEN COALESCE(c.ci_events, 0) / s.sessions * 100 ELSE 0 END)";
    case "orders":
      return withCollection ? "COALESCE(o.orders, cc.orders, 0)" : "COALESCE(o.orders, 0)";
    case "sales":
      return "COALESCE(o.sales, 0)";
    case "cvr":
      return withCollection
        ? "(CASE WHEN cc.collection_path IS NOT NULL THEN (CASE WHEN cc.sessions > 0 THEN cc.orders / cc.sessions * 100 ELSE 0 END) WHEN s.sessions > 0 THEN COALESCE(o.orders, 0) / s.sessions * 100 ELSE 0 END)"
        : "(CASE WHEN s.sessions > 0 THEN COALESCE(o.orders, 0) / s.sessions * 100 ELSE 0 END)";
    default:
      return "";
  }
}

function normalizeProductConversionRequest(query, options = {}) {
  const range = normalizeRangeQuery(query, {
    defaultToToday: true,
    allowDateAlias: false,
    timezone: options.timezone,
  });
  if (!range.ok) {
    return range;
  }
  const { start, end } = range.data;

  const inventoryOnly =
    String(query.inventory_only || query.inventoryOnly || "")
      .toLowerCase()
      .trim() === "true";
  const defaultSortBy = inventoryOnly ? "sales" : "sessions";
  let sortBy = (query.sort_by || defaultSortBy).toString().toLowerCase();
  // Sorting by drr/doh is no longer supported (they're Redis-derived, not SQL
  // columns) — fall back to the default rather than triggering the unbounded
  // JS-side sort path.
  if (sortBy === "drr" || sortBy === "doh") sortBy = defaultSortBy;
  const sortDir = (query.sort_dir || "desc").toString().toLowerCase();
  let visibleColumns = query.visible_columns;
  if (typeof visibleColumns === "string") {
    try {
      visibleColumns = JSON.parse(visibleColumns);
    } catch {
      visibleColumns = null;
    }
  }

  return {
    ok: true,
    spec: {
      start,
      end,
      page: Math.max(1, Number(query.page) || 1),
      pageSize: Math.min(Math.max(1, Number(query.page_size) || 10), 200),
      sortBy,
      sortCol: ALLOWED_SORT.get(sortBy) || "sessions",
      sortDir: sortDir === "asc" ? "ASC" : "DESC",
      search: (query.search || "").trim(),
      filters: normalizeRequestFilters(query),
      productTypes: parseJsonArray(query.product_types),
      pageTypes: parseJsonArray(query.page_types),
      compareStart: query.compare_start || null,
      compareEnd: query.compare_end || null,
      visibleColumns: Array.isArray(visibleColumns) ? visibleColumns : null,
      inventoryPeriod: (query.inventory_period || "7d").toLowerCase(),
      brandKey: query.brand_key,
      inventoryOnly,
      timezone: range.timezone || options.timezone,
    },
  };
}

function buildProductConditions(spec, baseAlias, withCollection = false) {
  const conditions = [];
  const replacements = [];

  if (spec.search) {
    conditions.push(`${baseAlias}.landing_page_path LIKE ?`);
    replacements.push(`%${spec.search}%`);
  }

  if (Array.isArray(spec.pageTypes) && spec.pageTypes.length > 0) {
    const typeConditions = [];
    for (const type of spec.pageTypes) {
      if (type === "Product") {
        typeConditions.push(`${baseAlias}.landing_page_path LIKE '%products/%'`);
      } else if (type === "Collection") {
        typeConditions.push(`${baseAlias}.landing_page_path LIKE '%collections/%'`);
      }
    }
    if (typeConditions.length > 0) {
      conditions.push(`(${typeConditions.join(" OR ")})`);
    }
  }

  if (Array.isArray(spec.filters) && spec.filters.length > 0) {
    for (const filter of spec.filters) {
      const field = (filter.field || "").toString().toLowerCase();
      const operator = (filter.operator || "").toString().toLowerCase();
      const value = Number(filter.value);
      if (
        !VALID_FILTER_FIELDS.has(field) ||
        (operator !== "gt" && operator !== "lt") ||
        Number.isNaN(value)
      ) {
        continue;
      }
      const expression = buildMetricFilterExpression(field, withCollection);
      if (!expression) continue;
      conditions.push(`${expression} ${operator === "gt" ? ">" : "<"} ?`);
      replacements.push(value);
    }
  }

  if (Array.isArray(spec.productTypes) && spec.productTypes.length > 0) {
    conditions.push(`m.product_type IN (?)`);
    replacements.push(spec.productTypes);
  }

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    replacements,
  };
}

function buildBaseCte(spec, includeCompare = false, withCollection = false) {
  const cutoffCtx =
    includeCompare && hasCompareRange(spec)
      ? buildCompletedHourCutoffContext(spec.start, spec.end, new Date(), spec.timezone)
      : {
          currentRangeIncludesToday: false,
          cutoffHour: 23,
          orderCutoffTime: "24:00:00",
        };
  const currentRangeIncludesToday = !!cutoffCtx.currentRangeIncludesToday;
  const completedOrderCutoffTime = currentRangeIncludesToday
    ? buildCompletedHourOrderCutoffTime(cutoffCtx.cutoffHour)
    : null;
  const baseSql = `
    WITH orders_60d AS (
      SELECT
        product_id,
        COUNT(DISTINCT order_name) AS orders,
        SUM((line_item_price * line_item_quantity) - COALESCE(discount_amount_per_line_item, 0)) AS sales
      FROM shopify_orders
      WHERE created_date >= ? AND created_date <= ?
        ${currentRangeIncludesToday ? "AND (created_date < ? OR created_time < ?)" : ""}
        AND product_id IS NOT NULL
      GROUP BY product_id
    ),
    product_variant_map AS (
      SELECT
        variant_id,
        MAX(product_id) AS product_id
      FROM shopify_orders
      WHERE variant_id IS NOT NULL
        AND product_id IS NOT NULL
      GROUP BY variant_id
    ),
    ci_60d AS (
      SELECT
        pvm.product_id,
        SUM(COALESCE(d.checkout_initiated_count, 0)) AS ci_events
      FROM daily_ci_events_summary d
      JOIN product_variant_map pvm ON pvm.variant_id = d.variant_id
      WHERE d.date >= ? AND d.date <= ?
      GROUP BY pvm.product_id
    ),
    sessions_60d AS (
      SELECT
        product_id,
        landing_page_path,
        SUM(sessions) AS sessions,
        SUM(sessions_with_cart_additions) AS atc
      FROM ${currentRangeIncludesToday ? "hourly_product_sessions" : "mv_product_sessions_by_path_daily"}
      WHERE date >= ? AND date <= ?
        ${currentRangeIncludesToday ? "AND (date < ? OR hour <= ?)" : ""}
      GROUP BY product_id, landing_page_path
    )
    ${
      withCollection
        ? `,
    collection_cvr_60d AS (
      SELECT
        collection_path,
        SUM(sessions) AS sessions,
        SUM(orders) AS orders
      FROM ${COLLECTION_MV_TABLE}
      WHERE date >= ? AND date <= ?
      GROUP BY collection_path
    )`
        : ""
    }
  `;

  if (!includeCompare || !hasCompareRange(spec)) {
    return {
      sql: baseSql,
      replacements: currentRangeIncludesToday
        ? [
            spec.start,
            spec.end,
            spec.end,
            completedOrderCutoffTime,
            spec.start,
            spec.end,
            spec.start,
            spec.end,
            spec.end,
            cutoffCtx.cutoffHour,
            ...(withCollection ? [spec.start, spec.end] : []),
          ]
        : [
            spec.start,
            spec.end,
            spec.start,
            spec.end,
            spec.start,
            spec.end,
            ...(withCollection ? [spec.start, spec.end] : []),
          ],
    };
  }

  // The previous/compare period can fall well outside hourly_product_sessions'
  // retention window even when the CURRENT period includes today (the common
  // case). Reusing currentRangeIncludesToday for previous_sessions' table
  // choice was the bug: it forced old compare ranges through a table that no
  // longer has their rows (purged/archived), silently returning 0 sessions
  // for every landing page instead of falling back to the full-history daily
  // rollup. Gate it on the compare range's own recency instead.
  const hourlyRetentionCutoffDate = currentRangeIncludesToday
    ? shiftDays(cutoffCtx.today, -getHourlySessionsRetentionDays())
    : null;
  const previousWithinHourlyRetention =
    currentRangeIncludesToday &&
    !!spec.compareEnd &&
    spec.compareEnd >= hourlyRetentionCutoffDate;

  const ordersReplacements = currentRangeIncludesToday
    ? [spec.start, spec.end, spec.end, completedOrderCutoffTime]
    : [spec.start, spec.end];
  const ciReplacements = [spec.start, spec.end];
  const sessionsReplacements = currentRangeIncludesToday
    ? [spec.start, spec.end, spec.end, cutoffCtx.cutoffHour]
    : [spec.start, spec.end];
  const previousOrdersReplacements = currentRangeIncludesToday
    ? [spec.compareStart, spec.compareEnd, spec.compareEnd, completedOrderCutoffTime]
    : [spec.compareStart, spec.compareEnd];
  const previousCiReplacements = [spec.compareStart, spec.compareEnd];
  const previousSessionsReplacements = previousWithinHourlyRetention
    ? [spec.compareStart, spec.compareEnd, spec.compareEnd, cutoffCtx.cutoffHour]
    : [spec.compareStart, spec.compareEnd];
  const collectionReplacements = withCollection ? [spec.start, spec.end] : [];
  const previousCollectionReplacements = withCollection
    ? [spec.compareStart, spec.compareEnd]
    : [];

  return {
    sql: `
      ${baseSql},
      previous_orders AS (
        SELECT
          product_id,
          COUNT(DISTINCT order_name) AS orders,
          SUM((line_item_price - COALESCE(discount_amount_per_line_item, 0)) * line_item_quantity) AS sales
        FROM shopify_orders
        WHERE created_date >= ? AND created_date <= ?
          ${currentRangeIncludesToday ? "AND (created_date < ? OR created_time < ?)" : ""}
          AND product_id IS NOT NULL
        GROUP BY product_id
      ),
      previous_ci AS (
        SELECT
          pvm.product_id,
          SUM(COALESCE(d.checkout_initiated_count, 0)) AS ci_events
        FROM daily_ci_events_summary d
        JOIN product_variant_map pvm ON pvm.variant_id = d.variant_id
        WHERE d.date >= ? AND d.date <= ?
        GROUP BY pvm.product_id
      ),
      previous_sessions AS (
        SELECT
          product_id,
          landing_page_path,
          SUM(sessions) AS sessions,
          SUM(sessions_with_cart_additions) AS atc
        FROM ${
          previousWithinHourlyRetention
            ? "hourly_product_sessions"
            : "mv_product_sessions_by_path_daily"
        }
        WHERE date >= ? AND date <= ?
          ${previousWithinHourlyRetention ? "AND (date < ? OR hour <= ?)" : ""}
        GROUP BY product_id, landing_page_path
      )${
        withCollection
          ? `,
      previous_collection_cvr AS (
        SELECT
          collection_path,
          SUM(sessions) AS sessions,
          SUM(orders) AS orders
        FROM ${COLLECTION_MV_TABLE}
        WHERE date >= ? AND date <= ?
        GROUP BY collection_path
      )`
          : ""
      }
    `,
    replacements: [
      ...ordersReplacements,
      ...ciReplacements,
      ...sessionsReplacements,
      ...collectionReplacements,
      ...previousOrdersReplacements,
      ...previousCiReplacements,
      ...previousSessionsReplacements,
      ...previousCollectionReplacements,
    ],
  };
}

function buildSelectSql(
  spec,
  useMappingBase,
  whereClause,
  sortCol,
  sortDir,
  pagination,
  includeTotalCount = false,
  withCollection = false,
) {
  const includeCompare = hasCompareRange(spec);
  // Collection rows have no product_id, so the collection aggregate is only
  // joined on the sessions-based listing (never the product-mapping base).
  const collectionOn = withCollection && !useMappingBase;
  const base = buildBaseCte(spec, includeCompare, collectionOn);
  const previousSelect = includeCompare
    ? `,
        COALESCE(ps.sessions, 0) AS prev_sessions,
        COALESCE(ps.atc, 0) AS prev_atc,
        CASE WHEN ps.sessions > 0 THEN ROUND(ps.atc / ps.sessions * 100, 4) ELSE 0 END AS prev_atc_rate,
        COALESCE(pc.ci_events, 0) AS prev_ci_events,
        CASE WHEN ps.sessions > 0 THEN ROUND(COALESCE(pc.ci_events, 0) / ps.sessions * 100, 4) ELSE 0 END AS prev_checkout_rate,
        ${collectionOn ? "COALESCE(po.orders, pcc.orders, 0)" : "COALESCE(po.orders, 0)"} AS prev_orders,
        COALESCE(po.sales, 0) AS prev_sales,
        ${
          collectionOn
            ? "CASE WHEN pcc.collection_path IS NOT NULL THEN (CASE WHEN pcc.sessions > 0 THEN ROUND(pcc.orders / pcc.sessions * 100, 4) ELSE 0 END) WHEN ps.sessions > 0 THEN ROUND(COALESCE(po.orders, 0) / ps.sessions * 100, 4) ELSE 0 END"
            : "CASE WHEN ps.sessions > 0 THEN ROUND(COALESCE(po.orders, 0) / ps.sessions * 100, 4) ELSE 0 END"
        } AS prev_cvr`
    : "";
  const previousJoins = includeCompare
    ? `
      LEFT JOIN previous_sessions ps ON ${useMappingBase ? "m.landing_page_path" : "s.landing_page_path"} = ps.landing_page_path
      LEFT JOIN previous_ci pc ON ${useMappingBase ? "m.product_id" : "s.product_id"} = pc.product_id
      LEFT JOIN previous_orders po ON ${useMappingBase ? "m.product_id" : "s.product_id"} = po.product_id
      ${
        collectionOn
          ? `LEFT JOIN previous_collection_cvr pcc ON s.product_id IS NULL AND pcc.collection_path = ${COLLECTION_PATH_KEY}`
          : ""
      }
    `
    : "";
  const ordersExpr = collectionOn
    ? "COALESCE(o.orders, cc.orders, 0)"
    : "COALESCE(o.orders, 0)";
  // PDP rows (cc.collection_path IS NULL) take the untouched branch.
  const cvrExpr = collectionOn
    ? `CASE
          WHEN cc.collection_path IS NOT NULL
            THEN (CASE WHEN cc.sessions > 0 THEN ROUND(cc.orders / cc.sessions * 100, 4) ELSE 0 END)
          WHEN s.sessions > 0 THEN ROUND(COALESCE(o.orders, 0) / s.sessions * 100, 4)
          ELSE 0
        END`
    : "CASE WHEN s.sessions > 0 THEN ROUND(COALESCE(o.orders, 0) / s.sessions * 100, 4) ELSE 0 END";
  const collectionJoin = collectionOn
    ? `LEFT JOIN collection_cvr_60d cc ON s.product_id IS NULL AND cc.collection_path = ${COLLECTION_PATH_KEY}`
    : "";
  const inventoryCol = `
    NULL AS drr,
    NULL AS doh,
    NULL AS variant_id,
    NULL AS updated_at
  `;
  // Folds the pagination count into this query via a window function (MySQL
  // 8.0+) instead of running buildCountSql as a separate round trip that
  // redundantly re-derives the same CTEs.
  const totalCountCol = includeTotalCount ? `, COUNT(*) OVER() AS total_count` : "";

  const selectPrefix = useMappingBase
    ? `
      SELECT
        m.product_id,
        m.landing_page_path,
        COALESCE(s.sessions, 0) AS sessions,
        COALESCE(s.atc, 0) AS atc,
        CASE WHEN s.sessions > 0 THEN ROUND(s.atc / s.sessions * 100, 4) ELSE 0 END AS atc_rate,
        COALESCE(c.ci_events, 0) AS ci_events,
        CASE WHEN s.sessions > 0 THEN ROUND(COALESCE(c.ci_events, 0) / s.sessions * 100, 4) ELSE 0 END AS checkout_rate,
        COALESCE(o.orders, 0) AS orders,
        COALESCE(o.sales, 0) AS sales,
        CASE WHEN s.sessions > 0 THEN ROUND(COALESCE(o.orders, 0) / s.sessions * 100, 4) ELSE 0 END AS cvr,
        ${inventoryCol}
        ${previousSelect}
        ${totalCountCol}
      FROM product_landing_mapping m
      LEFT JOIN sessions_60d s ON m.landing_page_path = s.landing_page_path
      LEFT JOIN ci_60d c ON m.product_id = c.product_id
      LEFT JOIN orders_60d o ON m.product_id = o.product_id
      ${previousJoins}
    `
    : `
      SELECT
        s.product_id,
        s.landing_page_path,
        s.sessions,
        s.atc,
        CASE WHEN s.sessions > 0 THEN ROUND(s.atc / s.sessions * 100, 4) ELSE 0 END AS atc_rate,
        COALESCE(c.ci_events, 0) AS ci_events,
        CASE WHEN s.sessions > 0 THEN ROUND(COALESCE(c.ci_events, 0) / s.sessions * 100, 4) ELSE 0 END AS checkout_rate,
        ${ordersExpr} AS orders,
        COALESCE(o.sales, 0) AS sales,
        ${cvrExpr} AS cvr,
        ${inventoryCol}
        ${previousSelect}
        ${totalCountCol}
      FROM sessions_60d s
      LEFT JOIN ci_60d c ON s.product_id = c.product_id
      LEFT JOIN orders_60d o ON s.product_id = o.product_id
      ${collectionJoin}
      ${previousJoins}
    `;
  const limitClause = pagination
    ? ` LIMIT ${pagination.pageSize} OFFSET ${(pagination.page - 1) * pagination.pageSize}`
    : "";
  return {
    sql: `
      ${base.sql}
      ${selectPrefix}
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      ${limitClause}
    `,
    replacements: [...base.replacements],
  };
}

function normalizeRows(rows, includeCompare = false) {
  return rows.map((row) => ({
    product_id: row.product_id || null,
    landing_page_path: row.landing_page_path || "",
    sessions: Number(row.sessions || 0),
    atc: Number(row.atc || 0),
    atc_rate: Number(row.atc_rate || 0),
    ci_events: Number(row.ci_events || 0),
    checkout_rate: Number(row.checkout_rate || 0),
    orders: Number(row.orders || 0),
    sales: Number(row.sales || 0),
    cvr: Number(row.cvr || 0),
    drr: row.drr !== null && row.drr !== undefined ? Number(row.drr) : null,
    doh: row.doh !== null && row.doh !== undefined ? Number(row.doh) : null,
    variant_id: row.variant_id || null,
    updated_at: row.updated_at || null,
    calculation_date: row.calculation_date || null,
    previous: includeCompare
      ? {
        sessions: Number(row.prev_sessions || 0),
        atc: Number(row.prev_atc || 0),
        atc_rate: Number(row.prev_atc_rate || 0),
        ci_events: Number(row.prev_ci_events || 0),
        checkout_rate: Number(row.prev_checkout_rate || 0),
        orders: Number(row.prev_orders || 0),
        sales: Number(row.prev_sales || 0),
        cvr: Number(row.prev_cvr || 0),
        }
      : null,
  }));
}

function buildCsvHeaders(visibleColumns, includeCompare) {
  const requestedHeaders =
    Array.isArray(visibleColumns) && visibleColumns.length > 0
      ? CSV_HEADERS.filter(
          (header) =>
            visibleColumns.includes(header) || header === "landing_page_path",
        )
      : CSV_HEADERS;
  if (!includeCompare) {
    return requestedHeaders;
  }
  const previousHeaders = requestedHeaders
    .filter((header) => PREVIOUS_HEADER_MAP[header])
    .map((header) => PREVIOUS_HEADER_MAP[header]);
  return [...requestedHeaders, ...previousHeaders];
}

function escapeCsv(value) {
  if (value === null || value === undefined) return "";
  const stringValue = String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function buildCsvContent(rows, headers) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    const values = headers.map((header) => {
      if (header === "landing_page_path") {
        return escapeCsv(row.landing_page_path);
      }
      if (header.startsWith("prev_")) {
        const previousKey = header.replace(/^prev_/, "");
        return Number(row.previous?.[previousKey] || 0);
      }
      return Number(row[header] || 0);
    });
    lines.push(values.join(","));
  }
  return lines.join("\n");
}

function extractNumericId(value, resourceName) {
  if (value === null || value === undefined) return "";
  const stringValue = String(value);
  if (!resourceName) return stringValue;
  const marker = `gid://shopify/${resourceName}/`;
  return stringValue.startsWith(marker) ? stringValue.slice(marker.length) : stringValue;
}

function applyInventoryFilters(rows, filters) {
  if (!Array.isArray(filters) || filters.length === 0) return rows;
  return rows.filter((row) =>
    filters.every((filter) => {
      const field = (filter.field || "").toString().toLowerCase();
      if (field !== "drr" && field !== "doh") return true;
      const operator = (filter.operator || "").toString().toLowerCase();
      const value = Number(filter.value);
      if ((operator !== "gt" && operator !== "lt") || Number.isNaN(value)) return true;
      const actual = Number(row[field] || 0);
      return operator === "gt" ? actual > value : actual < value;
    }),
  );
}

function sortRows(rows, sortBy, sortDir) {
  const factor = sortDir === "ASC" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = a?.[sortBy];
    const right = b?.[sortBy];
    if (left === right) return 0;
    if (left === null || left === undefined) return 1;
    if (right === null || right === undefined) return -1;
    if (typeof left === "number" && typeof right === "number") {
      return (left - right) * factor;
    }
    return String(left).localeCompare(String(right)) * factor;
  });
}

function applySearch(rows, search) {
  const needle = String(search || "").trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) =>
    String(row.landing_page_path || "").toLowerCase().includes(needle) ||
    String(row.sku || "").toLowerCase().includes(needle),
  );
}

function hasInventoryDerivedFilter(filters) {
  if (!Array.isArray(filters) || filters.length === 0) return false;
  return filters.some((filter) => {
    const field = (filter.field || "").toString().toLowerCase();
    return field === "drr" || field === "doh";
  });
}

function buildInventoryGroupKey({ sku, variantId, productId, fallbackKey }) {
  const normalizedSku = String(sku || "").trim();
  if (normalizedSku) return `sku:${normalizedSku.toLowerCase()}`;
  return `variant:${variantId || productId || fallbackKey}`;
}

function buildInventorySalesLookup(rawSalesCache) {
  const groupedSales = new Map();
  const addSale = (groupKey, amount) => {
    const numericAmount = Number(amount || 0);
    if (!groupKey || !Number.isFinite(numericAmount)) return;
    groupedSales.set(groupKey, Number(groupedSales.get(groupKey) || 0) + numericAmount);
  };

  if (!rawSalesCache) return groupedSales;

  let parsedSales;
  try {
    parsedSales = JSON.parse(rawSalesCache);
  } catch {
    return groupedSales;
  }

  const extractSalesRows = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.rows)) return value.rows;
    if (Array.isArray(value?.data)) return value.data;
    if (Array.isArray(value?.items)) return value.items;
    if (Array.isArray(value?.products)) return value.products;
    if (typeof value === "object") {
      return Object.values(value).filter((entry) => entry && typeof entry === "object");
    }
    return [];
  };

  const topLevelRows = extractSalesRows(parsedSales);

  topLevelRows.forEach((row, rowIndex) => {
    const fallbackKey = `sales:${rowIndex}`;
    const sourceRows = Array.isArray(row?.source_rows) && row.source_rows.length > 0
      ? row.source_rows
      : [row];

    sourceRows.forEach((sourceRow, sourceIndex) => {
      const productId =
        extractNumericId(sourceRow?.product_id ?? row?.product_id, "Product") || null;
      const variantId =
        extractNumericId(
          sourceRow?.product_variant_id ?? row?.product_variant_id,
          "ProductVariant",
        ) || null;
      const sku = String(
        sourceRow?.product_variant_sku ??
          sourceRow?.sku ??
          row?.product_variant_sku ??
          row?.sku ??
          "",
      ).trim();
      const amount =
        sourceRow?.gross_sales ??
        sourceRow?.sales ??
        row?.gross_sales ??
        row?.sales ??
        0;
      const groupKey = buildInventoryGroupKey({
        sku,
        variantId,
        productId,
        fallbackKey: `${fallbackKey}:${sourceIndex}`,
      });
      addSale(groupKey, amount);
    });
  });

  return groupedSales;
}

async function getInventoryTopProductSalesCache(redisClient, shopName) {
  if (!redisClient || !shopName) return null;

  const normalizedShopName = String(shopName || "").trim();
  if (!normalizedShopName) return null;

  const candidates = normalizedShopName.includes(".")
    ? [
        `inventory_top_product_sales:${normalizedShopName}`,
        `inventory_top_product_sales:${normalizedShopName.replace(/\.myshopify\.com$/i, "")}`,
      ]
    : [
        `inventory_top_product_sales:${normalizedShopName}`,
        `inventory_top_product_sales:${normalizedShopName}.myshopify.com`,
      ];

  for (const key of candidates) {
    const value = await redisClient.get(key);
    if (value) return value;
  }

  const scanPatterns = normalizedShopName.includes(".")
    ? [
        `inventory_top_product_sales:*${normalizedShopName}*`,
        `inventory_top_product_sales:*${normalizedShopName.replace(/\.myshopify\.com$/i, "")}*`,
      ]
    : [
        `inventory_top_product_sales:*${normalizedShopName}*`,
        `inventory_top_product_sales:*${normalizedShopName}.myshopify.com*`,
      ];

  for (const pattern of scanPatterns) {
    let cursor = "0";
    do {
      const result = await redisClient.scan(cursor, "MATCH", pattern, "COUNT", 50);
      cursor = result[0];
      const keys = Array.isArray(result[1]) ? result[1] : [];
      for (const key of keys) {
        const value = await redisClient.get(key);
        if (value) return value;
      }
    } while (cursor !== "0");
  }

  return null;
}

async function getShopInventoryCache(redisClient, shopName) {
  if (!redisClient || !shopName) return null;

  const normalizedShopName = String(shopName || "").trim();
  if (!normalizedShopName) return null;

  const candidates = normalizedShopName.includes(".")
    ? [
        `Inventory_cache:${normalizedShopName}`,
        `Inventory_cache:${normalizedShopName.replace(/\.myshopify\.com$/i, "")}`,
      ]
    : [
        `Inventory_cache:${normalizedShopName}`,
        `Inventory_cache:${normalizedShopName}.myshopify.com`,
      ];

  for (const key of candidates) {
    const value = await redisClient.get(key);
    if (!value) continue;
    try {
      const parsed = JSON.parse(value);
      return {
        items: Array.isArray(parsed?.items) ? parsed.items : [],
        cachedAt: parsed?.cached_at || null,
      };
    } catch (_err) {
      return null;
    }
  }

  return null;
}

function buildProductConversionService() {
  async function getInventoryOnlyRowsFromRedis(spec, resolveShopSubdomain) {
    const redisClient = getDefaultRedisClient();
    if (!redisClient || !resolveShopSubdomain) return [];

    const brandKey = spec.brandKey || "";
    const shopName = resolveShopSubdomain(brandKey);
    if (!shopName) return [];

    const period = spec.inventoryPeriod; // e.g. "7d", "30d", "90d" — matches drr_/doh_ field suffixes

    try {
      const [shopCache, rawSalesCache] = await Promise.all([
        getShopInventoryCache(redisClient, shopName),
        getInventoryTopProductSalesCache(redisClient, shopName),
      ]);

      if (!shopCache || shopCache.items.length === 0) return [];

      const salesLookup = buildInventorySalesLookup(rawSalesCache);
      const grouped = new Map();

      shopCache.items.forEach((parsed, index) => {
        if (!parsed) return;
        try {
          const sku = String(parsed.sku || "").trim();
          const variantId = parsed.variant_id || null;
          const productId = extractNumericId(parsed.product_id, "Product") || null;
          const groupKey = buildInventoryGroupKey({
            sku,
            variantId,
            productId,
            fallbackKey: `inventory:${index}`,
          });
          const drr = Number(parsed[`drr_${period}`] ?? 0);
          const liveQty = Number(parsed.inventory_available ?? 0);
          const sales = Number(salesLookup.get(groupKey) || 0);

          if (!grouped.has(groupKey)) {
            grouped.set(groupKey, {
              product_id: productId,
              landing_page_path: parsed.product_title || "",
              productTitles: new Set(parsed.product_title ? [parsed.product_title] : []),
              sessions: 0,
              atc: 0,
              atc_rate: 0,
              orders: 0,
              sales,
              cvr: 0,
              drr: drr,
              liveQty,
              variant_id: variantId,
              sku,
              updated_at: parsed.updated_at || null,
              calculation_date: shopCache.cachedAt || null,
              previous: null,
            });
            return;
          }

          const current = grouped.get(groupKey);
          if (parsed.product_title) current.productTitles.add(parsed.product_title);
          current.drr += drr;
          current.liveQty += liveQty;
          if (!current.product_id && productId) current.product_id = productId;
          if (!current.variant_id && variantId) current.variant_id = variantId;
          if (!current.updated_at || (parsed.updated_at && parsed.updated_at > current.updated_at)) {
            current.updated_at = parsed.updated_at || current.updated_at;
          }
        } catch (_err) {
          // ignore invalid cache entry
        }
      });

      return Array.from(grouped.values()).map((row) => {
        const titles = Array.from(row.productTitles).filter(Boolean);
        const primaryTitle = titles[0] || row.landing_page_path || "";
        return {
          product_id: row.product_id,
          landing_page_path:
            titles.length > 1 ? `${primaryTitle} (+${titles.length - 1} more)` : primaryTitle,
          sessions: row.sessions,
          atc: row.atc,
          atc_rate: row.atc_rate,
          orders: row.orders,
          sales: row.sales,
          cvr: row.cvr,
          drr: Number(row.drr || 0),
          doh: row.drr > 0 ? Number(row.liveQty / row.drr) : 0,
          variant_id: row.variant_id,
          sku: row.sku,
          updated_at: row.updated_at,
          calculation_date: row.calculation_date,
          previous: row.previous,
        };
      });
    } catch (error) {
      console.error("[Redis Inventory Only Error]", error);
      return [];
    }
  }

  async function enrichWithRedis(rows, spec, resolveShopSubdomain) {
    if (!resolveShopSubdomain) return rows;
    const redisClient = getDefaultRedisClient();
    if (!redisClient) return rows;

    const brandKey = spec.brandKey || "";
    const shopName = resolveShopSubdomain(brandKey);
    if (!shopName) return rows;

    const period = spec.inventoryPeriod; // e.g. "7d", "30d", "90d" — matches drr_/doh_ field suffixes

    try {
      const shopCache = await getShopInventoryCache(redisClient, shopName);
      if (!shopCache || shopCache.items.length === 0) return rows;

      const cacheMap = new Map();
      shopCache.items.forEach((parsed) => {
        if (!parsed) return;
        try {
          const productId = extractNumericId(parsed.product_id, "Product");
          if (!productId || cacheMap.has(productId)) return;
          cacheMap.set(productId, parsed);
        } catch (_err) {
          // ignore invalid cache entries
        }
      });

      return rows.map(row => {
        const productId = extractNumericId(row.product_id);
        const metrics = cacheMap.get(productId);
        if (!metrics) return row;

        return {
          ...row,
          drr: metrics[`drr_${period}`] ?? row.drr,
          doh: metrics[`doh_${period}`] ?? row.doh,
          variant_id: metrics.variant_id || row.variant_id,
          updated_at: metrics.updated_at || row.updated_at,
          calculation_date: shopCache.cachedAt || row.calculation_date,
        };
      });
    } catch (error) {
      console.error("[Redis Enrich Error]", error);
      return rows;
    }
  }

  // Runs the product-conversion SELECT. The collection aggregate is optional
  // at rollout time: if its table does not exist yet (dashboard deployed
  // before products-pipeline created it), re-run the unchanged legacy SQL.
  async function runSelectWithCollectionFallback(
    spec,
    useMappingBase,
    baseAlias,
    pagination,
    includeTotalCount,
  ) {
    const attempt = async (withCollection) => {
      const built = buildProductConditions(
        spec,
        baseAlias,
        withCollection && !useMappingBase,
      );
      const selectBuilt = buildSelectSql(
        spec,
        useMappingBase,
        built.whereClause,
        spec.sortCol,
        spec.sortDir,
        pagination,
        includeTotalCount,
        withCollection,
      );
      return spec.conn.query(selectBuilt.sql, {
        type: QueryTypes.SELECT,
        replacements: [...selectBuilt.replacements, ...built.replacements],
      });
    };
    try {
      return await attempt(true);
    } catch (err) {
      if (!isMissingCollectionMvError(err)) throw err;
      return attempt(false);
    }
  }

  async function getProductConversion(spec) {
    if (spec.inventoryOnly) {
      const redisRows = await getInventoryOnlyRowsFromRedis(spec, spec.resolveShopSubdomain);
      const searched = applySearch(redisRows, spec.search);
      const filtered = applyInventoryFilters(searched, spec.filters);
      const sorted = sortRows(filtered, spec.sortBy, spec.sortDir);
      const paged = sorted.slice(
        (spec.page - 1) * spec.pageSize,
        (spec.page - 1) * spec.pageSize + spec.pageSize,
      );

      return {
        range: { start: spec.start, end: spec.end },
        timezone: spec.timezone,
        page: spec.page,
        page_size: spec.pageSize,
        total_count: sorted.length,
        rows: paged,
        sort: { by: spec.sortBy, dir: spec.sortDir.toLowerCase() },
      };
    }

    const useMappingBase =
      Array.isArray(spec.productTypes) && spec.productTypes.length > 0;
    const baseAlias = useMappingBase ? "m" : "s";
    const needsInventoryPostProcessing = hasInventoryDerivedFilter(spec.filters);

    if (!needsInventoryPostProcessing) {
      const rowsRaw = await runSelectWithCollectionFallback(
        spec,
        useMappingBase,
        baseAlias,
        { page: spec.page, pageSize: spec.pageSize },
        true,
      );
      const totalCount = rowsRaw.length > 0 ? Number(rowsRaw[0].total_count || 0) : 0;

      const rows = normalizeRows(rowsRaw, hasCompareRange(spec));
      const enriched = await enrichWithRedis(rows, spec, spec.resolveShopSubdomain);

      return {
        range: { start: spec.start, end: spec.end },
        timezone: spec.timezone,
        page: spec.page,
        page_size: spec.pageSize,
        total_count: totalCount,
        rows: enriched,
        sort: { by: spec.sortBy, dir: spec.sortDir.toLowerCase() },
      };
    }

    const rowsRaw = await runSelectWithCollectionFallback(
      spec,
      useMappingBase,
      baseAlias,
      { page: 1, pageSize: UNBOUNDED_ROW_SAFETY_CAP },
      false,
    );

    const rows = normalizeRows(rowsRaw, hasCompareRange(spec));
    const enriched = await enrichWithRedis(rows, spec, spec.resolveShopSubdomain);
    const filtered = applyInventoryFilters(enriched, spec.filters);
    const sorted = sortRows(filtered, spec.sortBy, spec.sortDir);
    const paged = sorted.slice(
      (spec.page - 1) * spec.pageSize,
      (spec.page - 1) * spec.pageSize + spec.pageSize,
    );

    return {
      range: { start: spec.start, end: spec.end },
      timezone: spec.timezone,
      page: spec.page,
      page_size: spec.pageSize,
      total_count: sorted.length,
      rows: paged,
      sort: { by: spec.sortBy, dir: spec.sortDir.toLowerCase() },
    };
  }

  async function getProductConversionCsv(spec) {
    if (spec.inventoryOnly) {
      const redisRows = await getInventoryOnlyRowsFromRedis(spec, spec.resolveShopSubdomain);
      const searched = applySearch(redisRows, spec.search);
      const filtered = applyInventoryFilters(searched, spec.filters);
      const sorted = sortRows(filtered, spec.sortBy, spec.sortDir);
      const headers = buildCsvHeaders(spec.visibleColumns, hasCompareRange(spec));
      const dateTag =
        spec.start === spec.end ? spec.start : `${spec.start}_to_${spec.end}`;
      return {
        filename: `product_conversion_${dateTag}.csv`,
        timezone: spec.timezone,
        headers,
        csv: buildCsvContent(sorted, headers),
      };
    }

    const useMappingBase =
      Array.isArray(spec.productTypes) && spec.productTypes.length > 0;
    const baseAlias = useMappingBase ? "m" : "s";
    const rowsRaw = await runSelectWithCollectionFallback(
      spec,
      useMappingBase,
      baseAlias,
      { page: 1, pageSize: UNBOUNDED_ROW_SAFETY_CAP },
      false,
    );
    const rows = normalizeRows(rowsRaw, hasCompareRange(spec));
    const enriched = await enrichWithRedis(rows, spec, spec.resolveShopSubdomain);
    const filtered = applyInventoryFilters(enriched, spec.filters);
    const sorted = sortRows(filtered, spec.sortBy, spec.sortDir);

    const headers = buildCsvHeaders(spec.visibleColumns, hasCompareRange(spec));
    const dateTag =
      spec.start === spec.end ? spec.start : `${spec.start}_to_${spec.end}`;
    return {
      filename: `product_conversion_${dateTag}.csv`,
      timezone: spec.timezone,
      headers,
      csv: buildCsvContent(sorted, headers),
    };
  }

  return {
    normalizeProductConversionRequest,
    getProductConversion,
    getProductConversionCsv,
  };
}

module.exports = {
  buildProductConversionService,
  normalizeProductConversionRequest,
  // also used by the intent funnel's product dropdown (same Redis top-products cache)
  getDefaultRedisClient,
  getInventoryTopProductSalesCache,
  // also used by the out-of-stock trend (variant names for the drill-down)
  getShopInventoryCache,
};
