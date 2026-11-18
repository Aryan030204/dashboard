/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { buildIntentFunnelController } = require("../../../modules/metrics/intentFunnelController");
const {
  buildIntentFunnelService,
  createQueryCache,
  _internal,
} = require("../../../services/intentFunnelService");

const SPEC = { brandKey: "BBB", start: "2026-10-27", end: "2026-11-02", intent: "high", basis: "behavior" };

const PRODUCT_ROWS = [
  { product_id: "111", title: "Serum", views: "500", add_to_cart: "200", checkouts: "100" },
  { product_id: "222", title: null, views: "40", add_to_cart: "4", checkouts: "2" },
];

function makeConn(overrides = {}) {
  const handlers = {
    products: () => PRODUCT_ROWS,
    coverage: () => [{ first_date: "2026-11-02", last_date: "2026-11-02" }],
    ...overrides,
  };
  const query = jest.fn(async (sql, options) => {
    if (sql.includes("MIN(summary_date)")) return handlers.coverage(sql, options);
    if (sql.includes("FROM product_intent_daily")) return handlers.products(sql, options);
    throw new Error(`unexpected sql: ${sql}`);
  });
  return { query };
}

function newService() {
  return buildIntentFunnelService({ cache: createQueryCache() });
}

describe("intentFunnelService.getTopProducts", () => {
  test("returns the products of one intent level, with CVR, and says where the rollup starts", async () => {
    const conn = makeConn();
    const out = await newService().getTopProducts({ ...SPEC, conn });
    expect(out.filters).toEqual({ start: "2026-10-27", end: "2026-11-02", intent: "high", basis: "behavior" });
    expect(out.topProducts).toEqual([
      { id: "111", name: "Serum", views: 500, addToCart: 200, checkouts: 100, cvr: 20 },
      { id: "222", name: "Product 222", views: 40, addToCart: 4, checkouts: 2, cvr: 5 },
    ]);
    // the range starts before the rollup does
    expect(out.meta).toEqual({ available: true, firstDate: "2026-11-02", lastDate: "2026-11-02", partial: true });
  });

  test("a range inside the rollup is not partial", async () => {
    const out = await newService().getTopProducts({ ...SPEC, start: "2026-11-02", conn: makeConn() });
    expect(out.meta.partial).toBe(false);
  });

  test("the level and basis are bound parameters, never part of the SQL", async () => {
    const conn = makeConn();
    await newService().getTopProducts({ ...SPEC, intent: "medium", basis: "score", conn });
    const call = conn.query.mock.calls.find(([sql]) => sql.includes("GROUP BY product_id"));
    expect(call[0]).toContain("intent_level = ?");
    expect(call[0]).not.toMatch(/'(high|medium|low|score|behavior)'/);
    expect(call[1].replacements).toEqual(["2026-10-27", "2026-11-02", "score", "medium"]);
  });

  test("all intents adds no level condition; unknown values fall back to all / behavior", async () => {
    const conn = makeConn();
    const out = await newService().getTopProducts({ ...SPEC, intent: "x'; DROP TABLE a;--", basis: "nope", conn });
    expect(out.filters).toMatchObject({ intent: "all", basis: "behavior" });
    const call = conn.query.mock.calls.find(([sql]) => sql.includes("GROUP BY product_id"));
    expect(call[0]).not.toContain("intent_level = ?");
    expect(call[1].replacements).toEqual(["2026-10-27", "2026-11-02", "behavior"]);
  });

  test("a brand without the rollup table answers unavailable instead of failing", async () => {
    const missing = () => Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
    const conn = makeConn({ products: () => { throw missing(); }, coverage: () => { throw missing(); } });
    const out = await newService().getTopProducts({ ...SPEC, conn });
    expect(out.meta).toEqual({ available: false, reason: "table_missing" });
    expect(out.topProducts).toEqual([]);
  });

  test("the query is ordered by views and limited", () => {
    const { sql } = _internal.buildProductIntentQuery({ start: "a", end: "b", basis: "behavior", intent: "high" });
    expect(sql).toContain("ORDER BY views DESC");
    expect(sql).toContain("LIMIT 10");
  });
});

describe("intentFunnelController.getTopProducts", () => {
  function createRes() {
    return {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
  }
  const req = (query = {}) => ({
    query: { start: "2026-10-27", end: "2026-11-02", ...query },
    brandKey: "BBB",
    brandDb: { sequelize: { query: jest.fn() } },
    tenantRoute: { timezone: "Asia/Kolkata" },
  });

  test("passes the validated level and basis to the service", async () => {
    const service = { getTopProducts: jest.fn().mockResolvedValue({ ok: true }) };
    const res = createRes();
    await buildIntentFunnelController({ intentFunnelService: service }).getTopProducts(
      req({ intent: "HIGH", basis: "score" }),
      res,
    );
    expect(res.body).toEqual({ ok: true });
    expect(service.getTopProducts).toHaveBeenCalledWith(
      expect.objectContaining({ brandKey: "BBB", start: "2026-10-27", end: "2026-11-02", intent: "high", basis: "score" }),
    );
  });

  test.each([[{ intent: "extreme" }, /intent/i], [{ basis: "nope" }, /basis/i]])("rejects %j", async (query, message) => {
    const service = { getTopProducts: jest.fn() };
    const res = createRes();
    await buildIntentFunnelController({ intentFunnelService: service }).getTopProducts(req(query), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(service.getTopProducts).not.toHaveBeenCalled();
  });
});
