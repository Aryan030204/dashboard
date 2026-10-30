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

const SPEC = {
  brandKey: "BBB",
  start: "2026-10-10",
  end: "2026-10-12",
  intent: "all",
  basis: "behavior",
};

// Only Google and Meta have sessions here, so "others" must come back as a zero, not go missing.
const TOP = [
  { src: "google", sessions: "100", users: "60" },
  { src: "meta", sessions: "70", users: "45" },
];

// Rows are one per visitor group: which of the three source groups they were seen in, then their totals.
const REGION_ROWS = [
  { g1: 1, g2: 0, g3: 0, users: "40", sessions: "60", checkout_sessions: "5" },
  { g1: 0, g2: 1, g3: 0, users: "30", sessions: "40", checkout_sessions: "4" },
  { g1: 1, g2: 1, g3: 0, users: "10", sessions: "35", checkout_sessions: "3" },
  { g1: 1, g2: 1, g3: 1, users: "4", sessions: "20", checkout_sessions: "7" },
];

function makeConn(overrides = {}) {
  const handlers = {
    top: () => TOP,
    regions: () => REGION_ROWS,
    ...overrides,
  };
  const query = jest.fn(async (sql, options) => {
    if (sql.includes("GROUP BY g1, g2, g3")) return handlers.regions(sql, options);
    if (sql.includes("GROUP BY src")) return handlers.top(sql, options);
    throw new Error(`unexpected sql: ${sql}`);
  });
  return { query };
}

function newService() {
  return buildIntentFunnelService({ cache: createQueryCache() });
}

describe("intentFunnelService.getSourceOverlap", () => {
  test("always returns the three fixed circles and every Venn region, with empty ones as zeros", async () => {
    const out = await newService().getSourceOverlap({ ...SPEC, conn: makeConn() });

    expect(out.meta.available).toBe(true);
    expect(out.sources.map((s) => [s.key, s.label])).toEqual([
      ["google", "Google"],
      ["meta", "Meta"],
      ["others", "Others"],
    ]);
    expect(out.sources[0]).toMatchObject({ sessions: 100, users: 60 });
    // no session came from "others": a zero, not a missing circle
    expect(out.sources[2]).toMatchObject({ sessions: 0, users: 0 });

    expect(out.regions.map((r) => r.id)).toEqual([
      "google",
      "meta",
      "google+meta",
      "others",
      "google+others",
      "meta+others",
      "google+meta+others",
    ]);
    const byId = Object.fromEntries(out.regions.map((r) => [r.id, r]));
    expect(byId.google).toMatchObject({ kind: "only", users: 40, sessions: 60, value: 60 });
    expect(byId["google+meta"]).toMatchObject({ kind: "overlap", sessions: 35, value: 35 });
    expect(byId.others).toMatchObject({ users: 0, sessions: 0, value: 0 });
    expect(out).not.toHaveProperty("otherSessions");
  });

  test("the all-three region counts checked-out sessions only", async () => {
    const out = await newService().getSourceOverlap({ ...SPEC, conn: makeConn() });
    const all = out.regions.find((r) => r.kind === "all");
    expect(all.id).toBe("google+meta+others");
    expect(all).toMatchObject({ sessions: 20, checkoutSessions: 7, value: 7 });
  });

  test("no sessions in range returns an empty but available payload and skips the per-visitor query", async () => {
    const conn = makeConn({ top: () => [] });
    const out = await newService().getSourceOverlap({ ...SPEC, conn });
    expect(out).toMatchObject({ meta: { available: true }, sources: [], regions: [] });
    expect(conn.query.mock.calls.some(([sql]) => sql.includes("GROUP BY g1, g2, g3"))).toBe(false);
  });

  describe("intent and basis", () => {
    test("'all intents' applies no level filter, like the KPI cards", async () => {
      const conn = makeConn();
      const out = await newService().getSourceOverlap({ ...SPEC, conn });
      expect(out.filters).toEqual({ start: "2026-10-10", end: "2026-10-12", intent: "all", basis: "behavior" });
      const topCall = conn.query.mock.calls.find(([sql]) => sql.includes("GROUP BY src"));
      expect(topCall[0]).not.toContain("session_time_spent_ms");
      expect(topCall[0]).not.toContain("intent_status");
      expect(topCall[1].replacements).toEqual(["2026-10-10", "2026-10-14", "2026-10-10", "2026-10-13"]);
    });

    test("one level on the behaviour basis uses the behaviour rules, the level bound as a parameter", async () => {
      const conn = makeConn();
      await newService().getSourceOverlap({ ...SPEC, intent: "high", conn });
      const topCall = conn.query.mock.calls.find(([sql]) => sql.includes("GROUP BY src"));
      expect(topCall[0]).toContain("session_time_spent_ms IS NOT NULL");
      expect(topCall[0]).toContain("click_count");
      expect(topCall[1].replacements).toEqual(["2026-10-10", "2026-10-14", "2026-10-10", "2026-10-13", "high"]);
    });

    test("one level on the score basis filters on the percentile bucket of scored sessions", async () => {
      const conn = makeConn();
      const out = await newService().getSourceOverlap({ ...SPEC, intent: "low", basis: "score", conn });
      expect(out.filters).toMatchObject({ intent: "low", basis: "score" });
      const topCall = conn.query.mock.calls.find(([sql]) => sql.includes("GROUP BY src"));
      expect(topCall[0]).toContain("intent_status = 'scored'");
      expect(topCall[0]).toContain("intent_bucket = ?");
      expect(topCall[1].replacements).toEqual(["2026-10-10", "2026-10-14", "2026-10-10", "2026-10-13", "low"]);
    });

    test("unknown intent and unknown basis fall back to safe defaults", async () => {
      const conn = makeConn();
      const out = await newService().getSourceOverlap({
        ...SPEC,
        intent: "high' OR '1'='1",
        basis: "x; DROP TABLE intent_sessions",
        conn,
      });
      expect(out.filters).toMatchObject({ basis: "behavior", intent: "all" });
      conn.query.mock.calls.forEach(([sql]) => expect(sql).not.toContain("DROP"));
    });
  });

  describe("source grouping", () => {
    test("Meta and Google aliases are matched in SQL; everything else, including no UTM, is others", () => {
      const sql = _internal.SOURCE_NORMALIZE_SQL;
      ["facebook", "fb", "instagram", "ig", "meta", "an", "messenger"].forEach((alias) =>
        expect(sql).toContain(`'${alias}'`),
      );
      ["google", "youtube", "gdn", "adwords"].forEach((alias) => expect(sql).toContain(`'${alias}'`));
      expect(sql).toContain("ELSE 'others'");
      expect(sql).not.toContain("direct");
      expect(sql).toContain("TRIM(utm_source)");
    });
  });

  describe("where the source comes from", () => {
    // intent_sessions has no utm_source column; it lives on behavioral_events (migration 003).
    test("the UTM source is joined from behavioral_events by session_id, not read from intent_sessions", async () => {
      const conn = makeConn();
      await newService().getSourceOverlap({ ...SPEC, conn });
      const [sql] = conn.query.mock.calls[0];

      expect(sql).toContain("FROM behavioral_events");
      expect(sql).toContain("first_touch.utm_session_id = intent_sessions.session_id");
      expect(sql).toContain("utm_source IS NOT NULL AND utm_source <> ''");
      expect(sql).toContain("ORDER BY occurred_at");
      // sessions without any UTM keep their row (LEFT JOIN) and fall into 'others'
      expect(sql).toContain("LEFT JOIN");
    });

    test("events are read for the range plus one day, then the sessions of the range, in placeholder order", async () => {
      const conn = makeConn();
      await newService().getSourceOverlap({ ...SPEC, intent: "high", conn });
      const [sql, options] = conn.query.mock.calls[0];

      // 2026-10-10 .. 2026-10-12 inclusive -> sessions < 10-13; events < 10-14
      expect(options.replacements).toEqual(["2026-10-10", "2026-10-14", "2026-10-10", "2026-10-13", "high"]);
      expect(sql.indexOf("FROM behavioral_events")).toBeLessThan(sql.indexOf("session_start >= ?"));
    });

    test("a database whose behavioral_events has no utm_source answers available:false instead of failing", async () => {
      const err = Object.assign(new Error("Unknown column 'utm_source'"), { code: "ER_BAD_FIELD_ERROR", errno: 1054 });
      const conn = { query: jest.fn(async () => { throw err; }) };
      const out = await newService().getSourceOverlap({ ...SPEC, conn });

      expect(out.meta).toMatchObject({ available: false, reason: "schema_unsupported" });
    });
  });

  describe("query safety", () => {
    test("no request value or brand reaches the SQL text; the source groups are bound parameters", async () => {
      const conn = makeConn();
      await newService().getSourceOverlap({ ...SPEC, intent: "medium", conn });
      expect(conn.query).toHaveBeenCalledTimes(2);
      conn.query.mock.calls.forEach(([sql, options]) => {
        expect(sql).not.toMatch(/select\s+\*/i);
        expect(sql).not.toContain("BBB");
        expect(sql).not.toContain("2026-10");
        // the chosen level is only ever bound as `= ?`, never written into the SQL as a literal
        expect(sql).not.toMatch(/=\s*'medium'/);
        expect(Array.isArray(options.replacements)).toBe(true);
      });
      const regionsCall = conn.query.mock.calls.find(([sql]) => sql.includes("GROUP BY g1, g2, g3"));
      // three flag slots + two IN lists, each with the three groups, then the base parameters
      expect(regionsCall[1].replacements).toEqual([
        "google", "meta", "others", "google", "meta", "others", "google", "meta", "others",
        "2026-10-10", "2026-10-14", "2026-10-10", "2026-10-13", "medium",
      ]);
    });

    test("results are cached per brand and never cross tenants", async () => {
      const service = newService();
      const connB = makeConn({ top: () => [{ src: "meta", sessions: "5", users: "3" }], regions: () => [] });
      const a = await service.getSourceOverlap({ ...SPEC, brandKey: "BBB", conn: makeConn() });
      const b = await service.getSourceOverlap({ ...SPEC, brandKey: "PTS", conn: connB });
      expect(a.sources[0].sessions).toBe(100);
      expect(b.sources[0].sessions).toBe(0);
      expect(b.sources[1].sessions).toBe(5);
      expect(connB.query).toHaveBeenCalled();
    });
  });

  describe("brand databases without usable data", () => {
    test("a missing intent table is reported as unavailable, not an error", async () => {
      const missing = Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
      const conn = makeConn({ top: () => { throw missing; } });
      const out = await newService().getSourceOverlap({ ...SPEC, conn });
      expect(out.meta).toEqual({ available: false, reason: "intent_tables_missing" });
      expect(out.sources).toEqual([]);
      expect(out.regions).toEqual([]);
    });

    test("a brand database without the utm_source column is reported as unsupported", async () => {
      const bad = Object.assign(new Error("Unknown column 'utm_source'"), {
        code: "ER_BAD_FIELD_ERROR",
        errno: 1054,
      });
      const conn = makeConn({ top: () => { throw bad; } });
      const out = await newService().getSourceOverlap({ ...SPEC, conn });
      expect(out.meta).toEqual({ available: false, reason: "schema_unsupported" });
    });

    test("timeouts and unexpected failures propagate so the controller can answer 504 / 500", async () => {
      const timeout = Object.assign(new Error("timeout"), { code: "ER_QUERY_TIMEOUT", errno: 3024 });
      await expect(
        newService().getSourceOverlap({ ...SPEC, conn: makeConn({ top: () => { throw timeout; } }) }),
      ).rejects.toThrow("timeout");
      const boom = Object.assign(new Error("connection lost"), { code: "PROTOCOL_CONNECTION_LOST" });
      await expect(
        newService().getSourceOverlap({ ...SPEC, conn: makeConn({ regions: () => { throw boom; } }) }),
      ).rejects.toThrow("connection lost");
    });
  });
});

describe("buildOverlapRegions", () => {
  const sources = [{ key: "google" }, { key: "meta" }, { key: "others" }];

  test("merges rows that map to the same combination and ignores empty flag rows", () => {
    const regions = _internal.buildOverlapRegions(sources, [
      { g1: 1, g2: 0, g3: 0, users: "1", sessions: "2", checkout_sessions: "0" },
      { g1: "1", g2: "0", g3: "0", users: "2", sessions: "3", checkout_sessions: "1" },
      { g1: 0, g2: 0, g3: 0, users: "9", sessions: "9", checkout_sessions: "9" },
    ]);
    const google = regions.find((r) => r.id === "google");
    expect(google).toMatchObject({ users: 3, sessions: 5, checkoutSessions: 1 });
    expect(regions.reduce((sum, r) => sum + r.sessions, 0)).toBe(5);
  });
});
