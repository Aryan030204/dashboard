/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { buildHeatmapService, _internal } = require("../../../services/heatmapService");
const { createQueryCache } = require("../../../services/intentFunnelService");

const SPEC = { brandKey: "BBB", start: "2026-10-22", end: "2026-10-28" };

const PAGES = [
  { page_path: "/", page_views: "9622", sessions: "7000" },
  { page_path: "/collections/all", page_views: "5980", sessions: "4100" },
  { page_path: "/account", page_views: "4804", sessions: "3900" },
];
const TOTALS = { total_views: "20406", pages: "3", latest_date: "2026-10-28" };

const ELEMENTS = [
  { click_target_hash: "aaa", tag_name: "button", element_id: "", element_name: "", element_type: "submit", element_value: null, href: "", clicks: "607", useful_clicks: "100", dead_clicks: "507" },
  { click_target_hash: "bbb", tag_name: "a", element_id: "menu", element_name: "Menu", element_type: "", element_value: "", href: "/cart", clicks: "339", useful_clicks: "20", dead_clicks: "319" },
];
const ELEMENT_TOTALS = { clicks: "1000", useful_clicks: "150", dead_clicks: "850", elements: "357" };

// One conn that answers both the separate queries and the single ones from the same underlying numbers.
function makeConn({ windowError = null } = {}) {
  const query = jest.fn(async (sql) => {
    const isWindow = sql.includes("OVER ()");
    if (isWindow && windowError) throw windowError;
    if (sql.includes("FROM click_behavior_daily")) {
      if (isWindow) {
        return ELEMENTS.map((row) => ({
          ...row,
          total_clicks: ELEMENT_TOTALS.clicks,
          total_useful_clicks: ELEMENT_TOTALS.useful_clicks,
          total_dead_clicks: ELEMENT_TOTALS.dead_clicks,
          elements: ELEMENT_TOTALS.elements,
        }));
      }
      return sql.includes("GROUP BY click_target_hash") ? ELEMENTS : [ELEMENT_TOTALS];
    }
    if (sql.includes("FROM heatmap_page_daily")) {
      if (isWindow) return PAGES.map((row) => ({ ...row, ...TOTALS }));
      if (sql.includes("GROUP BY page_path")) return PAGES;
      if (sql.includes("COUNT(DISTINCT page_path)")) return [TOTALS];
      return [{ page_views: "3507" }];
    }
    throw new Error(`unexpected sql: ${sql}`);
  });
  return { query };
}

const newService = () => buildHeatmapService({ cache: createQueryCache() });

afterEach(() => {
  delete process.env.INTENT_HEATMAP_SINGLE_QUERY;
  _internal.resetWindowFallback();
});

describe("popular pages in one query", () => {
  test("gives the same answer as the pages query plus the summary query", async () => {
    process.env.INTENT_HEATMAP_SINGLE_QUERY = "off";
    const twoConn = makeConn();
    const two = await newService().getHeatmapPages({ ...SPEC, conn: twoConn });
    delete process.env.INTENT_HEATMAP_SINGLE_QUERY;

    const oneConn = makeConn();
    const one = await newService().getHeatmapPages({ ...SPEC, conn: oneConn });

    expect(one).toEqual(two);
    expect(twoConn.query).toHaveBeenCalledTimes(2);
    expect(oneConn.query).toHaveBeenCalledTimes(1);
  });

  test("a search keeps the separate queries: the totals must ignore it", async () => {
    const conn = makeConn();
    const out = await newService().getHeatmapPages({ ...SPEC, search: "coll", conn });

    expect(conn.query).toHaveBeenCalledTimes(2);
    expect(conn.query.mock.calls.every(([sql]) => !sql.includes("OVER ()"))).toBe(true);
    expect(out.totalViews).toBe(20406);
  });

  test("the totals cover every page, the window runs over the grouped rows before LIMIT", () => {
    const { sql, params } = _internal.buildPagesWithTotalsQuery({ start: "2026-10-22", end: "2026-10-28", device: "mobile", limit: 50 });
    expect(sql).toContain("SUM(SUM(page_views)) OVER () AS total_views");
    expect(sql).toContain("COUNT(*) OVER () AS pages");
    expect(sql).toContain("MAX_EXECUTION_TIME(");
    expect(sql.indexOf("OVER ()")).toBeLessThan(sql.indexOf("LIMIT 50"));
    expect(params).toEqual(["2026-10-22", "2026-10-28", "mobile"]);
    expect(sql.match(/\?/g)).toHaveLength(params.length);
  });

  test("a range with no rows answers zero totals and no latest date", async () => {
    const conn = { query: jest.fn(async () => []) };
    const out = await newService().getHeatmapPages({ ...SPEC, conn });
    expect(out).toMatchObject({ totalViews: 0, totalPages: 0, pages: [] });
    expect(out.meta.latestDate).toBeNull();
  });

  test("a server without window functions falls back to the two queries, once, and remembers it", async () => {
    const parseError = Object.assign(new Error("syntax"), { code: "ER_PARSE_ERROR", errno: 1064 });
    const conn = makeConn({ windowError: parseError });
    const first = await newService().getHeatmapPages({ ...SPEC, conn });
    expect(first.pages).toHaveLength(3);
    expect(conn.query).toHaveBeenCalledTimes(3); // the failed single query + the two separate ones

    conn.query.mockClear();
    await newService().getHeatmapPages({ ...SPEC, start: "2026-10-21", conn });
    expect(conn.query).toHaveBeenCalledTimes(2); // no second attempt of the single query
  });

  test("other errors still propagate", async () => {
    const timeout = Object.assign(new Error("timeout"), { code: "ER_QUERY_TIMEOUT", errno: 3024 });
    const conn = makeConn({ windowError: timeout });
    await expect(newService().getHeatmapPages({ ...SPEC, conn })).rejects.toBe(timeout);
  });
});

describe("clicked elements in one query", () => {
  test("gives the same answer as the elements query plus the totals query", async () => {
    process.env.INTENT_HEATMAP_SINGLE_QUERY = "off";
    const two = await newService().getHeatmapElements({ ...SPEC, path: "/", conn: makeConn() });
    delete process.env.INTENT_HEATMAP_SINGLE_QUERY;

    const oneConn = makeConn();
    const one = await newService().getHeatmapElements({ ...SPEC, path: "/", conn: oneConn });

    expect(one).toEqual(two);
    // the list + totals in one, plus the page-views lookup
    expect(oneConn.query).toHaveBeenCalledTimes(2);
  });

  test("a page with no clicks answers zero totals", async () => {
    const conn = {
      query: jest.fn(async (sql) => (sql.includes("FROM heatmap_page_daily") ? [{ page_views: "0" }] : [])),
    };
    const out = await newService().getHeatmapElements({ ...SPEC, path: "/nothing", conn });
    expect(out.elements).toEqual([]);
    expect(out.totals).toMatchObject({ clicks: 0, elements: 0 });
  });

  test("the path is a bound parameter", () => {
    const { sql, params } = _internal.buildElementsWithTotalsQuery({ start: "a", end: "b", path: "/x'; DROP TABLE y;--", limit: 20 });
    expect(sql).not.toContain("DROP");
    expect(params).toEqual(["a", "b", "/x'; DROP TABLE y;--"]);
  });
});
