const { QueryTypes } = require("sequelize");
const { createQueryCache, isMissingTable, isSchemaMismatch } = require("./intentFunnelService");
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
  async function select(conn, { sql, params }, brandKey) {
    const run = () => conn.query(sql, { type: QueryTypes.SELECT, replacements: params });
    if (!brandKey) return run();
    return cache(`heatmap|${brandKey}|${sql}|${JSON.stringify(params)}`, run);
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

    try {
      const [rows, summaryRows] = await Promise.all([
        select(conn, buildPagesQuery({ start, end, device, search, limit }), brandKey),
        select(conn, buildPagesSummaryQuery({ start, end, device }), brandKey),
      ]);
      const summary = summaryRows?.[0] || {};
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

    let rows;
    let totalsRows;
    try {
      [rows, totalsRows] = await Promise.all([
        select(conn, buildElementsQuery({ start, end, path, limit }), brandKey),
        select(conn, buildElementTotalsQuery({ start, end, path }), brandKey),
      ]);
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
      const viewRows = await select(conn, buildPageViewsQuery({ start, end, path }), brandKey);
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
    buildElementsQuery,
    buildElementTotalsQuery,
    buildPageViewsQuery,
    clampLimit,
  },
};
