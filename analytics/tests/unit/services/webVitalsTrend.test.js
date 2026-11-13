/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../../../shared/db/tenantRouterClient", () => ({ resolveTenantRoute: jest.fn() }));
jest.mock("../../../shared/db/tenantConnection", () => ({ getTenantConnection: jest.fn() }));
jest.mock("../../../config/brands", () => ({ getDynamicBrandsMap: jest.fn(() => ({})) }));
jest.mock("../../../services/overallSnapshotService", () => ({
  resolveAccessibleBrandKeys: jest.fn(),
  humanizeBrandKey: jest.fn((k) => k),
}));

const mysqlCore = require("mysql2");
const service = require("../../../services/webVitals.service");
const controller = require("../../../controllers/webVitals.controller");

const ROWS = [
  { date: "2026-11-09", performance: "86.5", fcp: "2.1", lcp: "2.3", ttfb: "0.01", inp: "0", cls: "0" },
  { date: "2026-11-10", performance: null, fcp: null, lcp: "2.9", ttfb: null, inp: null, cls: null },
];

function fakeConn(rows = ROWS) {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (sql, options) => {
      calls.push({ sql, replacements: options.replacements, finalSql: mysqlCore.format(sql.replace(/\s+/g, " "), options.replacements) });
      return rows;
    }),
  };
}

describe("urlVariants", () => {
  test("covers trailing slash and the host repeated as the first path segment", () => {
    const v = service.urlVariants("https://shop.example/products/kit/");
    expect(v).toEqual(expect.arrayContaining([
      "https://shop.example/products/kit/",
      "https://shop.example/products/kit",
      "https://shop.example/shop.example/products/kit",
      "https://shop.example/shop.example/products/kit/",
    ]));
  });

  test("a stored host-prefixed url maps back to the plain page and the home page works", () => {
    expect(service.urlVariants("https://shop.example/shop.example/products/a")).toContain("https://shop.example/products/a");
    const home = service.urlVariants("https://shop.example/");
    expect(home).toEqual(expect.arrayContaining(["https://shop.example/", "https://shop.example", "https://shop.example/shop.example"]));
  });

  test("query strings are kept, blanks give nothing, and a non-URL is matched as text only", () => {
    expect(service.urlVariants("https://shop.example/p?x=1")).toContain("https://shop.example/p?x=1");
    expect(service.urlVariants("  ")).toEqual([]);
    expect(service.urlVariants("not a url")).toEqual(["not a url"]);
  });
});

describe("getTrend", () => {
  test("without a url it is the brand average query, unchanged", async () => {
    const conn = fakeConn();
    const out = await service.getTrend({ conn, start: "2026-11-04", end: "2026-11-10" });
    expect(conn.calls[0].replacements).toEqual(["2026-11-04", "2026-11-10"]);
    expect(conn.calls[0].sql).not.toContain("url IN");
    expect(out).toMatchObject({ granularity: "daily", url: null });
    expect(out.points[0]).toEqual({ label: "2026-11-09", performance: 86.5, fcp: 2.1, lcp: 2.3, ttfb: 0.01, inp: 0, cls: 0 });
  });

  test("with a url it filters to that page's spellings, with parameters only", async () => {
    const conn = fakeConn();
    const out = await service.getTrend({ conn, start: "2026-11-04", end: "2026-11-10", url: "https://shop.example/products/kit/" });
    const { sql, replacements, finalSql } = conn.calls[0];
    expect(sql).toMatch(/AND url IN \(\?(, \?)+\)/);
    expect(replacements.slice(0, 2)).toEqual(["2026-11-04", "2026-11-10"]);
    expect(replacements).toContain("https://shop.example/products/kit");
    expect(finalSql).toContain("url IN ('https://shop.example/products/kit/'");
    expect(out.url).toBe("https://shop.example/products/kit/");
  });

  test("a day with no value for a metric stays null, not 0", async () => {
    const out = await service.getTrend({ conn: fakeConn(), start: "2026-11-09", end: "2026-11-10" });
    expect(out.points[1]).toMatchObject({ performance: null, lcp: 2.9, fcp: null });
  });
});

describe("GET /web-vitals/trend controller", () => {
  function run(query, brandDb = { sequelize: fakeConn() }) {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    return controller.trend({ query, brandDb }, res).then(() => res);
  }

  test("passes an optional url on", async () => {
    const conn = fakeConn();
    const res = await run({ start: "2026-11-04", end: "2026-11-10", url: " https://shop.example/a " }, { sequelize: conn });
    expect(res.statusCode).toBe(200);
    expect(conn.calls[0].replacements).toContain("https://shop.example/a");
    expect(res.body.url).toBe("https://shop.example/a");
  });

  test("works without it, ignores a blank one, and rejects an over-long one", async () => {
    const conn = fakeConn();
    expect((await run({ start: "2026-11-04", end: "2026-11-10", url: "   " }, { sequelize: conn })).body.url).toBeNull();
    const long = await run({ start: "2026-11-04", end: "2026-11-10", url: "x".repeat(service.MAX_TREND_URL_LENGTH + 1) });
    expect(long.statusCode).toBe(400);
  });

  test("500 when the brand database is missing", async () => {
    expect((await run({}, {})).statusCode).toBe(500);
  });
});
