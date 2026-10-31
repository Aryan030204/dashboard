/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// These tests pin the separate-query path (its results are the reference); the single queries that normally
// replace it are tested against this one in heatmapSingleQuery.test.js.
process.env.INTENT_HEATMAP_SINGLE_QUERY = "off";

const { buildHeatmapService, _internal } = require("../../../services/heatmapService");
const { createQueryCache } = require("../../../services/intentFunnelService");

const SPEC = { brandKey: "BBB", start: "2026-10-22", end: "2026-10-28" };

const PAGE_ROWS = [
  { page_path: "/", page_views: "9622", sessions: "7000" },
  { page_path: "/collections/all", page_views: "5980", sessions: "4100" },
  { page_path: "/account", page_views: "4804", sessions: "3900" },
];

const ELEMENT_ROWS = [
  {
    click_target_hash: "aaa", tag_name: "button", element_id: "", element_name: "", element_type: "submit",
    element_value: null, href: "", clicks: "607", useful_clicks: "100", dead_clicks: "507",
  },
  {
    click_target_hash: "bbb", tag_name: "a", element_id: "menu", element_name: "Menu", element_type: "",
    element_value: "", href: "/cart", clicks: "339", useful_clicks: "20", dead_clicks: "319",
  },
];

function missingTable() {
  return Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
}

function makeConn(overrides = {}) {
  const handlers = {
    pages: () => PAGE_ROWS,
    summary: () => [{ total_views: "20406", pages: "3", latest_date: "2026-10-28" }],
    elements: () => ELEMENT_ROWS,
    totals: () => [{ clicks: "1000", useful_clicks: "150", dead_clicks: "850", elements: "357" }],
    pageViews: () => [{ page_views: "3507" }],
    ...overrides,
  };
  const query = jest.fn(async (sql, options) => {
    if (sql.includes("FROM click_behavior_daily")) {
      return sql.includes("GROUP BY click_target_hash") ? handlers.elements(sql, options) : handlers.totals(sql, options);
    }
    if (sql.includes("FROM heatmap_page_daily")) {
      if (sql.includes("GROUP BY page_path")) return handlers.pages(sql, options);
      if (sql.includes("COUNT(DISTINCT page_path)")) return handlers.summary(sql, options);
      return handlers.pageViews(sql, options);
    }
    throw new Error(`unexpected sql: ${sql}`);
  });
  return { query };
}

function newService() {
  return buildHeatmapService({ cache: createQueryCache() });
}

describe("heatmapService.getHeatmapPages", () => {
  test("returns the popular pages, most viewed first, with the range totals and rollup freshness", async () => {
    const out = await newService().getHeatmapPages({ ...SPEC, conn: makeConn() });
    expect(out.meta).toEqual({ available: true, latestDate: "2026-10-28" });
    expect(out.filters).toEqual({
      start: "2026-10-22", end: "2026-10-28", device: "all", search: "", limit: 50,
    });
    expect(out.pages).toEqual([
      { path: "/", views: 9622, sessions: 7000 },
      { path: "/collections/all", views: 5980, sessions: 4100 },
      { path: "/account", views: 4804, sessions: 3900 },
    ]);
    expect(out.totalViews).toBe(20406);
    expect(out.totalPages).toBe(3);
  });

  test("a device filter is a bound parameter; an unknown device means all devices", async () => {
    const conn = makeConn();
    const out = await newService().getHeatmapPages({ ...SPEC, device: "mobile", conn });
    expect(out.filters.device).toBe("mobile");
    const pagesCall = conn.query.mock.calls.find(([sql]) => sql.includes("GROUP BY page_path"));
    expect(pagesCall[0]).toContain("device_type = ?");
    expect(pagesCall[0]).not.toContain("mobile");
    expect(pagesCall[1].replacements).toEqual(["2026-10-22", "2026-10-28", "mobile"]);

    const conn2 = makeConn();
    const all = await newService().getHeatmapPages({ ...SPEC, device: "x'; DROP TABLE a;--", conn: conn2 });
    expect(all.filters.device).toBe("all");
    conn2.query.mock.calls.forEach(([sql]) => expect(sql).not.toContain("device_type = ?"));
  });

  test("a search is lowercased, its wildcards are escaped, and it is bound, never written into the SQL", async () => {
    const conn = makeConn();
    await newService().getHeatmapPages({ ...SPEC, search: "  Zebra%_Off ", conn });
    const pagesCall = conn.query.mock.calls.find(([sql]) => sql.includes("GROUP BY page_path"));
    expect(pagesCall[0]).toContain("page_path LIKE ? ESCAPE");
    expect(pagesCall[0].toLowerCase()).not.toContain("zebra");
    expect(pagesCall[1].replacements).toEqual(["2026-10-22", "2026-10-28", "%zebra\\%\\_off%"]);
  });

  test("the limit is clamped to a sane range", () => {
    expect(_internal.clampLimit(undefined, 50, 200)).toBe(50);
    expect(_internal.clampLimit("abc", 50, 200)).toBe(50);
    expect(_internal.clampLimit(0, 50, 200)).toBe(50);
    expect(_internal.clampLimit(5000, 50, 200)).toBe(200);
    expect(_internal.clampLimit("10", 50, 200)).toBe(10);
  });

  test("no request value reaches the SQL text", async () => {
    const conn = makeConn();
    await newService().getHeatmapPages({ ...SPEC, device: "desktop", search: "shop", conn });
    conn.query.mock.calls.forEach(([sql, options]) => {
      expect(sql).not.toMatch(/select\s+\*/i);
      expect(sql).not.toContain("BBB");
      expect(sql).not.toContain("2026-10");
      expect(sql).not.toContain("desktop");
      expect(sql).not.toContain("shop");
      expect(Array.isArray(options.replacements)).toBe(true);
    });
  });

  test("a brand database without the rollup table is unavailable, not an error", async () => {
    const out = await newService().getHeatmapPages({
      ...SPEC,
      conn: makeConn({ pages: () => { throw missingTable(); } }),
    });
    expect(out.meta).toEqual({ available: false, reason: "table_missing" });
    expect(out.pages).toEqual([]);
    expect(out.totalViews).toBe(0);
  });

  test("an older table layout is reported as unsupported", async () => {
    const bad = Object.assign(new Error("Unknown column"), { code: "ER_BAD_FIELD_ERROR", errno: 1054 });
    const out = await newService().getHeatmapPages({ ...SPEC, conn: makeConn({ summary: () => { throw bad; } }) });
    expect(out.meta).toEqual({ available: false, reason: "schema_unsupported" });
  });

  test("timeouts and unexpected failures propagate so the controller can answer 504 / 500", async () => {
    const timeout = Object.assign(new Error("timeout"), { code: "ER_QUERY_TIMEOUT", errno: 3024 });
    await expect(
      newService().getHeatmapPages({ ...SPEC, conn: makeConn({ pages: () => { throw timeout; } }) }),
    ).rejects.toThrow("timeout");
  });

  test("results are cached per brand and never cross tenants", async () => {
    const service = newService();
    const a = await service.getHeatmapPages({ ...SPEC, brandKey: "BBB", conn: makeConn() });
    const b = await service.getHeatmapPages({
      ...SPEC,
      brandKey: "PTS",
      conn: makeConn({ pages: () => [{ page_path: "/x", page_views: "1", sessions: "1" }] }),
    });
    expect(a.pages).toHaveLength(3);
    expect(b.pages).toEqual([{ path: "/x", views: 1, sessions: 1 }]);
  });
});

describe("heatmapService.getHeatmapElements", () => {
  const ELEMENT_SPEC = { ...SPEC, path: "/" };

  test("returns the ranked elements with each one's share of all clicks on the page", async () => {
    const out = await newService().getHeatmapElements({ ...ELEMENT_SPEC, conn: makeConn() });
    expect(out.meta).toEqual({ available: true, pageViewsAvailable: true });
    expect(out.totals).toEqual({ clicks: 1000, usefulClicks: 150, deadClicks: 850, elements: 357, pageViews: 3507 });
    expect(out.elements).toHaveLength(2);
    expect(out.elements[0]).toMatchObject({
      id: "aaa", tag: "button", type: "submit", clicks: 607, usefulClicks: 100, deadClicks: 507,
    });
    expect(out.elements[0].share).toBeCloseTo(60.7);
    expect(out.elements[1]).toMatchObject({ id: "bbb", tag: "a", elementId: "menu", name: "Menu", href: "/cart" });
    expect(out.elements[1].share).toBeCloseTo(33.9);
  });

  test("empty strings from the pipeline become null so the UI can tell what is missing", async () => {
    const out = await newService().getHeatmapElements({ ...ELEMENT_SPEC, conn: makeConn() });
    expect(out.elements[0]).toMatchObject({ elementId: null, name: null, value: null, href: null });
    expect(out.elements[1]).toMatchObject({ type: null, value: null });
  });

  test("the page path is a bound parameter, never part of the SQL", async () => {
    const conn = makeConn();
    await newService().getHeatmapElements({ ...SPEC, path: "/products/x", limit: 5, conn });
    conn.query.mock.calls.forEach(([sql, options]) => {
      expect(sql).not.toContain("/products/x");
      expect(sql).not.toContain("2026-10");
      expect(sql).not.toContain("BBB");
      expect(Array.isArray(options.replacements)).toBe(true);
    });
    const elementsCall = conn.query.mock.calls.find(([sql]) => sql.includes("GROUP BY click_target_hash"));
    expect(elementsCall[1].replacements).toEqual(["2026-10-22", "2026-10-28", "/products/x"]);
    expect(elementsCall[0]).toContain("LIMIT 5");
  });

  test("a page with no clicks returns zero totals and no elements", async () => {
    const out = await newService().getHeatmapElements({
      ...ELEMENT_SPEC,
      conn: makeConn({
        elements: () => [],
        totals: () => [{ clicks: null, useful_clicks: null, dead_clicks: null, elements: 0 }],
        pageViews: () => [{ page_views: "12" }],
      }),
    });
    expect(out.elements).toEqual([]);
    expect(out.totals).toEqual({ clicks: 0, usefulClicks: 0, deadClicks: 0, elements: 0, pageViews: 12 });
  });

  test("without the pages rollup the clicks still work and page views are null", async () => {
    const out = await newService().getHeatmapElements({
      ...ELEMENT_SPEC,
      conn: makeConn({ pageViews: () => { throw missingTable(); } }),
    });
    expect(out.meta).toEqual({ available: true, pageViewsAvailable: false });
    expect(out.totals.pageViews).toBeNull();
    expect(out.elements).toHaveLength(2);
  });

  test("without the click table the page is unavailable", async () => {
    const out = await newService().getHeatmapElements({
      ...ELEMENT_SPEC,
      conn: makeConn({ elements: () => { throw missingTable(); } }),
    });
    expect(out.meta).toEqual({ available: false, reason: "table_missing" });
    expect(out.elements).toEqual([]);
    expect(out.totals.pageViews).toBeNull();
  });

  test("timeouts propagate", async () => {
    const timeout = Object.assign(new Error("timeout"), { code: "ER_QUERY_TIMEOUT", errno: 3024 });
    await expect(
      newService().getHeatmapElements({ ...ELEMENT_SPEC, conn: makeConn({ totals: () => { throw timeout; } }) }),
    ).rejects.toThrow("timeout");
  });
});
