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

const SPEC = { brandKey: "BBB", start: "2026-10-10", end: "2026-10-12", basis: "behavior" };

function kpiRow(overrides = {}) {
  const row = {};
  ["visitors", "high", "medium", "low"].forEach((id) => {
    row[`${id}_users`] = 0;
    row[`${id}_sessions`] = 0;
  });
  return { ...row, ...overrides };
}

const DAY_ROWS = [
  kpiRow({
    report_day: "2026-10-10",
    visitors_users: "10", visitors_sessions: "14",
    high_users: "2", high_sessions: "3", medium_users: "4", medium_sessions: "5", low_users: "4", low_sessions: "6",
  }),
  kpiRow({ report_day: "2026-10-12", visitors_users: "20", visitors_sessions: "25", low_sessions: "11" }),
];
const STARTED_ROWS = [
  { report_day: "2026-10-10", sessions_started: "100" },
  { report_day: "2026-10-11", sessions_started: "120" },
  { report_day: "2026-10-12", sessions_started: null },
];

function makeConn(overrides = {}) {
  const handlers = {
    days: () => DAY_ROWS,
    started: () => STARTED_ROWS,
    ...overrides,
  };
  const query = jest.fn(async (sql, options) => {
    if (sql.includes("FROM intent_daily_summary")) return handlers.started(sql, options);
    if (sql.includes("FROM intent_sessions")) return handlers.days(sql, options);
    throw new Error(`unexpected sql: ${sql}`);
  });
  return { query };
}

function newService() {
  return buildIntentFunnelService({ cache: createQueryCache() });
}

describe("intentFunnelService.getIntentReport", () => {
  test("returns every date of the range, oldest first, with the KPI figures of each day", async () => {
    const out = await newService().getIntentReport({ ...SPEC, conn: makeConn() });

    expect(out.meta.available).toBe(true);
    expect(out.filters).toEqual({ start: "2026-10-10", end: "2026-10-12", basis: "behavior" });
    expect(out.days.map((d) => d.date)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);

    expect(out.days[0].kpis.visitors).toEqual({ users: 10, sessions: 14 });
    expect(out.days[0].kpis.high).toEqual({ users: 2, sessions: 3 });
    expect(out.days[0].kpis.medium).toEqual({ users: 4, sessions: 5 });
    expect(out.days[0].kpis.low).toEqual({ users: 4, sessions: 6 });
    expect(out.days[2].kpis.low.sessions).toBe(11);
    // a day without sessions is a row of zeros, not a missing row
    expect(out.days[1].kpis.visitors).toEqual({ users: 0, sessions: 0 });
  });

  test("only the KPIs the report shows are computed, and there is no range total", async () => {
    const conn = makeConn();
    const out = await newService().getIntentReport({ ...SPEC, conn });
    expect(Object.keys(out.days[0].kpis)).toEqual(["visitors", "high", "medium", "low"]);
    expect(out).not.toHaveProperty("total");
    // one scan of intent_sessions plus the rollup read
    expect(conn.query).toHaveBeenCalledTimes(2);
    const sessionsSql = conn.query.mock.calls.find(([sql]) => sql.includes("FROM intent_sessions"))[0];
    // none of the columns for KPIs the table does not show (the behaviour rules still read their own inputs)
    expect(sessionsSql).not.toContain("AS pv");
    expect(sessionsSql).not.toContain("AS atc");
    expect(sessionsSql).not.toContain("page_view_count");
  });

  test("Total Sessions come from the daily rollup; a day it has not filled yet is null", async () => {
    const out = await newService().getIntentReport({ ...SPEC, conn: makeConn() });
    expect(out.days.map((d) => d.sessionsStarted)).toEqual([100, 120, null]);
  });

  test("without the rollup column the report still works, Total Sessions are null", async () => {
    const bad = Object.assign(new Error("Unknown column 'sessions_started'"), {
      code: "ER_BAD_FIELD_ERROR",
      errno: 1054,
    });
    const out = await newService().getIntentReport({
      ...SPEC,
      conn: makeConn({ started: () => { throw bad; } }),
    });
    expect(out.meta.available).toBe(true);
    expect(out.meta.sections.sessionsStarted).toMatchObject({ available: false });
    expect(out.days.every((d) => d.sessionsStarted === null)).toBe(true);
    expect(out.days[0].kpis.visitors.sessions).toBe(14);
  });

  describe("intent levels follow the page's basis", () => {
    test("behaviour counts a visitor once, at their best level", () => {
      const { sql } = _internal.buildReportQuery({
        basis: "behavior", start: "2026-10-10", endExclusive: "2026-10-13",
      });
      expect(sql).toContain("h = 0 AND m > 0");
      expect(sql).toContain("h = 0 AND m = 0 AND l > 0");
      expect(sql).toContain("session_time_spent_ms IS NULL");
      expect(sql).toContain("click_count");
    });

    test("score counts a visitor in every bucket they had a session in, scored sessions only", () => {
      const { sql } = _internal.buildReportQuery({
        basis: "score", start: "2026-10-10", endExclusive: "2026-10-13",
      });
      expect(sql).toContain("intent_status = 'scored'");
      expect(sql).toContain("intent_bucket IN ('high', 'medium', 'low')");
      expect(sql).toContain("m > 0");
      expect(sql).not.toContain("h = 0 AND m > 0");
    });

    test("an unknown basis falls back to behaviour", async () => {
      const out = await newService().getIntentReport({
        ...SPEC,
        basis: "x; DROP TABLE intent_sessions",
        conn: makeConn(),
      });
      expect(out.filters.basis).toBe("behavior");
    });
  });

  describe("query safety", () => {
    test("dates are bound parameters, never part of the SQL, and no query selects *", async () => {
      const conn = makeConn();
      await newService().getIntentReport({ ...SPEC, conn });
      conn.query.mock.calls.forEach(([sql, options]) => {
        expect(sql).not.toMatch(/select\s+\*/i);
        expect(sql).not.toContain("BBB");
        expect(sql).not.toContain("2026-10");
        expect(Array.isArray(options.replacements)).toBe(true);
      });
      const dayCall = conn.query.mock.calls.find(([sql]) => sql.includes("FROM intent_sessions"));
      expect(dayCall[1].replacements).toEqual(["2026-10-10", "2026-10-13"]);
    });

    test("results are cached per brand and never cross tenants", async () => {
      const service = newService();
      const connB = makeConn({ days: () => [kpiRow({ report_day: "2026-10-10", visitors_sessions: "5" })] });
      const a = await service.getIntentReport({ ...SPEC, brandKey: "BBB", conn: makeConn() });
      const b = await service.getIntentReport({ ...SPEC, brandKey: "PTS", conn: connB });
      expect(a.days[0].kpis.visitors.sessions).toBe(14);
      expect(b.days[0].kpis.visitors.sessions).toBe(5);
      expect(connB.query).toHaveBeenCalled();
    });
  });

  describe("brand databases without usable data", () => {
    test("a missing intent table is reported as unavailable", async () => {
      const missing = Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
      const out = await newService().getIntentReport({
        ...SPEC,
        conn: makeConn({ days: () => { throw missing; } }),
      });
      expect(out.meta).toEqual({ available: false, reason: "intent_tables_missing" });
      expect(out.days).toEqual([]);
    });

    test("an older intent_sessions layout is reported as unsupported", async () => {
      const bad = Object.assign(new Error("Unknown column"), { code: "ER_BAD_FIELD_ERROR", errno: 1054 });
      const out = await newService().getIntentReport({
        ...SPEC,
        conn: makeConn({ days: () => { throw bad; } }),
      });
      expect(out.meta).toEqual({ available: false, reason: "schema_unsupported" });
    });

    test("timeouts and unexpected failures propagate so the controller can answer 504 / 500", async () => {
      const timeout = Object.assign(new Error("timeout"), { code: "ER_QUERY_TIMEOUT", errno: 3024 });
      await expect(
        newService().getIntentReport({ ...SPEC, conn: makeConn({ days: () => { throw timeout; } }) }),
      ).rejects.toThrow("timeout");
      const boom = Object.assign(new Error("connection lost"), { code: "PROTOCOL_CONNECTION_LOST" });
      await expect(
        newService().getIntentReport({ ...SPEC, conn: makeConn({ days: () => { throw boom; } }) }),
      ).rejects.toThrow("connection lost");
    });
  });
});

describe("eachDate", () => {
  test("lists every date from start to end inclusive", () => {
    expect(_internal.eachDate("2026-10-30", "2026-11-02")).toEqual([
      "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02",
    ]);
    expect(_internal.eachDate("2026-10-10", "2026-10-10")).toEqual(["2026-10-10"]);
  });
});
