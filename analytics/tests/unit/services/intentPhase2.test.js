/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { buildIntentFunnelService, createQueryCache, _internal } = require("../../../services/intentFunnelService");

const { buildPathsQuery, buildPathsTotalQuery, buildOverlapBase, sourceNormalizeSql, SOURCE_NORMALIZE_SQL } = _internal;

const SPEC = { brandKey: "BBB", start: "2026-10-10", end: "2026-10-12", intent: "all", basis: "behavior", pathStart: "page_viewed", steps: 5 };
const newService = () => buildIntentFunnelService({ cache: createQueryCache() });
const unknownColumn = () => Object.assign(new Error("Unknown column"), { code: "ER_BAD_FIELD_ERROR", errno: 1054 });

afterEach(() => {
  delete process.env.INTENT_PATH_FIRST_EVENT;
  delete process.env.INTENT_OVERLAP_SESSION_UTM;
  delete process.env.INTENT_OVERLAP_SINGLE_QUERY;
});

describe("paths by first_event", () => {
  test("the indexed filter also matches older rows that have no first_event yet, by their sequence text", () => {
    const q = buildPathsQuery({ start: "2026-10-10", end: "2026-10-12", pathStart: "click", useFirstEvent: true });
    expect(q.sql).toContain("first_event = ? OR (first_event IS NULL AND SUBSTRING_INDEX(sequence, '>', 1) = ?)");
    expect(q.params).toEqual(["2026-10-10", "2026-10-12", "click", "click"]);
    expect(q.sql.match(/\?/g)).toHaveLength(q.params.length);

    const total = buildPathsTotalQuery({ start: "2026-10-10", end: "2026-10-12", pathStart: "click", useFirstEvent: true });
    expect(total.params).toEqual(["2026-10-10", "2026-10-12", "click", "click"]);
  });

  test("without the option the original text-only query is unchanged", () => {
    const q = buildPathsQuery({ start: "a", end: "b", pathStart: "click" });
    expect(q.sql).toContain("AND SUBSTRING_INDEX(sequence, '>', 1) = ?");
    expect(q.sql).not.toContain("first_event");
    expect(q.params).toEqual(["a", "b", "click"]);
  });

  function pathConn({ failNew = null } = {}) {
    const query = jest.fn(async (sql) => {
      if (!sql.includes("FROM behavioral_path_daily")) return [];
      if (sql.includes("first_event") && failNew) throw failNew;
      return sql.includes("GROUP BY sequence_hash")
        ? [{ sequence: "page_viewed>click", sessions: "10", users: "9" }]
        : [{ sessions: "10" }];
    });
    return { query };
  }

  test("getPaths asks the indexed column first and returns the same paths", async () => {
    const conn = pathConn();
    const out = await newService().getPaths({ ...SPEC, conn });
    expect(conn.query.mock.calls.every(([sql]) => sql.includes("first_event"))).toBe(true);
    expect(out.paths.nodes.length).toBeGreaterThan(0);
    expect(out.paths.coverage).toMatchObject({ sessions: 10, totalSessions: 10 });
  });

  test("a brand database without the column falls back to the text filter, once, and is not asked again soon", async () => {
    const conn = pathConn({ failNew: unknownColumn() });
    const service = newService();
    const first = await service.getPaths({ ...SPEC, conn });

    expect(first.meta.available).toBe(true);
    expect(first.paths.nodes.length).toBeGreaterThan(0);
    const textQueries = conn.query.mock.calls.filter(([sql]) => !sql.includes("first_event")).length;
    expect(textQueries).toBe(2);

    conn.query.mockClear();
    await service.getPaths({ ...SPEC, end: "2026-10-13", conn });
    expect(conn.query.mock.calls.every(([sql]) => !sql.includes("first_event"))).toBe(true);
  });

  test("another brand is still asked for the column", async () => {
    const service = newService();
    await service.getPaths({ ...SPEC, conn: pathConn({ failNew: unknownColumn() }) });
    const other = pathConn();
    await service.getPaths({ ...SPEC, brandKey: "OTHER", conn: other });
    expect(other.query.mock.calls.some(([sql]) => sql.includes("first_event"))).toBe(true);
  });

  test("INTENT_PATH_FIRST_EVENT=off keeps the text filter", async () => {
    process.env.INTENT_PATH_FIRST_EVENT = "off";
    const conn = pathConn();
    await newService().getPaths({ ...SPEC, conn });
    expect(conn.query.mock.calls.every(([sql]) => !sql.includes("first_event"))).toBe(true);
  });

  test("a timeout is still an error section, not a fallback to the slower query", async () => {
    const timeout = Object.assign(new Error("t"), { code: "ER_QUERY_TIMEOUT", errno: 3024 });
    const conn = pathConn({ failNew: timeout });
    const out = await newService().getPaths({ ...SPEC, conn });
    expect(out.meta.available).toBe(false);
    expect(conn.query.mock.calls.every(([sql]) => sql.includes("first_event"))).toBe(true);
  });
});

describe("overlap from the session's first utm source", () => {
  const args = { basis: "behavior", intent: "all", curStart: "2026-10-10", endExclusive: "2026-10-13" };

  test("the session base reads intent_sessions only, with the normalizer on first_utm_source", () => {
    const base = buildOverlapBase({ ...args, sessionUtm: true });
    expect(base.sql).not.toContain("behavioral_events");
    expect(base.sql).toContain("LOWER(TRIM(first_utm_source))");
    expect(base.params).toEqual(["2026-10-10", "2026-10-13"]);
    expect(base.sql.match(/\?/g)).toHaveLength(base.params.length);
  });

  test("the intent level is still only a bound parameter", () => {
    const base = buildOverlapBase({ ...args, intent: "high", sessionUtm: true });
    expect(base.params).toEqual(["2026-10-10", "2026-10-13", "high"]);
    expect(base.sql).not.toMatch(/=\s*'high'/);
  });

  test("both bases group the same aliases", () => {
    expect(sourceNormalizeSql("x")).toBe(SOURCE_NORMALIZE_SQL.replace(/utm_source/g, "x"));
  });

  const rows = [
    { g1: 1, g2: 0, g3: 0, users: "4", sessions: "6", checkout_sessions: "1", c1: "6", c2: "0", c3: "0" },
    { g1: 1, g2: 1, g3: 0, users: "2", sessions: "5", checkout_sessions: "2", c1: "3", c2: "2", c3: "0" },
  ];
  function overlapConn({ failSession = null } = {}) {
    const query = jest.fn(async (sql) => {
      if (sql.includes("first_utm_source") && failSession) throw failSession;
      return rows;
    });
    return { query };
  }

  test("it is off by default: the events join is used", async () => {
    const conn = overlapConn();
    await newService().getSourceOverlap({ ...SPEC, conn });
    expect(conn.query.mock.calls[0][0]).toContain("FROM behavioral_events");
  });

  test("switched on, the session column answers with the same shape", async () => {
    process.env.INTENT_OVERLAP_SESSION_UTM = "on";
    const conn = overlapConn();
    const out = await newService().getSourceOverlap({ ...SPEC, conn });
    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(conn.query.mock.calls[0][0]).toContain("first_utm_source");
    expect(conn.query.mock.calls[0][0]).not.toContain("behavioral_events");
    expect(out.sources.map((s) => s.key)).toEqual(["google", "meta", "others"]);
  });

  test("switched on but the column is missing: falls back to the events join and still answers", async () => {
    process.env.INTENT_OVERLAP_SESSION_UTM = "on";
    const conn = overlapConn({ failSession: unknownColumn() });
    const service = newService();
    const out = await service.getSourceOverlap({ ...SPEC, conn });

    expect(out.meta.available).toBe(true);
    expect(conn.query.mock.calls.map(([sql]) => sql.includes("behavioral_events"))).toEqual([false, true]);

    conn.query.mockClear();
    await service.getSourceOverlap({ ...SPEC, end: "2026-10-14", conn });
    expect(conn.query).toHaveBeenCalledTimes(1); // not asked for the column again
    expect(conn.query.mock.calls[0][0]).toContain("behavioral_events");
  });

  test("a missing intent table still answers available:false", async () => {
    process.env.INTENT_OVERLAP_SESSION_UTM = "on";
    const err = Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
    const conn = { query: jest.fn(async () => { throw err; }) };
    const out = await newService().getSourceOverlap({ ...SPEC, conn });
    expect(out.meta).toMatchObject({ available: false, reason: "intent_tables_missing" });
  });

  test("the join path still answers available:false when the events column is missing", async () => {
    const conn = { query: jest.fn(async () => { throw unknownColumn(); }) };
    const out = await newService().getSourceOverlap({ ...SPEC, conn });
    expect(out.meta).toMatchObject({ available: false, reason: "schema_unsupported" });
  });
});
