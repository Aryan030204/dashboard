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

// Score view visitors: ONE level per visitor (the bucket of their highest-scoring session), so these add up to the
// scored visitors. They differ from the per-bucket distinct counts in DEFAULT_BUCKETS on purpose (a visitor with a
// low and a high session is in both of those, in only one of these).
const DEFAULT_SCORE_VISITORS = [
  {
    cur_high_users: 8, cur_medium_users: 17, cur_low_users: 27,
    prev_high_users: 3, prev_medium_users: 16, prev_low_users: 30,
  },
];

// behaviour-based levels: one row; users are counted once at their best level, bots are left out of the levels
const DEFAULT_BEHAVIOR = [
  {
    cur_high_sessions: 10, cur_medium_sessions: 40, cur_low_sessions: 50, cur_bot_sessions: 4,
    cur_high_users: 9, cur_medium_users: 30, cur_low_users: 41,
    prev_high_sessions: 10, prev_medium_sessions: 30, prev_low_sessions: 40, prev_bot_sessions: 2,
    prev_high_users: 9, prev_medium_users: 24, prev_low_users: 32,
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
    behavior: () => DEFAULT_BEHAVIOR,
    openSessions: () => [{ open_sessions: "20" }],
    scoreVisitors: () => DEFAULT_SCORE_VISITORS,
    started: () => [{ cur_started: "300", prev_started: "200" }],
    live: () => [],
    closedBest: () => [],
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
    if (sql.includes("sessions_started")) return handlers.started(sql, options);
    if (sql.includes("FROM intent_daily_summary")) return handlers.trend(sql, options);
    if (sql.includes("FROM product_behavior_daily")) return handlers.rollup(sql, options);
    if (sql.includes("event_name = 'checkout_started'")) return handlers.productCheckouts(sql, options);
    if (sql.includes("FROM behavioral_events")) return handlers.productViews(sql, options);
    if (sql.includes("open_sessions")) return handlers.openSessions(sql, options);
    if (sql.includes("FROM intent_actor_cursors")) return handlers.live(sql, options);
    if (sql.includes("best_rank")) return handlers.closedBest(sql, options);
    if (sql.includes("GROUP_CONCAT")) return handlers.scoreVisitors(sql, options);
    if (sql.includes(") levelled")) return handlers.behavior(sql, options);
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
    // visitors: one level each (the bucket of their highest-scoring session); sessions: per bucket
    expect(byId.high).toMatchObject({ value: 8, sessions: 10 });
    expect(byId.medium).toMatchObject({ value: 17, sessions: 20 });
    expect(byId.low).toMatchObject({ value: 27, sessions: 30 });
    expect(byId.high.delta).toBeCloseTo((5 / 3) * 100); // 3 -> 8 visitors

    // total = Low + Medium + High = the scored visitors, each counted once
    expect(out.distribution.total).toBe(52);
    expect(out.distribution.totalSessions).toBe(60);
    expect(out.distribution.uniqueScoredUsers).toBe(52);
    expect(out.distribution.visitorBasis).toBe("best_session");
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
      scoreVisitors: () => [{ cur_high_users: 0, cur_medium_users: 0, cur_low_users: 0, prev_high_users: 0, prev_medium_users: 0, prev_low_users: 0 }],
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
      // totals, buckets, trend, product rollup, paths, paths total, behaviour levels, sessions started, live
      // sessions, open-session count, score visitors
      expect(conn.query).toHaveBeenCalledTimes(11);
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
    test("a visitor with sessions in two buckets is counted once: the segments add up to the scored visitors", async () => {
      // 90 visitor-bucket pairs (a visitor can have sessions in several buckets), but 55 scored visitors, one level each
      const buckets = [
        { ...DEFAULT_BUCKETS[0], cur_users: 40, cur_sessions: 50 },
        { ...DEFAULT_BUCKETS[1], cur_users: 30, cur_sessions: 35 },
        { ...DEFAULT_BUCKETS[2], cur_users: 20, cur_sessions: 25 },
      ];
      const visitors = [{ cur_high_users: 15, cur_medium_users: 20, cur_low_users: 20, prev_high_users: 0, prev_medium_users: 0, prev_low_users: 0 }];
      const out = await newService().getIntentFunnel({
        ...SPEC, conn: makeConn({ buckets: () => buckets, scoreVisitors: () => visitors }),
      });
      const { total, totalSessions, uniqueScoredUsers, items, visitorBasis } = out.distribution;
      expect(total).toBe(items.reduce((sum, i) => sum + i.users, 0));
      expect(totalSessions).toBe(items.reduce((sum, i) => sum + i.sessions, 0));
      expect(total).toBe(55);                       // not 90
      expect(uniqueScoredUsers).toBe(55);
      expect(visitorBasis).toBe("best_session");
      expect(items.reduce((sum, i) => sum + i.pct, 0)).toBeCloseTo(100);
    });

    test("without the visitor query the old per-bucket count is used and labelled as such", async () => {
      const bad = Object.assign(new Error("Unknown column"), { code: "ER_BAD_FIELD_ERROR", errno: 1054 });
      const out = await newService().getIntentFunnel({ ...SPEC, conn: makeConn({ scoreVisitors: () => { throw bad; } }) });
      expect(out.distribution.visitorBasis).toBe("per_bucket");
      expect(out.distribution.total).toBe(55);      // 9 + 18 + 28, a visitor may be in two buckets
      expect(out.meta.sections.scoreVisitors).toEqual({ available: false, reason: "schema_unsupported" });
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

    test("every query that scans intent_sessions carries an execution timeout", async () => {
      const conn = makeConn();
      await newService().getIntentFunnel({ ...SPEC, conn });
      const core = conn.query.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => sql.includes("FROM intent_sessions"));
      expect(core).toHaveLength(4); // totals, score buckets, behaviour levels, score visitors
      core.forEach((sql) => expect(sql).toMatch(/SELECT \/\*\+ MAX_EXECUTION_TIME\(30000\) \*\//));
    });

    test("a core query timeout propagates so the controller can answer 504", async () => {
      const timeout = Object.assign(new Error("timeout"), { code: "ER_QUERY_TIMEOUT", errno: 3024 });
      const conn = makeConn({ totals: () => { throw timeout; } });
      await expect(newService().getIntentFunnel({ ...SPEC, conn })).rejects.toThrow("timeout");
    });
  });

  describe("behaviour-based intent (every session, each visitor at their best level)", () => {
    test("returns sessions and users per level, bots left out, and the three intent KPI cards", async () => {
      const { behavior } = await newService().getIntentFunnel({ ...SPEC, conn: makeConn() });
      expect(behavior.distribution.items.map((i) => [i.level, i.sessions, i.users])).toEqual([
        ["high", 10, 9],
        ["medium", 40, 30],
        ["low", 50, 41],
      ]);
      expect(behavior.distribution.total).toBe(80);             // visitors, each counted once
      expect(behavior.distribution.totalSessions).toBe(100);    // bots are not in it
      expect(behavior.distribution.botsExcluded).toBe(4);
      expect(behavior.kpis.map((k) => k.id)).toEqual(["high", "medium", "low"]);
      const low = behavior.kpis.find((k) => k.id === "low");
      expect(low).toMatchObject({ value: 41, sessions: 50 });
      expect(low.sessionsDelta).toBeCloseTo(25);                // 40 -> 50 sessions
    });

    test("a visitor is counted once, at their best level, so the three counts add up to the visitors", () => {
      const sql = _internal.buildBehaviorQuery({ prevStart: "a", curStart: "b", endExclusive: "c" }).sql;
      const flat = sql.replace(/\s+/g, " ");
      expect(flat).toContain("COALESCE(SUM(cur_h > 0), 0) AS cur_high_users");
      expect(flat).toContain("COALESCE(SUM(cur_h = 0 AND cur_m > 0), 0) AS cur_medium_users");
      expect(flat).toContain("COALESCE(SUM(cur_h = 0 AND cur_m = 0 AND cur_l > 0), 0) AS cur_low_users");
      expect(flat).toContain("GROUP BY actor_id");
    });

    test("it reads every closed session and binds only dates; the score buckets are unchanged", async () => {
      const { sql, params } = _internal.buildBehaviorQuery({
        prevStart: "2026-10-07", curStart: "2026-10-10", endExclusive: "2026-10-13",
      });
      expect(sql).not.toContain("intent_status");
      expect(sql).toContain("session_time_spent_ms IS NOT NULL");
      expect(sql).not.toContain("2026-10");
      expect(params).toEqual(["2026-10-10", "2026-10-07", "2026-10-13"]);
      const out = await newService().getIntentFunnel({ ...SPEC, conn: makeConn() });
      expect(out.distribution.items.map((i) => i.users)).toEqual([8, 17, 27]);
      expect(out.distribution.items.map((i) => i.sessions)).toEqual([10, 20, 30]);   // score sessions unchanged
    });

    test("the rules are in SQL in the Clarity order: bots out, then low, then high, else medium", () => {
      expect(_internal.BEHAVIOR_LEVEL_SQL.replace(/\s+/g, " ")).toBe(
        "CASE WHEN intent_exclusion_reason = 'bot' THEN 'bot' " +
          "WHEN session_time_spent_ms < 5000 OR (click_count = 0 AND scroll_count = 0) THEN 'low' " +
          "WHEN click_count > 0 AND (add_to_cart_count > 0 OR checkout_started_count > 0) THEN 'high' " +
          "ELSE 'medium' END",
      );
    });

    test("live sessions are merged at their current level and the total reconciles", async () => {
      const START = new Date("2026-10-12T10:00:00Z");
      const cursors = [
        // a 2-second bounce: low straight away
        { actor_id: "bounce", session_start: START, last_event_at: new Date(START.getTime() + 2000),
          events_seq: { 1: { event_name: "page_viewed" } } },
        // browsing, clicked a product and added to cart: high, and the visitor was already counted as low
        { actor_id: "shopper", session_start: START, last_event_at: new Date(START.getTime() + 300000),
          events_seq: JSON.stringify({ 1: { event_name: "page_viewed" }, 2: { event_name: "product_viewed" },
            3: { event_name: "click" }, 4: { event_name: "product_added_to_cart" } }) },
      ];
      const conn = makeConn({ live: () => cursors, closedBest: () => [{ actor_id: "shopper", best_rank: 1 }] });
      const out = await newService().getIntentFunnel({ ...SPEC, conn });
      const items = Object.fromEntries(out.behavior.distribution.items.map((i) => [i.level, i]));
      expect(items.low).toMatchObject({ sessions: 51, users: 41 });    // 50 -> 51 sessions; visitors 41 +1 (the bounce) -1 (the shopper moved up)
      expect(items.high).toMatchObject({ sessions: 11, users: 10 });   // +1 session, +1 visitor (the shopper)
      expect(out.behavior.live.sessions).toBe(2);
      expect(out.sessionsStarted).toMatchObject({ live: 2 });
      const card = out.sessionsStarted;
      expect(card.analysed + card.bots + card.live + card.waiting + card.other).toBe(card.value);
    });

    test("without the open-session table the levels cover closed sessions only", async () => {
      const missing = Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
      const out = await newService().getIntentFunnel({ ...SPEC, conn: makeConn({ live: () => { throw missing; } }) });
      expect(out.meta.sections.liveSessions).toEqual({ available: false, reason: "table_missing" });
      expect(out.behavior.distribution.totalSessions).toBe(100);
      expect(out.sessionsStarted.live).toBe(0);
    });

    test("the live query only reads a recent window, ignores far-future times, and binds only dates", () => {
      const { sql, params } = _internal.buildLiveSessionsQuery({ curStart: "2026-10-27", endExclusive: "2026-10-28" });
      const flat = sql.replace(/\s+/g, " ");
      expect(flat).toContain("UTC_TIMESTAMP() + INTERVAL 14 HOUR");
      expect(flat).toContain("- INTERVAL 90 MINUTE");
      expect(flat).toContain("LIMIT 20000");
      expect(flat).not.toContain("2026-10");
      expect(params).toEqual(["2026-10-27", "2026-10-28"]);
    });

    test("closed-level lookups are chunked and never include bots", () => {
      const ids = Array.from({ length: 2500 }, (_, i) => `a${i}`);
      const queries = _internal.buildClosedBestQueries({ actorIds: ids, curStart: "x", endExclusive: "y" });
      expect(queries).toHaveLength(3);
      expect(queries[0].params[0]).toHaveLength(1000);
      expect(queries[2].params[0]).toHaveLength(500);
      expect(queries[0].sql).toContain("lvl <> 'bot'");
    });

    test("a database without the column degrades only this section; no sessions gives zeros", async () => {
      const bad = Object.assign(new Error("Unknown column"), { code: "ER_BAD_FIELD_ERROR", errno: 1054 });
      const out = await newService().getIntentFunnel({ ...SPEC, conn: makeConn({ behavior: () => { throw bad; } }) });
      expect(out.behavior).toBeNull();
      expect(out.meta.sections.behavior).toEqual({ available: false, reason: "schema_unsupported" });
      const empty = _internal.buildBehavior([]);
      assertFinite(empty);
      expect(empty.distribution.total).toBe(0);
    });
  });

  describe("behaviour High: a product view alone is not a High signal", () => {
    test("the SQL never lists product views as a High trigger", () => {
      const sql = _internal.BEHAVIOR_LEVEL_SQL.replace(/\s+/g, " ");
      const high = sql.slice(sql.indexOf("THEN 'low'"), sql.indexOf("THEN 'high'"));
      expect(high).toContain("add_to_cart_count > 0");
      expect(high).toContain("checkout_started_count > 0");
      expect(high).not.toContain("product_view_count");
    });

    test("the rule text shown to people says add to cart or checkout", async () => {
      const { behavior } = await newService().getIntentFunnel({ ...SPEC, conn: makeConn() });
      expect(behavior.rules.high).toContain("add to cart or checkout");
      expect(behavior.rules.high).not.toContain("product view");
    });
  });

  describe("score visitors: one level per visitor, the bucket of their highest-scoring session", () => {
    test("the query ranks each visitor's sessions by score and keeps only the best one's bucket", () => {
      const { sql, params } = _internal.buildScoreVisitorsQuery({
        prevStart: "2026-10-07", curStart: "2026-10-10", endExclusive: "2026-10-13",
      });
      const flat = sql.replace(/\s+/g, " ");
      expect(flat).toContain("ORDER BY predictive_score DESC, session_id");
      expect(flat).toContain("SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN is_cur = 1 THEN intent_bucket END");
      expect(flat).toContain("', ', 1)".replace(" ", "")) ;
      expect(flat).toContain("GROUP BY actor_id");
      expect(flat).toContain("intent_status = 'scored'");              // pending and excluded sessions have no level
      expect(flat).toContain("COALESCE(SUM(cur_best = 'high'), 0) AS cur_high_users");
      expect(flat).not.toContain("COUNT(DISTINCT");                    // no per-bucket distinct counting
      expect(flat).not.toContain("2026-10");
      expect(params).toEqual(["2026-10-10", "2026-10-07", "2026-10-13"]);
    });

    test("it carries the same execution timeout as the other session queries", () => {
      const { sql } = _internal.buildScoreVisitorsQuery({ prevStart: "a", curStart: "b", endExclusive: "c" });
      expect(sql).toMatch(/SELECT \/\*\+ MAX_EXECUTION_TIME\(30000\) \*\//);
    });

    test("one session, many Low sessions, Low + High, Low + Medium + High: each visitor is in exactly one level", () => {
      // The SQL gives one row of exclusive counts; the builders must pass them through untouched and add up.
      // Visitors: A one session (low); B three low sessions (low); C low + high (high); D low + medium + high (high);
      // E medium only (medium). Exclusive counts: high 2 (C, D), medium 1 (E), low 2 (A, B).
      const row = [{ cur_high_users: 2, cur_medium_users: 1, cur_low_users: 2, prev_high_users: 0, prev_medium_users: 0, prev_low_users: 0 }];
      const visitors = _internal.buildScoreVisitors(row);
      const buckets = {
        high: { cur_sessions: 3, cur_users: 2 }, medium: { cur_sessions: 2, cur_users: 2 }, low: { cur_sessions: 7, cur_users: 4 },
      };
      const distribution = _internal.buildDistribution({}, buckets, visitors);
      expect(distribution.items.map((i) => [i.level, i.users])).toEqual([["high", 2], ["medium", 1], ["low", 2]]);
      expect(distribution.total).toBe(5);                                       // five visitors, five levels
      expect(distribution.totalSessions).toBe(12);                              // sessions are untouched
      const kpis = _internal.buildKpis({}, buckets, visitors).filter((k) => ["high", "medium", "low"].includes(k.id));
      expect(kpis.map((k) => [k.id, k.value, k.sessions])).toEqual([["high", 2, 3], ["medium", 1, 2], ["low", 2, 7]]);
    });

    test("a visitor with only pending or excluded sessions is not in the levels", () => {
      // no scored session, so the query returns no level for them: nothing is counted
      const visitors = _internal.buildScoreVisitors([{ cur_high_users: 0, cur_medium_users: 0, cur_low_users: 0 }]);
      expect(_internal.buildDistribution({}, {}, visitors).total).toBe(0);
      expect(_internal.buildScoreVisitors([])).toBeNull();
    });
  });

  describe("Total Sessions: one canonical definition that reconciles with the distribution", () => {
    const totals = { cur_visitors_sessions: 12378 };

    test("total = finished rows + open sessions; everything else is a part of it", () => {
      const card = _internal.buildSessionsStarted([{ cur_started: "12228", prev_started: "10000" }], totals, 1, [{ open_sessions: "40" }], 25);
      expect(card.value).toBe(12418);                       // 12,378 finished + 40 open
      expect(card).toMatchObject({ closed: 12378, bots: 25, analysed: 12353, live: 1, waiting: 39, other: 0 });
      expect(card.analysed + card.bots + card.live + card.waiting + card.other).toBe(card.value);
    });

    test("the rollup's figure can be behind the live tables and the card says by how much", () => {
      // the case seen in production: the rollup said 12,228 while 12,378 sessions were already finished
      const card = _internal.buildSessionsStarted([{ cur_started: "12228", prev_started: "10000" }], totals, 1, [{ open_sessions: "1" }], 0);
      expect(card.value).toBeGreaterThanOrEqual(card.closed);          // never below what is already analysed
      expect(card.rollup).toBe(12228);
      expect(card.rollupBehind).toBe(card.value - 12228);
      expect(card.rollupBehind).toBeGreaterThan(0);
    });

    test("the change figure compares with the rollup's previous period", () => {
      const card = _internal.buildSessionsStarted([{ cur_started: "100", prev_started: "100" }], { cur_visitors_sessions: 150 }, 0, [{ open_sessions: "50" }], 0);
      expect(card.value).toBe(200);
      expect(card.delta).toBeCloseTo(100);
    });

    test("without the open-session table the rollup is used, never below the analysed sessions", () => {
      const card = _internal.buildSessionsStarted([{ cur_started: "100" }], { cur_visitors_sessions: 150 }, 3, null, 0);
      expect(card.value).toBe(153);                         // max(rollup, finished + live)
      expect(card.waiting).toBe(0);
    });

    test("with no rollup column the open-session count alone is enough", () => {
      const card = _internal.buildSessionsStarted(null, { cur_visitors_sessions: 90 }, 2, [{ open_sessions: "10" }], 0);
      expect(card.value).toBe(100);
      expect(card.delta).toBeNull();
      expect(card.rollup).toBeNull();
    });

    test("with neither source there is no card", () => {
      expect(_internal.buildSessionsStarted(null, totals, 0, null, 0)).toBeNull();
      expect(_internal.buildSessionsStarted([{ cur_started: null }], totals, 0, [], 0)).toBeNull();
    });

    test("the open-session count is one indexed read of the cursor table, with the future-time guard", () => {
      const { sql, params } = _internal.buildOpenSessionsCountQuery({ curStart: "2026-10-28", endExclusive: "2026-10-29" });
      const flat = sql.replace(/\s+/g, " ");
      expect(flat).toContain("FROM intent_actor_cursors");
      expect(flat).toContain("session_id <> ''");
      expect(flat).toContain("last_event_at >= ?");
      expect(flat).toContain("UTC_TIMESTAMP() + INTERVAL 14 HOUR");
      expect(flat).not.toContain("behavioral_events");
      expect(params).toEqual(["2026-10-28", "2026-10-28", "2026-10-29"]);
    });

    test("end to end: the distribution plus bots plus the waiting backlog equals Total Sessions (gap 0)", async () => {
      // finished rows 104 (100 in the levels + 4 bots), 20 open of which 2 are live
      const cursors = [
        { actor_id: "a", session_start: new Date("2026-10-12T10:00:00Z"), last_event_at: new Date("2026-10-12T10:00:02Z"), events_seq: { 1: { event_name: "page_viewed" } } },
        { actor_id: "b", session_start: new Date("2026-10-12T10:00:00Z"), last_event_at: new Date("2026-10-12T10:00:01Z"), events_seq: { 1: { event_name: "page_viewed" } } },
      ];
      const conn = makeConn({ totals: () => [{ ...DEFAULT_TOTALS, cur_visitors_sessions: 104 }], live: () => cursors, closedBest: () => [] });
      const out = await newService().getIntentFunnel({ ...SPEC, conn });
      const card = out.sessionsStarted;
      expect(card.value).toBe(124);
      expect(out.behavior.distribution.totalSessions).toBe(102);                  // 100 finished + 2 live
      expect(card.distributionGap).toBe(0);
      expect(card.bots + card.waiting + out.behavior.distribution.totalSessions).toBe(card.value);
    });

    test("click-only and scroll-only sessions are sessions: they are rows of intent_sessions, whatever events they hold", () => {
      // The canonical total counts rows, so a session whose events are all clicks (no page view in the events
      // table, which is why the old events-based count missed it) is in the closed count like any other.
      const card = _internal.buildSessionsStarted(null, { cur_visitors_sessions: 3 }, 0, [{ open_sessions: "0" }], 0);
      expect(card.value).toBe(3);
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
