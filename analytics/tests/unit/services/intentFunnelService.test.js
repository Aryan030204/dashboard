/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const {
  buildIntentFunnelService,
  createQueryCache,
  _internal,
} = require("../../../services/intentFunnelService");

function totalsRow(overrides = {}) {
  const row = {};
  ["visitors", "productViews", "pageViews", "addToCart", "checkouts", "scored"].forEach((id) => {
    ["cur", "prev"].forEach((period) => {
      row[`${period}_${id}_sessions`] = 0;
      row[`${period}_${id}_users`] = 0;
    });
  });
  return { ...row, ...overrides };
}

const DEFAULT_TOTALS = totalsRow({
  cur_visitors_sessions: 120,
  cur_visitors_users: 100,
  prev_visitors_sessions: 60,
  prev_visitors_users: 50,
  cur_productViews_sessions: 80,
  cur_productViews_users: 70,
  prev_productViews_users: 35,
  prev_productViews_sessions: 40,
  cur_pageViews_sessions: 118,
  cur_pageViews_users: 98,
  cur_addToCart_sessions: 30,
  cur_addToCart_users: 28,
  cur_checkouts_sessions: 12,
  cur_checkouts_users: 11,
  cur_scored_sessions: 60,
  cur_scored_users: 55,
});

const DEFAULT_BUCKETS = [
  {
    intent_bucket: "high",
    cur_sessions: 10, cur_users: 9, prev_sessions: 5, prev_users: 4,
    cur_atc_sessions: 8, cur_atc_users: 7, cur_checkout_sessions: 6, cur_checkout_users: 5,
  },
  {
    intent_bucket: "medium",
    cur_sessions: 20, cur_users: 18, prev_sessions: 20, prev_users: 18,
    cur_atc_sessions: 10, cur_atc_users: 9, cur_checkout_sessions: 4, cur_checkout_users: 4,
  },
  {
    intent_bucket: "low",
    cur_sessions: 30, cur_users: 28, prev_sessions: 0, prev_users: 0,
    cur_atc_sessions: 2, cur_atc_users: 2, cur_checkout_sessions: 0, cur_checkout_users: 0,
  },
];

const ROLLUP_ROWS = [
  { product_id: "111", title: "Serum", views: "500", add_to_cart: "50", checkouts: "15" },
  { product_id: "222", title: "Cleanser", views: "300", add_to_cart: "90", checkouts: "5" },
  { product_id: "333", title: null, views: "0", add_to_cart: "0", checkouts: "0" },
];

// Emulates "ORDER BY <expr> DESC, views DESC LIMIT n" from the query text.
function sortedRollup(rows, sql) {
  const column = sql.includes("ORDER BY SUM(add_to_cart_count)")
    ? "add_to_cart"
    : sql.includes("ORDER BY SUM(checkout_started_count)")
      ? "checkouts"
      : "views";
  return [...rows]
    .sort((a, b) => Number(b[column]) - Number(a[column]) || Number(b.views) - Number(a.views))
    .slice(0, 10);
}

function makeConn(overrides = {}) {
  const handlers = {
    rollup: (sql) => sortedRollup(ROLLUP_ROWS, sql),
    totals: () => [DEFAULT_TOTALS],
    buckets: () => DEFAULT_BUCKETS,
    trend: () => [
      { date: "2026-10-10", product_views: "100", add_to_carts: "20", checkout_starts: "5" },
      { date: "2026-10-12", product_views: "90", add_to_carts: "18", checkout_starts: "4" },
    ],
    productViews: () => [
      { product_id: "111", title: "Serum", views: "500", add_to_cart: "50" },
      { product_id: "222", title: "Cleanser", views: "300", add_to_cart: "90" },
      { product_id: "333", title: null, views: "0", add_to_cart: "0" },
    ],
    productCheckouts: () => [
      { product_id: "[111]", checkouts: "10" },
      { product_id: "[111, 222]", checkouts: "5" },
      { product_id: "[999]", checkouts: "7" },
    ],
    paths: () => [
      { sequence: "page_viewed>product_viewed>product_added_to_cart", sessions: "60", users: "55" },
      { sequence: "page_viewed>product_viewed", sessions: "30", users: "28" },
      { sequence: "page_viewed", sessions: "10", users: "10" },
    ],
    pathsTotal: () => [{ sessions: "100" }],
    ...overrides,
  };
  const query = jest.fn(async (sql, options) => {
    if (sql.includes("FROM behavioral_path_daily")) {
      return sql.includes("GROUP BY sequence_hash") ? handlers.paths(sql, options) : handlers.pathsTotal(sql, options);
    }
    if (sql.includes("FROM intent_daily_summary")) return handlers.trend(sql, options);
    if (sql.includes("FROM product_behavior_daily")) return handlers.rollup(sql, options);
    if (sql.includes("event_name = 'checkout_started'")) return handlers.productCheckouts(sql, options);
    if (sql.includes("FROM behavioral_events")) return handlers.productViews(sql, options);
    if (sql.includes("GROUP BY intent_bucket")) return handlers.buckets(sql, options);
    if (sql.includes("FROM intent_sessions")) return handlers.totals(sql, options);
    throw new Error(`unexpected sql: ${sql}`);
  });
  return { query };
}

function newService() {
  // fresh cache per test so cached results never leak between cases
  return buildIntentFunnelService({ cache: createQueryCache() });
}

const SPEC = {
  brandKey: "BBB",
  start: "2026-10-10",
  end: "2026-10-12",
  timezone: "Asia/Kolkata",
  intent: "all",
  sort: "views",
  pathStart: "page_viewed",
  pathTop: 5,
};

function assertFinite(value, path = "root") {
  if (typeof value === "number") {
    expect(Number.isFinite(value)).toBe(true);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => assertFinite(item, `${path}[${i}]`));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([k, v]) => assertFinite(v, `${path}.${k}`));
  }
}

describe("intentFunnelService", () => {
  test("KPI aggregation exposes users and sessions with period deltas", async () => {
    const conn = makeConn();
    const out = await newService().getIntentFunnel({ ...SPEC, conn });

    const byId = Object.fromEntries(out.kpis.map((k) => [k.id, k]));
    expect(out.kpis.map((k) => k.id)).toEqual([
      "visitors", "high", "medium", "low", "productViews", "pageViews", "addToCart", "checkouts",
    ]);
    expect(byId.visitors).toMatchObject({ value: 100, sessions: 120 });
    expect(byId.visitors.delta).toBeCloseTo(100); // 50 -> 100 users
    expect(byId.visitors.sessionsDelta).toBeCloseTo(100); // 60 -> 120 sessions
    expect(byId.productViews).toMatchObject({ value: 70, sessions: 80 });
    expect(byId.addToCart).toMatchObject({ value: 28, sessions: 30 });
    expect(byId.checkouts).toMatchObject({ value: 11, sessions: 12 });
    // previous period is zero -> no delta rather than Infinity
    expect(byId.addToCart.delta).toBeNull();
    expect(out.kpis.find((k) => k.id === "pageViews").label).toBe("Page Views");
  });

  test("date filtering uses an exclusive end and an equal-length previous period", async () => {
    const conn = makeConn();
    const out = await newService().getIntentFunnel({ ...SPEC, conn });

    const totalsCall = conn.query.mock.calls.find(
      ([sql]) => sql.includes("per_actor"),
    );
    const params = totalsCall[1].replacements;
    // last two params are the WHERE bounds: previous start, exclusive end
    expect(params.slice(-2)).toEqual(["2026-10-07", "2026-10-13"]);
    // every other param is the start of the current period
    expect(new Set(params.slice(0, -2))).toEqual(new Set(["2026-10-10"]));
    expect(totalsCall[0]).toMatch(/session_start < \?/);
    expect(out.meta.range).toEqual({ start: "2026-10-10", end: "2026-10-12" });
    expect(out.meta.previousRange).toEqual({ start: "2026-10-07", end: "2026-10-09" });

    const trendCall = conn.query.mock.calls.find(([sql]) => sql.includes("intent_daily_summary"));
    expect(trendCall[1].replacements).toEqual(["2026-10-10", "2026-10-12"]);

    // the product rollup is keyed by day, so it takes the same inclusive range as the trend
    const productCall = conn.query.mock.calls.find(([sql]) => sql.includes("FROM product_behavior_daily"));
    expect(productCall[1].replacements).toEqual(["2026-10-10", "2026-10-12"]);
  });

  test("high / medium / low KPIs, distribution and conversion come from the intent buckets", async () => {
    const out = await newService().getIntentFunnel({ ...SPEC, conn: makeConn() });

    const byId = Object.fromEntries(out.kpis.map((k) => [k.id, k]));
    expect(byId.high).toMatchObject({ value: 9, sessions: 10 });
    expect(byId.medium).toMatchObject({ value: 18, sessions: 20 });
    expect(byId.low).toMatchObject({ value: 28, sessions: 30 });
    expect(byId.high.delta).toBeCloseTo(125); // 4 -> 9 users

    // total is the sum of the segments (9 + 18 + 28); the distinct figure is separate
    expect(out.distribution.total).toBe(55);
    expect(out.distribution.totalSessions).toBe(60);
    expect(out.distribution.uniqueScoredUsers).toBe(55);
    expect(out.distribution.items.map((i) => i.level)).toEqual(["high", "medium", "low"]);
    const pctSum = out.distribution.items.reduce((sum, i) => sum + i.pct, 0);
    expect(pctSum).toBeCloseTo(100);

    const high = out.conversionRates.find((c) => c.level === "high");
    expect(high).toMatchObject({ users: 9, atc: 7, checkouts: 5, sessions: 10, sessionsCheckouts: 6 });
    expect(high.rate).toBeCloseTo((5 / 9) * 100);
    expect(high.sessionsRate).toBeCloseTo(60);
  });

  test("funnel percentages are relative to product views", async () => {
    const out = await newService().getIntentFunnel({ ...SPEC, conn: makeConn() });
    expect(out.funnel.map((f) => f.id)).toEqual(["product_views", "add_to_cart", "checkouts"]);
    expect(out.funnel[0]).toMatchObject({ users: 70, sessions: 80, pct: 100 });
    expect(out.funnel[1].pct).toBeCloseTo((28 / 70) * 100);
    expect(out.funnel[2].sessionsPct).toBeCloseTo((12 / 80) * 100);
  });

  test("trend returns the stored days only and does not fabricate missing dates", async () => {
    const out = await newService().getIntentFunnel({ ...SPEC, conn: makeConn() });
    expect(out.trend).toEqual([
      { date: "2026-10-10", productViews: 100, addToCart: 20, checkouts: 5 },
      { date: "2026-10-12", productViews: 90, addToCart: 18, checkouts: 4 },
    ]);
  });

  test("empty data returns zeros, never NaN / Infinity", async () => {
    const conn = makeConn({
      totals: () => [totalsRow()],
      buckets: () => [],
      trend: () => [],
      rollup: () => [],
      productViews: () => [],
      productCheckouts: () => [],
      paths: () => [],
      pathsTotal: () => [{ sessions: null }],
    });
    const out = await newService().getIntentFunnel({ ...SPEC, conn });

    assertFinite(out);
    expect(out.kpis.every((k) => k.value === 0 && k.sessions === 0)).toBe(true);
    expect(out.kpis.every((k) => k.delta === null)).toBe(true);
    expect(out.funnel.every((f) => f.pct === 0)).toBe(true);
    expect(out.conversionRates.every((c) => c.rate === 0 && c.sessionsRate === 0)).toBe(true);
    expect(out.distribution.items.every((i) => i.pct === 0)).toBe(true);
    expect(out.trend).toEqual([]);
    expect(out.topProducts).toEqual([]);
    expect(out.paths.nodes).toEqual([]);
    expect(out.paths.coverage.pct).toBe(100);
  });

  test("a bucket with no sessions stays zero while others are unaffected", async () => {
    const conn = makeConn({ buckets: () => [DEFAULT_BUCKETS[0]] });
    const out = await newService().getIntentFunnel({ ...SPEC, conn });
    const low = out.conversionRates.find((c) => c.level === "low");
    expect(low).toMatchObject({ users: 0, checkouts: 0, rate: 0 });
    assertFinite(out);
  });

  describe("top products", () => {
    const MISSING = Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });

    test("reads the daily rollup: one query, ranked in SQL, result shape unchanged", async () => {
      const conn = makeConn();
      const out = await newService().getIntentFunnel({ ...SPEC, conn });
      expect(out.topProducts.map((p) => p.id)).toEqual(["111", "222", "333"]);
      expect(out.topProducts[0]).toMatchObject({ id: "111", name: "Serum", views: 500, addToCart: 50, checkouts: 15 });
      expect(out.topProducts[0].cvr).toBeCloseTo(3);
      // product without a title and without views: placeholder name, no division by zero
      expect(out.topProducts[2]).toMatchObject({ name: "Product 333", cvr: 0 });
      expect(out.meta.sources.topProducts).toBe("product_behavior_daily");

      const rollupCalls = conn.query.mock.calls.filter(([sql]) => sql.includes("FROM product_behavior_daily"));
      expect(rollupCalls).toHaveLength(1);
      expect(rollupCalls[0][1].replacements).toEqual([SPEC.start, SPEC.end]);
      // the rollup replaces both raw-event scans
      expect(conn.query.mock.calls.some(([sql]) => sql.includes("FROM behavioral_events"))).toBe(false);
    });

    test("sort is applied through a whitelist, in SQL, over every product (add_to_cart, checkouts)", async () => {
      const connCart = makeConn();
      const byCart = await newService().getIntentFunnel({ ...SPEC, sort: "add_to_cart", conn: connCart });
      expect(byCart.topProducts[0].id).toBe("222");
      const cartSql = connCart.query.mock.calls.map(([sql]) => sql).find((sql) => sql.includes("product_behavior_daily"));
      expect(cartSql).toContain("ORDER BY SUM(add_to_cart_count) DESC, views DESC");

      const connCheckouts = makeConn();
      const byCheckouts = await newService().getIntentFunnel({ ...SPEC, sort: "checkouts", conn: connCheckouts });
      expect(byCheckouts.topProducts[0].id).toBe("111");
      const checkoutsSql = connCheckouts.query.mock.calls.map(([sql]) => sql).find((sql) => sql.includes("product_behavior_daily"));
      expect(checkoutsSql).toContain("ORDER BY SUM(checkout_started_count) DESC, views DESC");
    });

    test("an unknown sort never reaches SQL and falls back to views", async () => {
      const conn = makeConn();
      const out = await newService().getIntentFunnel({
        ...SPEC, sort: "views; DROP TABLE x", conn,
      });
      expect(out.topProducts[0].id).toBe("111");
      conn.query.mock.calls.forEach(([sql]) => expect(sql).not.toMatch(/DROP TABLE/i));
      const sql = conn.query.mock.calls.map(([q]) => q).find((q) => q.includes("product_behavior_daily"));
      expect(sql).toContain("ORDER BY SUM(product_views) DESC, views DESC");
    });

    test("a slow product query degrades that section only", async () => {
      const timeout = Object.assign(new Error("timeout"), { code: "ER_QUERY_TIMEOUT", errno: 3024 });
      const conn = makeConn({ rollup: () => { throw timeout; } });
      const out = await newService().getIntentFunnel({ ...SPEC, conn });
      expect(out.topProducts).toEqual([]);
      expect(out.meta.sections.topProducts).toEqual({ available: false, reason: "timeout" });
      expect(out.kpis[0].value).toBe(100);
      expect(out.paths.nodes.length).toBeGreaterThan(0);
    });

    test("a brand database without the rollup table falls back to the raw events, results as before", async () => {
      const conn = makeConn({ rollup: () => { throw MISSING; } });
      const out = await newService().getIntentFunnel({ ...SPEC, conn });
      expect(out.meta.sources.topProducts).toBe("behavioral_events");
      expect(out.meta.sections.topProducts).toBeUndefined();
      expect(out.topProducts.map((p) => p.id)).toEqual(["111", "222", "333"]);
      expect(out.topProducts[0]).toMatchObject({ name: "Serum", views: 500, addToCart: 50, checkouts: 15 });
      // checkout rows for products outside the viewed set are ignored
      expect(out.topProducts.find((p) => p.id === "999")).toBeUndefined();
      expect(conn.query.mock.calls.filter(([sql]) => sql.includes("FROM behavioral_events"))).toHaveLength(2);
    });

    test("the fallback still honours the sort whitelist", async () => {
      const conn = makeConn({ rollup: () => { throw MISSING; } });
      const out = await newService().getIntentFunnel({ ...SPEC, sort: "add_to_cart", conn });
      expect(out.topProducts[0].id).toBe("222");
    });

    test("every row the rollup query returns is kept (no scan cut-off in Node)", async () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({
        product_id: String(1000 + i), title: `P${i}`, views: String(100 - i), add_to_cart: "1", checkouts: String(i),
      }));
      const out = await newService().getIntentFunnel({ ...SPEC, conn: makeConn({ rollup: () => rows }) });
      expect(out.topProducts).toHaveLength(10);
    });
  });

  describe("path exploration", () => {
    test("builds steps, nodes and links from recorded event sequences", async () => {
      const out = await newService().getIntentFunnel({ ...SPEC, conn: makeConn() });
      const { nodes, links, steps, coverage } = out.paths;

      expect(steps).toHaveLength(5);
      expect(steps[0]).toMatchObject({ step: 1, title: "Page View", sessions: 100 });

      const stepNode = (step, state) => nodes.find((n) => n.step === step && n.state === state);
      expect(stepNode(1, "product_viewed").value).toBe(90);
      expect(stepNode(1, "exit").value).toBe(10);
      expect(stepNode(2, "product_added_to_cart").value).toBe(60);
      expect(stepNode(2, "exit").value).toBe(40);
      // exit keeps flowing to later steps
      expect(stepNode(4, "exit").value).toBe(100);
      expect(stepNode(1, "product_viewed").pct).toBeCloseTo(90);
      expect(stepNode(1, "product_viewed").name).toBe("Product View");

      const link = links.find(
        (l) => nodes[l.source].key === "0:page_viewed" && nodes[l.target].key === "1:product_viewed",
      );
      expect(link.value).toBe(90);
      expect(coverage).toEqual({ sessions: 100, totalSessions: 100, pct: 100 });
    });

    test("keeps only the top N nodes per step", () => {
      const rows = [
        { sequence: "page_viewed>click", sessions: 50 },
        { sequence: "page_viewed>product_viewed", sessions: 30 },
        { sequence: "page_viewed>product_added_to_cart", sessions: 20 },
        { sequence: "page_viewed", sessions: 5 },
      ];
      const paths = _internal.buildPaths(rows, { topN: 2 });
      const stepTwo = paths.nodes.filter((n) => n.step === 1);
      expect(stepTwo.map((n) => n.state)).toEqual(["click", "product_viewed"]);
      paths.links.forEach((l) => {
        expect(paths.nodes[l.source]).toBeDefined();
        expect(paths.nodes[l.target]).toBeDefined();
      });
    });

    test("reports partial coverage when the bounded query cuts off the long tail", async () => {
      const conn = makeConn({ pathsTotal: () => [{ sessions: "400" }] });
      const out = await newService().getIntentFunnel({ ...SPEC, conn });
      expect(out.paths.coverage).toEqual({ sessions: 100, totalSessions: 400, pct: 25 });
    });

    test("the start event only ever reaches SQL as a bound parameter", async () => {
      const conn = makeConn();
      await newService().getIntentFunnel({ ...SPEC, pathStart: "product_viewed", conn });
      const pathCall = conn.query.mock.calls.find(([sql]) => sql.includes("GROUP BY sequence_hash"));
      expect(pathCall[1].replacements).toEqual(["2026-10-10", "2026-10-12", "product_viewed"]);
      expect(pathCall[0]).not.toContain("product_viewed");
    });

    test("intent filtering is reported as unsupported instead of being faked", async () => {
      const out = await newService().getIntentFunnel({ ...SPEC, intent: "high", conn: makeConn() });
      expect(out.meta.intentFilterSupported).toBe(false);
      expect(out.filters.intent).toBe("high");
    });
  });

  describe("brand databases without usable intent data", () => {
    test("missing intent tables return an unavailable payload, not an error", async () => {
      const missing = Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
      const conn = makeConn({ totals: () => { throw missing; }, buckets: () => { throw missing; } });
      const out = await newService().getIntentFunnel({ ...SPEC, conn });
      expect(out.meta).toMatchObject({ available: false, reason: "intent_tables_missing" });
      expect(out.kpis).toEqual([]);
      assertFinite(out);
    });

    test("an older intent_sessions layout is reported as unsupported", async () => {
      const bad = Object.assign(new Error("Unknown column"), { code: "ER_BAD_FIELD_ERROR", errno: 1054 });
      const conn = makeConn({ totals: () => { throw bad; }, buckets: () => { throw bad; } });
      const out = await newService().getIntentFunnel({ ...SPEC, conn });
      expect(out.meta).toMatchObject({ available: false, reason: "intent_schema_unsupported" });
    });

    test("missing optional tables only disable that section", async () => {
      const missing = Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
      const conn = makeConn({ trend: () => { throw missing; }, paths: () => { throw missing; } });
      const out = await newService().getIntentFunnel({ ...SPEC, conn });
      expect(out.meta.available).toBe(true);
      expect(out.trend).toEqual([]);
      expect(out.paths.nodes).toEqual([]);
      expect(out.meta.sections.trend.reason).toBe("table_missing");
      expect(out.kpis[0].value).toBe(100);
    });

    test("unexpected database failures propagate to the controller error handler", async () => {
      const boom = Object.assign(new Error("connection lost"), { code: "PROTOCOL_CONNECTION_LOST" });
      const conn = makeConn({ totals: () => { throw boom; } });
      await expect(newService().getIntentFunnel({ ...SPEC, conn })).rejects.toThrow("connection lost");
    });
  });

  describe("query safety and tenant isolation", () => {
    test("only the connection passed in the spec is used and no SQL embeds request values", async () => {
      const conn = makeConn();
      await newService().getIntentFunnel({
        ...SPEC, brandKey: "BBB", pathStart: "page_viewed", sort: "views", conn,
      });
      expect(conn.query).toHaveBeenCalled();
      conn.query.mock.calls.forEach(([sql, options]) => {
        expect(sql).not.toMatch(/select\s+\*/i);
        expect(sql).not.toContain("BBB");
        expect(sql).not.toContain("2026-10");
        expect(Array.isArray(options.replacements)).toBe(true);
      });
    });

    test("all independent queries run in one round (no per-day / per-bucket / per-product queries)", async () => {
      const conn = makeConn();
      await newService().getIntentFunnel({ ...SPEC, start: "2026-09-01", end: "2026-10-12", conn });
      // totals, buckets, trend, product rollup, paths, paths total
      expect(conn.query).toHaveBeenCalledTimes(6);
    });

    test("cached results are keyed by brand and never cross tenants", async () => {
      const service = newService();
      const connA = makeConn();
      const connB = makeConn({ totals: () => [totalsRow({ cur_visitors_users: 5 })] });
      const a = await service.getIntentFunnel({ ...SPEC, brandKey: "BBB", conn: connA });
      const b = await service.getIntentFunnel({ ...SPEC, brandKey: "PTS", conn: connB });
      expect(a.kpis[0].value).toBe(100);
      expect(b.kpis[0].value).toBe(5);
      expect(connB.query).toHaveBeenCalled();
    });

    test("changing sort or path controls reuses cached heavy queries", async () => {
      const service = newService();
      const conn = makeConn();
      await service.getIntentFunnel({ ...SPEC, conn });
      const firstCalls = conn.query.mock.calls.length;
      await service.getIntentFunnel({ ...SPEC, sort: "checkouts", conn });
      // the sort is part of the (cheap, indexed) product query, so only that one re-runs
      expect(conn.query.mock.calls.length).toBe(firstCalls + 1);
      await service.getIntentFunnel({ ...SPEC, pathStart: "product_viewed", conn });
      expect(conn.query.mock.calls.length).toBe(firstCalls + 1 + 2);
    });

    test("failures are not cached", async () => {
      const service = newService();
      let fail = true;
      const conn = makeConn({
        totals: () => {
          if (fail) throw Object.assign(new Error("flaky"), { code: "ETIMEDOUT" });
          return [DEFAULT_TOTALS];
        },
      });
      await expect(service.getIntentFunnel({ ...SPEC, conn })).rejects.toThrow("flaky");
      fail = false;
      const out = await service.getIntentFunnel({ ...SPEC, conn });
      expect(out.kpis[0].value).toBe(100);
    });
  });

  describe("correctness guards", () => {
    test("distribution segments always add up to the total, even when a visitor is in two buckets", async () => {
      // 55 distinct scored visitors, but a visitor can have sessions in several buckets
      const buckets = [
        { ...DEFAULT_BUCKETS[0], cur_users: 40, cur_sessions: 50 },
        { ...DEFAULT_BUCKETS[1], cur_users: 30, cur_sessions: 35 },
        { ...DEFAULT_BUCKETS[2], cur_users: 20, cur_sessions: 25 },
      ];
      const out = await newService().getIntentFunnel({ ...SPEC, conn: makeConn({ buckets: () => buckets }) });
      const { total, totalSessions, uniqueScoredUsers, items } = out.distribution;
      expect(total).toBe(items.reduce((sum, i) => sum + i.users, 0));
      expect(totalSessions).toBe(items.reduce((sum, i) => sum + i.sessions, 0));
      expect(total).toBe(90);
      expect(uniqueScoredUsers).toBe(55);
    });

    test("funnel percentages never exceed 100 when later steps outnumber product viewers", async () => {
      const totals = totalsRow({
        cur_productViews_users: 10, cur_productViews_sessions: 12,
        cur_addToCart_users: 25, cur_addToCart_sessions: 30,
        cur_checkouts_users: 11, cur_checkouts_sessions: 12,
      });
      const out = await newService().getIntentFunnel({ ...SPEC, conn: makeConn({ totals: () => [totals] }) });
      out.funnel.forEach((step) => {
        expect(step.pct).toBeLessThanOrEqual(100);
        expect(step.sessionsPct).toBeLessThanOrEqual(100);
      });
      expect(out.funnel[1].pct).toBe(100);
      expect(out.funnel[1].users).toBe(25); // the real count is not altered, only the share
    });

    test("both core queries carry an execution timeout", async () => {
      const conn = makeConn();
      await newService().getIntentFunnel({ ...SPEC, conn });
      const core = conn.query.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => sql.includes("FROM intent_sessions"));
      expect(core).toHaveLength(2);
      core.forEach((sql) => expect(sql).toMatch(/SELECT \/\*\+ MAX_EXECUTION_TIME\(30000\) \*\//));
    });

    test("a core query timeout propagates so the controller can answer 504", async () => {
      const timeout = Object.assign(new Error("timeout"), { code: "ER_QUERY_TIMEOUT", errno: 3024 });
      const conn = makeConn({ totals: () => { throw timeout; } });
      await expect(newService().getIntentFunnel({ ...SPEC, conn })).rejects.toThrow("timeout");
    });
  });

  describe("helpers", () => {
    test("safePct and pctChange guard zero denominators", () => {
      expect(_internal.safePct(5, 0)).toBe(0);
      expect(_internal.safePct(1, 4)).toBe(25);
      expect(_internal.pctChange(5, 0)).toBeNull();
      expect(_internal.pctChange(150, 100)).toBe(50);
    });

    test("extractProductIds handles list-like and plain ids", () => {
      expect(_internal.extractProductIds("[123]")).toEqual(["123"]);
      expect(_internal.extractProductIds("[123, 456]")).toEqual(["123", "456"]);
      expect(_internal.extractProductIds("789")).toEqual(["789"]);
      expect(_internal.extractProductIds(null)).toEqual([]);
    });
  });
});
