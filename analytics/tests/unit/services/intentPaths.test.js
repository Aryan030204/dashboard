/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { buildIntentFunnelService, createQueryCache, _internal } = require("../../../services/intentFunnelService");

const { buildPaths, pathFromSequence, parseTopProductsCache, clampPathSteps } = _internal;

const SPEC = {
  brandKey: "BBB",
  start: "2026-10-10",
  end: "2026-10-12",
  intent: "all",
  basis: "behavior",
  pathStart: "page_viewed",
  steps: 5,
};

const newService = () => buildIntentFunnelService({ cache: createQueryCache() });

// intent_sessions.event_sequence: { "<step>": { "<event_name>": "<event_id>" } }
const seq = (...events) =>
  JSON.stringify(Object.fromEntries(events.map(([name, id], i) => [String(i + 1), { [name]: id }])));

const stepNodes = (paths, step) => paths.nodes.filter((node) => node.step === step);

describe("path length", () => {
  const rows = [
    { sequence: "page_viewed>product_viewed>click>product_added_to_cart>checkout_started>click>page_viewed", sessions: 10 },
    { sequence: "page_viewed>product_viewed", sessions: 6 },
  ];

  test.each([3, 5, 8])("%i steps draw exactly that many columns, padded with Exit", (steps) => {
    const paths = buildPaths(rows, { steps });
    expect(paths.steps).toHaveLength(steps);
    expect(Math.max(...paths.nodes.map((n) => n.step))).toBe(steps - 1);
    // the 2-event path ends in Exit at step 2 and stays there to the last step
    expect(stepNodes(paths, steps - 1).some((n) => n.state === "exit")).toBe(true);
  });

  test("the default is 5 steps and 5 branches per step, as before", () => {
    const paths = buildPaths(rows, {});
    expect(paths.steps).toHaveLength(5);
  });

  test("steps are clamped to 3..8 and non-numbers fall back to 5", () => {
    expect(clampPathSteps(1)).toBe(3);
    expect(clampPathSteps(50)).toBe(8);
    expect(clampPathSteps("x")).toBe(5);
    expect(clampPathSteps("6")).toBe(6);
  });
});

describe("journey from an event sequence", () => {
  test("collapses consecutive duplicates like the rollup", () => {
    const raw = seq(["page_viewed", "e1"], ["page_viewed", "e2"], ["click", "e3"], ["click", "e4"], ["page_viewed", "e5"]);
    expect(pathFromSequence(raw)).toEqual(["page_viewed", "click", "page_viewed"]);
  });

  test("starts at the given event and ignores what happened before it", () => {
    const raw = seq(["page_viewed", "e1"], ["click", "e2"], ["product_viewed", "pdp"], ["product_added_to_cart", "e4"]);
    expect(pathFromSequence(raw, { fromEventId: "pdp" })).toEqual(["product_viewed", "product_added_to_cart"]);
  });

  test("a session that does not contain the event has no journey", () => {
    expect(pathFromSequence(seq(["page_viewed", "e1"]), { fromEventId: "missing" })).toBeNull();
  });

  test("steps are ordered numerically (10 after 9) and bad JSON gives an empty journey", () => {
    const raw = JSON.stringify({ 10: { click: "c" }, 2: { product_viewed: "p" }, 1: { page_viewed: "a" } });
    expect(pathFromSequence(raw)).toEqual(["page_viewed", "product_viewed", "click"]);
    expect(pathFromSequence("{not json")).toEqual([]);
    expect(pathFromSequence(null)).toEqual([]);
  });

  test("is capped at the rollup's 15 steps", () => {
    const names = Array.from({ length: 30 }, (_, i) => [i % 2 ? "click" : "page_viewed", `e${i}`]);
    expect(pathFromSequence(seq(...names))).toHaveLength(15);
  });
});

describe("getPaths with a product", () => {
  function makeConn({ events, sessions }) {
    const query = jest.fn(async (sql) => {
      if (sql.includes("FROM behavioral_events")) return events;
      if (sql.includes("FROM intent_sessions")) return sessions;
      throw new Error(`unexpected sql: ${sql}`);
    });
    return { query };
  }

  const events = [
    { event_id: "pdp1", session_id: "s1" },
    { event_id: "pdp1b", session_id: "s1" }, // a second view in the same session is ignored
    { event_id: "pdp2", session_id: "s2" },
    { event_id: "pdp3", session_id: "s3" },
  ];
  const sessions = [
    { session_id: "s1", event_sequence: seq(["page_viewed", "a"], ["product_viewed", "pdp1"], ["product_added_to_cart", "x"], ["checkout_started", "y"]) },
    { session_id: "s2", event_sequence: seq(["product_viewed", "pdp2"], ["click", "z"]) },
    { session_id: "s3", event_sequence: seq(["product_viewed", "pdp3"]) },
  ];

  test("every journey starts at the PDP view and the first step counts the sessions that viewed it", async () => {
    const conn = makeConn({ events, sessions });
    const out = await newService().getPaths({ ...SPEC, productId: "10261835809063", conn });

    expect(out.meta).toMatchObject({ available: true, live: true, capped: false });
    expect(out.filters).toMatchObject({ productId: "10261835809063", pathStart: "product_viewed" });
    const first = stepNodes(out.paths, 0);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ state: "product_viewed", value: 3 });
    // s1 went on to add to cart, s2 clicked, s3 left
    const second = stepNodes(out.paths, 1).map((n) => [n.state, n.value]).sort();
    expect(second).toEqual([["click", 1], ["exit", 1], ["product_added_to_cart", 1]]);
    expect(out.paths.coverage).toEqual({ sessions: 3, totalSessions: 3, pct: 100 });
  });

  test("the product id and dates are bound parameters, matching both id spellings", async () => {
    const conn = makeConn({ events, sessions });
    await newService().getPaths({ ...SPEC, productId: "10261835809063", conn });

    const [sql, options] = conn.query.mock.calls[0];
    expect(sql).not.toContain("10261835809063");
    expect(options.replacements).toEqual(["10261835809063", "10261835809063.0", "2026-10-10", "2026-10-13"]);
  });

  test("an intent level adds the level filter to the session query only, bound as a parameter", async () => {
    const conn = makeConn({ events, sessions });
    await newService().getPaths({ ...SPEC, intent: "high", productId: "5", conn });

    const [sessionSql, options] = conn.query.mock.calls[1];
    expect(sessionSql).toContain("WHERE session_id IN (?, ?, ?)");
    expect(sessionSql).toContain("session_time_spent_ms IS NOT NULL");
    expect(sessionSql).not.toMatch(/=\s*'high'/);
    expect(options.replacements).toEqual(["s1", "s2", "s3", "high"]);
  });

  test("the score basis filters on the percentile bucket of scored sessions", async () => {
    const conn = makeConn({ events, sessions });
    await newService().getPaths({ ...SPEC, intent: "medium", basis: "score", productId: "5", conn });

    const [sessionSql, options] = conn.query.mock.calls[1];
    expect(sessionSql).toContain("intent_status = 'scored' AND intent_bucket = ?");
    expect(options.replacements.slice(-1)).toEqual(["medium"]);
  });

  test("a product nobody viewed gives empty paths, not an error", async () => {
    const conn = makeConn({ events: [], sessions: [] });
    const out = await newService().getPaths({ ...SPEC, productId: "5", conn });

    expect(out.paths.nodes).toEqual([]);
    expect(conn.query).toHaveBeenCalledTimes(1);
  });

  test("an invalid product id is ignored instead of reaching the SQL", async () => {
    const conn = makeConn({ events, sessions });
    const out = await newService().getPaths({ ...SPEC, intent: "high", productId: "5; DROP TABLE x", conn });

    expect(out.filters.productId).toBeNull();
    conn.query.mock.calls.forEach(([sql]) => expect(sql).not.toContain("DROP"));
  });

  test("sessions are read in batches of 1000 ids", async () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({ event_id: `p${i}`, session_id: `s${i}` }));
    const conn = makeConn({ events: many, sessions: [] });
    await newService().getPaths({ ...SPEC, productId: "5", conn });

    const sessionCalls = conn.query.mock.calls.filter(([sql]) => sql.includes("FROM intent_sessions"));
    expect(sessionCalls.map(([, o]) => o.replacements.length)).toEqual([1000, 1000, 500]);
  });
});

describe("getPaths with no product and no intent level (the daily rollup)", () => {
  const rollupRows = [
    { sequence: "page_viewed>product_viewed>click", sessions: "60", users: "50" },
    { sequence: "page_viewed>click", sessions: "40", users: "35" },
  ];
  const makeRollupConn = () => ({
    query: jest.fn(async (sql) => {
      if (sql.includes("FROM behavioral_path_daily")) {
        return sql.includes("GROUP BY sequence_hash") ? rollupRows : [{ sessions: "100" }];
      }
      throw new Error(`unexpected sql: ${sql}`);
    }),
  });

  test("answers from behavioral_path_daily only, never from the session tables", async () => {
    const conn = makeRollupConn();
    const out = await newService().getPaths({ ...SPEC, steps: 4, conn });

    expect(out.meta).toMatchObject({ available: true, live: false });
    expect(conn.query).toHaveBeenCalledTimes(2);
    conn.query.mock.calls.forEach(([sql]) => expect(sql).toContain("behavioral_path_daily"));
    expect(out.paths.steps).toHaveLength(4);
    expect(stepNodes(out.paths, 0)).toEqual([expect.objectContaining({ state: "page_viewed", value: 100 })]);
    expect(out.paths.coverage).toMatchObject({ sessions: 100, totalSessions: 100 });
  });

  test("a brand without the rollup table answers available:false", async () => {
    const err = Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
    const conn = { query: jest.fn(async () => { throw err; }) };
    const out = await newService().getPaths({ ...SPEC, conn });
    expect(out.meta.available).toBe(false);
    expect(out.paths.nodes).toEqual([]);
  });
});

describe("getPaths with an intent level only", () => {
  const row = (id, ...events) => ({ id, session_start: `2026-10-10 10:00:${String(id % 60).padStart(2, "0")}`, event_sequence: seq(...events) });

  test("keeps the sessions whose journey starts with the chosen event", async () => {
    const rows = [
      row(1, ["page_viewed", "a"], ["product_viewed", "b"]),
      row(2, ["page_viewed", "c"], ["click", "d"]),
      row(3, ["click", "e"]), // starts elsewhere
    ];
    const conn = { query: jest.fn(async () => rows) };
    const out = await newService().getPaths({ ...SPEC, intent: "low", conn });

    expect(stepNodes(out.paths, 0)).toEqual([expect.objectContaining({ state: "page_viewed", value: 2 })]);
    expect(out.meta.capped).toBe(false);
    const [sql, options] = conn.query.mock.calls[0];
    expect(sql).toContain("ORDER BY session_start, id");
    expect(options.replacements).toEqual(["2026-10-10", "2026-10-13", "low"]);
  });

  test("reads further chunks with a keyset after the last row and stops at the cap", async () => {
    const chunk = (from) => Array.from({ length: 2000 }, (_, i) => row(from + i, ["page_viewed", `e${from + i}`]));
    let call = 0;
    const conn = { query: jest.fn(async () => chunk(call++ * 2000)) };
    const out = await newService().getPaths({ ...SPEC, intent: "high", conn });

    expect(out.meta.capped).toBe(true);
    expect(conn.query).toHaveBeenCalledTimes(20); // 40,000 sessions
    expect(out.paths.capped).toBe(true);
    expect(out.paths.coverage).toMatchObject({ sessions: 40000, totalSessions: null, pct: null });
    const second = conn.query.mock.calls[1];
    expect(second[0]).toContain("session_start > ? OR (session_start = ? AND id > ?)");
    expect(second[1].replacements.slice(-3)).toEqual([expect.anything(), expect.anything(), 1999]);
  });

  test("a result that fits in one chunk is not capped", async () => {
    const conn = { query: jest.fn(async () => [row(1, ["page_viewed", "a"])]) };
    const out = await newService().getPaths({ ...SPEC, intent: "high", conn });
    expect(out.meta.capped).toBe(false);
    expect(conn.query).toHaveBeenCalledTimes(1);
  });

  test("the same request is served from the cache, keyed per brand", async () => {
    const conn = { query: jest.fn(async () => [row(1, ["page_viewed", "a"])]) };
    const service = newService();
    await service.getPaths({ ...SPEC, intent: "high", conn });
    await service.getPaths({ ...SPEC, intent: "high", conn });
    expect(conn.query).toHaveBeenCalledTimes(1);
    await service.getPaths({ ...SPEC, brandKey: "OTHER", intent: "high", conn });
    expect(conn.query).toHaveBeenCalledTimes(2);
  });

  test("a brand database without the intent tables answers available:false", async () => {
    const err = Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
    const conn = { query: jest.fn(async () => { throw err; }) };
    const out = await newService().getPaths({ ...SPEC, intent: "high", conn });

    expect(out.meta).toMatchObject({ available: false, reason: "intent_tables_missing" });
    expect(out.paths.nodes).toEqual([]);
  });
});

describe("getPathProducts", () => {
  const cache = JSON.stringify({
    window_start_date: "2026-10-22",
    products: [
      { product_id: "gid://shopify/Product/222", product_title: "Second", rank: 2 },
      { product_id: "111", product_title: "Founder's Pick", rank: 1 },
      { product_id: "111", product_title: "Duplicate", rank: 9 },
      { product_id: "not-a-number", product_title: "Bad", rank: 3 },
    ],
  });

  test("lists the Redis top products by rank, with clean numeric ids", async () => {
    const out = await newService().getPathProducts(
      { ...SPEC, conn: { query: jest.fn() } },
      { readTopProductsCache: async () => cache },
    );

    expect(out.source).toBe("redis");
    expect(out.products).toEqual([
      { id: "111", name: "Founder's Pick" },
      { id: "222", name: "Second" },
    ]);
  });

  test("falls back to the rollup's most viewed products when Redis has nothing", async () => {
    const conn = {
      query: jest.fn(async () => [{ product_id: "333", title: "Rollup One", views: "50", add_to_cart: "5", checkouts: "1" }]),
    };
    const out = await newService().getPathProducts({ ...SPEC, conn }, { readTopProductsCache: async () => null });

    expect(out).toEqual({ source: "rollup", products: [{ id: "333", name: "Rollup One" }] });
  });

  test("a failing Redis read does not break the dropdown", async () => {
    const conn = { query: jest.fn(async () => []) };
    const out = await newService().getPathProducts(
      { ...SPEC, conn },
      { readTopProductsCache: async () => { throw new Error("redis down"); } },
    );
    expect(out.products).toEqual([]);
  });

  test("keeps at most 10 products and ignores malformed cache values", () => {
    const many = JSON.stringify({ products: Array.from({ length: 15 }, (_, i) => ({ product_id: String(100 + i), product_title: `P${i}`, rank: i + 1 })) });
    expect(parseTopProductsCache(many, 10)).toHaveLength(10);
    expect(parseTopProductsCache("{broken", 10)).toEqual([]);
    expect(parseTopProductsCache(null, 10)).toEqual([]);
  });
});
