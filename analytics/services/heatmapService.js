const { QueryTypes } = require("sequelize");
const { createQueryCache, isMissingTable, isSchemaMismatch, rangeCacheTtl } = require("./intentFunnelService");
const { runLimited } = require("../shared/utils/brandLimiter");
const { DEVICES, escapeLike } = require("../shared/utils/heatmap");

// Read-only access to the heatmap data of one brand database. The brand connection comes from brandContext
// (tenant-router), never from request input; every value reaches SQL as a bound parameter.
//
//   pages    heatmap_page_daily  - page views per day, page path and device, filled once a day by
//                                  scripts/heatmap-pages-rollup.js (a live count over behavioral_events
//                                  takes far too long, so the table is required for the pages list)
//   elements click_behavior_daily - clicks per day, page path and clicked element, filled by the intent
//                                  pipeline (no device split, no coordinates)

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const DEFAULT_ELEMENT_LIMIT = 20;
const MAX_ELEMENT_LIMIT = 50;
const QUERY_TIMEOUT_MS = 20000;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampLimit(value, fallback, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(max, n);
}

function buildPagesQuery({ start, end, device, search, limit }) {
  const where = ["summary_date >= ?", "summary_date <= ?"];
  const params = [start, end];
  if (DEVICES.includes(device)) {
    where.push("device_type = ?");
    params.push(device);
  }
  const term = String(search ?? "").trim();
  if (term) {
    where.push("page_path LIKE ? ESCAPE '\\\\'");
    params.push(`%${escapeLike(term.toLowerCase())}%`);
  }
  return {
    sql: `
      SELECT /*+ MAX_EXECUTION_TIME(${QUERY_TIMEOUT_MS}) */
        page_path,
        SUM(page_views) AS page_views,
        SUM(sessions) AS sessions
      FROM heatmap_page_daily
      WHERE ${where.join(" AND ")}
      GROUP BY page_path
      ORDER BY page_views DESC, page_path ASC
      LIMIT ${limit}
    `,
    params,
  };
}

// Page views of the whole range (not only the listed pages) and how fresh the rollup is.
function buildPagesSummaryQuery({ start, end, device }) {
  const params = [start, end];
  let deviceClause = "";
  if (DEVICES.includes(device)) {
    deviceClause = "AND device_type = ?";
    params.push(device);
  }
  return {
    sql: `
      SELECT /*+ MAX_EXECUTION_TIME(${QUERY_TIMEOUT_MS}) */
        COALESCE(SUM(page_views), 0) AS total_views,
        COUNT(DISTINCT page_path) AS pages,
        DATE_FORMAT(MAX(summary_date), '%Y-%m-%d') AS latest_date
      FROM heatmap_page_daily
      WHERE summary_date >= ? AND summary_date <= ? ${deviceClause}
    `,
    params,
  };
}

function buildElementsQuery({ start, end, path, limit }) {
  return {
    sql: `
      SELECT /*+ MAX_EXECUTION_TIME(${QUERY_TIMEOUT_MS}) */
        click_target_hash,
        MAX(tag_name) AS tag_name,
        MAX(element_id) AS element_id,
        MAX(element_name) AS element_name,
        MAX(element_type) AS element_type,
        MAX(element_value) AS element_value,
        MAX(href) AS href,
        SUM(total_clicks) AS clicks,
        SUM(useful_clicks) AS useful_clicks,
        SUM(dead_clicks) AS dead_clicks
      FROM click_behavior_daily
      WHERE summary_date >= ? AND summary_date <= ? AND page_path = ?
      GROUP BY click_target_hash
      ORDER BY clicks DESC, click_target_hash ASC
      LIMIT ${limit}
    `,
    params: [start, end, path],
  };
}

// The list and its totals in one read. The pages query and the summary query above scan the same rows of the same
// range (the summary ignores the search, so this is only used when there is none). The window functions are
// evaluated over the grouped rows before LIMIT, so the totals cover every page, not only the listed ones.
// Needs MySQL 8 window functions; on a server without them the two-query path above is used (isWindowParseError).
function buildPagesWithTotalsQuery({ start, end, device, limit }) {
  const where = ["summary_date >= ?", "summary_date <= ?"];
  const params = [start, end];
  if (DEVICES.includes(device)) {
    where.push("device_type = ?");
    params.push(device);
  }
  return {
    sql: `
      SELECT /*+ MAX_EXECUTION_TIME(${QUERY_TIMEOUT_MS}) */
        page_path,
        SUM(page_views) AS page_views,
        SUM(sessions) AS sessions,
        SUM(SUM(page_views)) OVER () AS total_views,
        COUNT(*) OVER () AS pages,
        DATE_FORMAT(MAX(MAX(summary_date)) OVER (), '%Y-%m-%d') AS latest_date
      FROM heatmap_page_daily
      WHERE ${where.join(" AND ")}
      GROUP BY page_path
      ORDER BY page_views DESC, page_path ASC
      LIMIT ${limit}
    `,
    params,
  };
}

// The ranked elements of a page and the page's totals in one read (same idea as buildPagesWithTotalsQuery).
function buildElementsWithTotalsQuery({ start, end, path, limit }) {
  return {
    sql: `
      SELECT /*+ MAX_EXECUTION_TIME(${QUERY_TIMEOUT_MS}) */
        click_target_hash,
        MAX(tag_name) AS tag_name,
        MAX(element_id) AS element_id,
        MAX(element_name) AS element_name,
        MAX(element_type) AS element_type,
        MAX(element_value) AS element_value,
        MAX(href) AS href,
        SUM(total_clicks) AS clicks,
        SUM(useful_clicks) AS useful_clicks,
        SUM(dead_clicks) AS dead_clicks,
        SUM(SUM(total_clicks)) OVER () AS total_clicks,
        SUM(SUM(useful_clicks)) OVER () AS total_useful_clicks,
        SUM(SUM(dead_clicks)) OVER () AS total_dead_clicks,
        COUNT(*) OVER () AS elements
      FROM click_behavior_daily
      WHERE summary_date >= ? AND summary_date <= ? AND page_path = ?
      GROUP BY click_target_hash
      ORDER BY clicks DESC, click_target_hash ASC
      LIMIT ${limit}
    `,
    params: [start, end, path],
  };
}

// A server that cannot parse window functions (MySQL before 8.0) answers a syntax error: fall back to the
// separate queries, and do not try the single query again in this process.
let windowQueriesBroken = false;
// INTENT_HEATMAP_SINGLE_QUERY=off keeps the separate queries.
function singleQueryEnabled(env = process.env) {
  return !windowQueriesBroken && String(env.INTENT_HEATMAP_SINGLE_QUERY || "on").trim().toLowerCase() !== "off";
}
function isWindowParseError(err) {
  return err?.code === "ER_PARSE_ERROR" || err?.errno === 1064;
}

function buildElementTotalsQuery({ start, end, path }) {
  return {
    sql: `
      SELECT /*+ MAX_EXECUTION_TIME(${QUERY_TIMEOUT_MS}) */
        COALESCE(SUM(total_clicks), 0) AS clicks,
        COALESCE(SUM(useful_clicks), 0) AS useful_clicks,
        COALESCE(SUM(dead_clicks), 0) AS dead_clicks,
        COUNT(DISTINCT click_target_hash) AS elements
      FROM click_behavior_daily
      WHERE summary_date >= ? AND summary_date <= ? AND page_path = ?
    `,
    params: [start, end, path],
  };
}

function buildPageViewsQuery({ start, end, path }) {
  return {
    sql: `
      SELECT COALESCE(SUM(page_views), 0) AS page_views
      FROM heatmap_page_daily
      WHERE summary_date >= ? AND summary_date <= ? AND page_path = ?
    `,
    params: [start, end, path],
  };
}

function emptyToNull(value) {
  const text = value == null ? "" : String(value).trim();
  return text === "" ? null : text;
}

function buildHeatmapService({ cache = createQueryCache() } = {}) {
  // The cache key includes the brand so results can never cross tenants.
  async function select(conn, { sql, params }, brandKey, options = {}) {
    // the query runs through the per-brand limit (shared with the Intent page); a cached answer never waits for it
    const run = () =>
      runLimited(brandKey, () => conn.query(sql, { type: QueryTypes.SELECT, replacements: params }));
    if (!brandKey) return run();
    return cache(`heatmap|${brandKey}|${sql}|${JSON.stringify(params)}`, run, { ttlMs: options.ttlMs });
  }

  function unavailable(err) {
    return {
      available: false,
      reason: isMissingTable(err) ? "table_missing" : "schema_unsupported",
    };
  }

  // Popular pages: page views per normalised page path for the range, optionally for one device.
  async function getHeatmapPages(spec) {
    const { conn, brandKey, start, end } = spec;
    const device = DEVICES.includes(spec.device) ? spec.device : "all";
    const search = String(spec.search ?? "").trim().slice(0, 100);
    const limit = clampLimit(spec.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const filters = { start, end, device, search, limit };

    const cacheOptions = { ttlMs: rangeCacheTtl(end) };
    try {
      let rows;
      let summary;
      if (!search && singleQueryEnabled()) {
        try {
          rows = await select(conn, buildPagesWithTotalsQuery({ start, end, device, limit }), brandKey, cacheOptions);
          const first = rows?.[0] || {};
          summary = {
            total_views: first.total_views ?? 0,
            pages: first.pages ?? 0,
            latest_date: first.latest_date ?? null,
          };
        } catch (err) {
          if (!isWindowParseError(err)) throw err;
          windowQueriesBroken = true;
          rows = undefined;
        }
      }
      if (rows === undefined) {
        const [pageRows, summaryRows] = await Promise.all([
          select(conn, buildPagesQuery({ start, end, device, search, limit }), brandKey, cacheOptions),
          select(conn, buildPagesSummaryQuery({ start, end, device }), brandKey, cacheOptions),
        ]);
        rows = pageRows;
        summary = summaryRows?.[0] || {};
      }
      return {
        filters,
        meta: { available: true, latestDate: summary.latest_date || null },
        totalViews: num(summary.total_views),
        totalPages: num(summary.pages),
        pages: (rows || []).map((row) => ({
          path: String(row.page_path),
          views: num(row.page_views),
          sessions: num(row.sessions),
        })),
      };
    } catch (err) {
      if (isMissingTable(err) || isSchemaMismatch(err)) {
        return { filters, meta: unavailable(err), totalViews: 0, totalPages: 0, pages: [] };
      }
      throw err;
    }
  }

  // Ranked clicked elements of one page, with the page's totals. Page views come from the pages rollup
  // when it exists; without it they are null and the rest still works.
  async function getHeatmapElements(spec) {
    const { conn, brandKey, start, end, path } = spec;
    const limit = clampLimit(spec.limit, DEFAULT_ELEMENT_LIMIT, MAX_ELEMENT_LIMIT);
    const filters = { start, end, path, limit };
    const empty = {
      totals: { clicks: 0, usefulClicks: 0, deadClicks: 0, elements: 0, pageViews: null },
      elements: [],
    };

    const cacheOptions = { ttlMs: rangeCacheTtl(end) };
    let rows;
    let totalsRows;
    try {
      if (singleQueryEnabled()) {
        try {
          rows = await select(conn, buildElementsWithTotalsQuery({ start, end, path, limit }), brandKey, cacheOptions);
          const first = rows?.[0];
          totalsRows = [
            {
              clicks: first?.total_clicks ?? 0,
              useful_clicks: first?.total_useful_clicks ?? 0,
              dead_clicks: first?.total_dead_clicks ?? 0,
              elements: first?.elements ?? 0,
            },
          ];
        } catch (err) {
          if (!isWindowParseError(err)) throw err;
          windowQueriesBroken = true;
          rows = undefined;
        }
      }
      if (rows === undefined) {
        [rows, totalsRows] = await Promise.all([
          select(conn, buildElementsQuery({ start, end, path, limit }), brandKey, cacheOptions),
          select(conn, buildElementTotalsQuery({ start, end, path }), brandKey, cacheOptions),
        ]);
      }
    } catch (err) {
      if (isMissingTable(err) || isSchemaMismatch(err)) {
        return { filters, meta: unavailable(err), ...empty };
      }
      throw err;
    }

    // optional: the pages rollup may not have been built for this brand yet
    let pageViews = null;
    let pageViewsAvailable = true;
    try {
      const viewRows = await select(conn, buildPageViewsQuery({ start, end, path }), brandKey, cacheOptions);
      pageViews = num(viewRows?.[0]?.page_views);
    } catch (err) {
      if (!(isMissingTable(err) || isSchemaMismatch(err))) throw err;
      pageViewsAvailable = false;
    }

    const totalsRow = totalsRows?.[0] || {};
    const clicks = num(totalsRow.clicks);
    return {
      filters,
      meta: { available: true, pageViewsAvailable },
      totals: {
        clicks,
        usefulClicks: num(totalsRow.useful_clicks),
        deadClicks: num(totalsRow.dead_clicks),
        elements: num(totalsRow.elements),
        pageViews,
      },
      elements: (rows || []).map((row) => {
        const elementClicks = num(row.clicks);
        return {
          id: String(row.click_target_hash),
          tag: emptyToNull(row.tag_name),
          elementId: emptyToNull(row.element_id),
          name: emptyToNull(row.element_name),
          type: emptyToNull(row.element_type),
          value: emptyToNull(row.element_value),
          href: emptyToNull(row.href),
          clicks: elementClicks,
          usefulClicks: num(row.useful_clicks),
          deadClicks: num(row.dead_clicks),
          // share of ALL clicks on the page, not only of the listed elements
          share: clicks > 0 ? (elementClicks / clicks) * 100 : 0,
        };
      }),
    };
  }

  return { getHeatmapPages, getHeatmapElements };
}

module.exports = {
  buildHeatmapService,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  DEFAULT_ELEMENT_LIMIT,
  MAX_ELEMENT_LIMIT,
  // exported for unit tests
  _internal: {
    buildPagesQuery,
    buildPagesSummaryQuery,
    buildPagesWithTotalsQuery,
    buildElementsWithTotalsQuery,
    isWindowParseError,
    resetWindowFallback: () => {
      windowQueriesBroken = false;
    },
    buildElementsQuery,
    buildElementTotalsQuery,
    buildPageViewsQuery,
    clampLimit,
  },
};
