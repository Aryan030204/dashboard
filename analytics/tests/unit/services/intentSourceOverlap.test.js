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
  intents: [],
  basis: "behavior",
};

const TOP = [
  { src: "google", sessions: "100", users: "60" },
  { src: "meta", sessions: "70", users: "45" },
  { src: "direct", sessions: "30", users: "25" },
];

// Rows are one per visitor group: which of the three sources they were seen in, then their totals.
const REGION_ROWS = [
  { g1: 1, g2: 0, g3: 0, users: "40", sessions: "60", checkout_sessions: "5" },
  { g1: 0, g2: 1, g3: 0, users: "30", sessions: "40", checkout_sessions: "4" },
  { g1: 1, g2: 1, g3: 0, users: "10", sessions: "35", checkout_sessions: "3" },
  { g1: 1, g2: 1, g3: 1, users: "4", sessions: "20", checkout_sessions: "7" },
];

function makeConn(overrides = {}) {
  const handlers = {
    top: () => TOP,
    total: () => [{ sessions: "230" }],
    regions: () => REGION_ROWS,
    ...overrides,
  };
  const query = jest.fn(async (sql, options) => {
    if (sql.includes("GROUP BY g1, g2, g3")) return handlers.regions(sql, options);
    if (sql.includes("GROUP BY src")) return handlers.top(sql, options);
    if (sql.includes("COUNT(*) AS sessions")) return handlers.total(sql, options);
    throw new Error(`unexpected sql: ${sql}`);
  });
  return { query };
}

function newService() {
  return buildIntentFunnelService({ cache: createQueryCache() });
}

describe("intentFunnelService.getSourceOverlap", () => {
  test("returns the top sources and every Venn region, stable even when a region is empty", async () => {
    const out = await newService().getSourceOverlap({ ...SPEC, conn: makeConn() });

    expect(out.meta.available).toBe(true);
    expect(out.sources.map((s) => s.key)).toEqual(["google", "meta", "direct"]);
    expect(out.sources[0]).toMatchObject({ label: "Google", sessions: 100, users: 60 });
    expect(out.sources[1].label).toBe("Meta");
    expect(out.sources[2].label).toBe("Direct");

    expect(out.regions).toHaveLength(7);
    const byId = Object.fromEntries(out.regions.map((r) => [r.id, r]));
    expect(byId.google).toMatchObject({ kind: "only", users: 40, sessions: 60, value: 60 });
    expect(byId.meta).toMatchObject({ kind: "only", sessions: 40 });
    expect(byId["google+meta"]).toMatchObject({ kind: "overlap", sessions: 35, value: 35 });
    // nobody was seen in only direct, or in these combinations: zeros, not missing
    expect(byId.direct).toMatchObject({ users: 0, sessions: 0, value: 0 });
    expect(byId["google+direct"].value).toBe(0);
    expect(byId["meta+direct"].value).toBe(0);
  });

  test("the all-three region counts checked-out sessions only", async () => {
    const out = await newService().getSourceOverlap({ ...SPEC, conn: makeConn() });
    const all = out.regions.find((r) => r.kind === "all");
    expect(all.id).toBe("google+meta+direct");
    expect(all).toMatchObject({ sessions: 20, checkoutSessions: 7, value: 7 });
  });

  test("sessions from sources outside the top three are reported, not drawn", async () => {
    const out = await newService().getSourceOverlap({ ...SPEC, conn: makeConn() });
    // 230 sessions in range, 200 belong to the three drawn sources
    expect(out.otherSessions).toBe(30);
  });

  test("with fewer than three sources only two circles and three regions are returned", async () => {
    const conn = makeConn({
      top: () => TOP.slice(0, 2),
      regions: () => [{ g1: 1, g2: 1, g3: 0, users: "3", sessions: "9", checkout_sessions: "1" }],
    });
    const out = await newService().getSourceOverlap({ ...SPEC, conn });
    expect(out.regions.map((r) => r.id)).toEqual(["google", "meta", "google+meta"]);
    // a two-source overlap is a normal overlap, not the checkout-only centre
    expect(out.regions[2]).toMatchObject({ kind: "overlap", value: 9 });
    // the unused third slot is padded with '' so the SQL shape never changes
    const regionsCall = conn.query.mock.calls.find(([sql]) => sql.includes("GROUP BY g1, g2, g3"));
    expect(regionsCall[1].replacements.slice(0, 3)).toEqual(["google", "meta", ""]);
  });

  test("no sessions in range returns an empty but available payload", async () => {
    const conn = makeConn({ top: () => [] });
    const out = await newService().getSourceOverlap({ ...SPEC, conn });
    expect(out).toMatchObject({ meta: { available: true }, sources: [], regions: [], otherSessions: 0 });
    // the per-visitor query is skipped when there is nothing to group
    expect(conn.query.mock.calls.some(([sql]) => sql.includes("GROUP BY g1, g2, g3"))).toBe(false);
  });

  describe("intent levels and basis", () => {
    test("defaults to all three levels on the behaviour basis, levels only as bound parameters", async () => {
      const conn = makeConn();
      const out = await newService().getSourceOverlap({ ...SPEC, conn });
      expect(out.filters).toMatchObject({ intent: ["high", "medium", "low"], basis: "behavior" });
      const topCall = conn.query.mock.calls.find(([sql]) => sql.includes("GROUP BY src"));
      expect(topCall[0]).toContain("session_time_spent_ms IS NOT NULL");
      expect(topCall[0]).toContain("click_count");
      expect(topCall[0]).not.toContain("'high' IN");
      expect(topCall[1].replacements).toEqual(["2026-10-10", "2026-10-13", "high", "medium", "low"]);
    });

    test("the score basis filters on the percentile bucket of scored sessions", async () => {
      const conn = makeConn();
      const out = await newService().getSourceOverlap({
        ...SPEC,
        basis: "score",
        intents: ["high", "low"],
        conn,
      });
      expect(out.filters).toMatchObject({ intent: ["high", "low"], basis: "score" });
      const topCall = conn.query.mock.calls.find(([sql]) => sql.includes("GROUP BY src"));
      expect(topCall[0]).toContain("intent_status = 'scored'");
      expect(topCall[0]).toContain("intent_bucket IN (?, ?)");
      expect(topCall[1].replacements).toEqual(["2026-10-10", "2026-10-13", "high", "low"]);
    });

    test("unknown basis and unknown levels fall back to safe defaults", async () => {
      const conn = makeConn();
      const out = await newService().getSourceOverlap({
        ...SPEC,
        basis: "x; DROP TABLE intent_sessions",
        intents: ["urgent"],
        conn,
      });
      expect(out.filters).toMatchObject({ basis: "behavior", intent: ["high", "medium", "low"] });
      conn.query.mock.calls.forEach(([sql]) => expect(sql).not.toContain("DROP"));
    });
  });

  describe("source normalisation", () => {
    test("maps the Meta and Google aliases in SQL and defaults empty sources to direct", () => {
      const sql = _internal.SOURCE_NORMALIZE_SQL;
      ["facebook", "fb", "instagram", "ig", "meta", "an", "messenger"].forEach((alias) =>
        expect(sql).toContain(`'${alias}'`),
      );
      ["google", "youtube", "gdn", "adwords"].forEach((alias) => expect(sql).toContain(`'${alias}'`));
      expect(sql).toContain("'direct'");
      expect(sql).toContain("TRIM(utm_source)");
    });
  });

  describe("query safety", () => {
    test("no request value or brand reaches the SQL text; sources are bound parameters", async () => {
      const conn = makeConn();
      await newService().getSourceOverlap({ ...SPEC, conn });
      expect(conn.query).toHaveBeenCalledTimes(3);
      conn.query.mock.calls.forEach(([sql, options]) => {
        expect(sql).not.toMatch(/select\s+\*/i);
        expect(sql).not.toContain("BBB");
        expect(sql).not.toContain("2026-10");
        expect(Array.isArray(options.replacements)).toBe(true);
      });
      const regionsCall = conn.query.mock.calls.find(([sql]) => sql.includes("GROUP BY g1, g2, g3"));
      // three flag slots + two IN lists, each with the three sources, then the base parameters
      expect(regionsCall[1].replacements.slice(0, 9)).toEqual([
        "google", "meta", "direct", "google", "meta", "direct", "google", "meta", "direct",
      ]);
    });

    test("results are cached per brand and never cross tenants", async () => {
      const service = newService();
      const connA = makeConn();
      const connB = makeConn({ top: () => [{ src: "meta", sessions: "5", users: "3" }], regions: () => [] });
      const a = await service.getSourceOverlap({ ...SPEC, brandKey: "BBB", conn: connA });
      const b = await service.getSourceOverlap({ ...SPEC, brandKey: "PTS", conn: connB });
      expect(a.sources).toHaveLength(3);
      expect(b.sources.map((s) => s.key)).toEqual(["meta"]);
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
  const sources = [{ key: "google" }, { key: "meta" }, { key: "direct" }];

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
