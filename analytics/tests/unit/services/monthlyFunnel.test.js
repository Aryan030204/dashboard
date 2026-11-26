/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { buildMetricsSnapshotService } = require("../../../services/metricsSnapshotService");

const DAYS = ["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"];

// A fake brand connection that answers the daily funnel's tables with fixed per-day numbers.
function fakeConn() {
  const query = jest.fn(async (sql) => {
    if (/FROM hour_wise_sales/.test(sql)) return DAYS.map((date) => ({ date, sales: 100, orders: 5 }));
    if (/prepaid_orders/.test(sql)) return DAYS.map((date) => ({ date, prepaid_orders: 2, cod_orders: 3, partially_paid_orders: 1 }));
    if (/FROM overall_summary/.test(sql)) return DAYS.map((date) => ({ date, sessions: 200, atc: 20 }));
    if (/FROM discount_summary/.test(sql)) return DAYS.map((date) => ({ date, discount_amount: 7 }));
    if (/FROM hourly_sessions_summary_shopify/.test(sql)) return DAYS.map((date) => ({ date, ci_events: 4 }));
    return [];
  });
  return { query };
}

const service = () => buildMetricsSnapshotService({ now: () => new Date("2026-01-03T08:30:00Z") });
const spec = (extra) => ({
  conn: fakeConn(), timezone: "Asia/Kolkata", start: "2025-12-01", end: "2026-01-03",
  includeDaily: true, includeUtm: false, ...extra,
});
const KEYS = ["sales", "sessions", "atc_sessions", "ci_events", "orders", "discount_amount", "prepaid_orders", "cod_orders", "partially_paid_orders"];

describe("monthly conversion funnel", () => {
  test("each month is the sum of its daily rows, across a year boundary, newest first", async () => {
    const daily = await service().getDailyFunnel(spec());
    const monthly = await service().getDailyFunnel(spec({ granularity: "monthly" }));
    expect(monthly.granularity).toBe("monthly");
    expect(monthly.rows.map((r) => r.date)).toEqual(["2026-01-01", "2025-12-01"]);
    for (const month of monthly.rows) {
      const days = daily.rows.filter((d) => d.date.startsWith(month.date.slice(0, 7)));
      for (const key of KEYS) expect(month[key]).toBe(days.reduce((sum, d) => sum + d[key], 0));
      expect(month.days_with_data).toBe(2);
    }
    expect(monthly.rows[0]).toMatchObject({ sessions: 400, orders: 10, discount_amount: 14 });
  });

  test("without granularity the daily response is unchanged", async () => {
    const out = await service().getDailyFunnel(spec());
    expect(out.granularity).toBe("daily");
    expect(out.rows).toHaveLength(34);
    expect(out.rows[0]).not.toHaveProperty("days_with_data");
  });
});

describe("average performance column", () => {
  const scores = [{ date: "2025-12-30", performance: 40 }, { date: "2025-12-31", performance: "60" }, { date: "2026-01-02", performance: 30 }];
  const withScores = () => {
    const base = fakeConn();
    return { query: jest.fn(async (sql) => (/FROM daily_web_vitals_summary/.test(sql) ? scores : base.query(sql))) };
  };

  test("a month averages the days that have a score (never sums them); days without one stay empty", async () => {
    const daily = await service().getDailyFunnel(spec({ conn: withScores(), includePerformance: true }));
    const byDate = new Map(daily.rows.map((r) => [r.date, r.performance]));
    expect([byDate.get("2025-12-31"), byDate.get("2026-01-01")]).toEqual([60, null]);
    const monthly = await service().getDailyFunnel(spec({ conn: withScores(), includePerformance: true, granularity: "monthly" }));
    expect(monthly.rows.map((r) => r.performance)).toEqual([30, 50]);
  });

  test("without permission the table is not read and rows carry no performance", async () => {
    const conn = withScores();
    const out = await service().getDailyFunnel(spec({ conn }));
    expect(out.rows[0]).not.toHaveProperty("performance");
    expect(conn.query.mock.calls.some(([sql]) => sql.includes("daily_web_vitals_summary"))).toBe(false);
  });

  test("a failing performance query leaves the funnel intact", async () => {
    const base = fakeConn();
    const conn = { query: jest.fn(async (sql) => { if (/daily_web_vitals_summary/.test(sql)) throw new Error("no table"); return base.query(sql); }) };
    jest.spyOn(console, "error").mockImplementation(() => {});
    const out = await service().getDailyFunnel(spec({ conn, includePerformance: true, granularity: "monthly" }));
    expect(out.rows[0]).toMatchObject({ sessions: 400, performance: null });
    console.error.mockRestore();
  });
});

describe("monthly funnel request validation", () => {
  function run(start, end, query) {
    const getDailyFunnel = jest.fn(async () => ({ ok: true }));
    jest.resetModules();
    jest.doMock("../../../modules/metrics/requestNormalizer", () => ({
      normalizeMetricRequest: () => ({ ok: true, spec: { conn: {}, start, end } }),
    }));
    const { buildTrendController } = require("../../../modules/metrics/trendController");
    const controller = buildTrendController({ metricsService: { getDailyFunnel } });
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    return controller.dailyFunnel({ query, user: { isAuthor: true } }, res).then(() => ({ res, getDailyFunnel }));
  }

  test("6 months is accepted and never reads the UTM tables", async () => {
    const { res, getDailyFunnel } = await run("2026-06-01", "2026-11-26", { granularity: "monthly", include_daily: "false", include_utm: "true" });
    expect(res.statusCode).toBe(200);
    expect(getDailyFunnel).toHaveBeenCalledWith(expect.objectContaining({ granularity: "monthly", includeDaily: true, includeUtm: false }));
  });

  test("7 months is rejected, also across a year boundary", async () => {
    for (const [start, end] of [["2026-05-01", "2026-11-26"], ["2025-09-01", "2026-03-31"]]) {
      const { res, getDailyFunnel } = await run(start, end, { granularity: "monthly" });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/cannot exceed 6 months/);
      expect(getDailyFunnel).not.toHaveBeenCalled();
    }
  });

  test("an unknown granularity is rejected; a long daily range is still allowed", async () => {
    expect((await run("2026-11-01", "2026-11-26", { granularity: "weekly" })).res.statusCode).toBe(400);
    expect((await run("2025-01-01", "2026-11-26", {})).res.statusCode).toBe(200);
  });
});
