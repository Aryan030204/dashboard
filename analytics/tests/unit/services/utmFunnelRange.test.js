/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { buildMetricsSnapshotService } = require("../../../services/metricsSnapshotService");

// A fake brand connection that records every query and answers by table.
function fakeConn() {
  const calls = [];
  const query = jest.fn(async (sql, options = {}) => {
    calls.push({ sql, replacements: options.replacements });
    if (/FROM utm_source_(daily|hourly)/.test(sql)) {
      return [{ utm_source: "facebook", sales: 10, sessions: 100, atc_sessions: 20, orders: 2 }];
    }
    return [];
  });
  return { conn: { query }, calls };
}

const NOW = new Date("2026-11-03T08:30:00Z"); // 14:00 on 2026-11-03 in India
const newService = () => buildMetricsSnapshotService({ now: () => NOW });
const baseSpec = { timezone: "Asia/Kolkata", includeDaily: false, includeUtm: true };

describe("UTM source funnel over a range of days", () => {
  test("a single day keeps the old behaviour: one-day window on both sides, one day apart by default", async () => {
    const { conn, calls } = fakeConn();
    const out = await newService().getDailyFunnel({
      ...baseSpec, conn, start: "2026-11-01", end: "2026-11-01", utmDate: "2026-11-01",
    });
    const base = calls.filter((c) => c.sql.includes("FROM utm_source_daily"));
    expect(base.map((c) => c.replacements)).toEqual([
      ["2026-11-01", "2026-11-01"],
      ["2026-10-31", "2026-10-31"],
    ]);
    expect(out.utmEndDate).toBe("2026-11-01");
    expect(out.utmRows[0]).toMatchObject({ previous_date: "2026-10-31", previous_end_date: "2026-10-31" });
  });

  test("a range on both sides reads whole windows with an inclusive between", async () => {
    const { conn, calls } = fakeConn();
    const out = await newService().getDailyFunnel({
      ...baseSpec, conn, start: "2026-10-28", end: "2026-11-01",
      utmDate: "2026-10-28", utmEndDate: "2026-11-01",
      compareUtmDate: "2026-10-23", compareUtmEndDate: "2026-10-27",
    });
    const base = calls.filter((c) => c.sql.includes("FROM utm_source_daily"));
    expect(base.map((c) => c.replacements)).toEqual([
      ["2026-10-28", "2026-11-01"],
      ["2026-10-23", "2026-10-27"],
    ]);
    expect(base[0].sql).toContain("metric_date >= ? AND metric_date <= ?");
    const orders = calls.filter((c) => c.sql.includes("FROM shopify_orders"));
    expect(orders[0].sql).toContain("created_date >= ? AND created_date <= ?");
    expect(out.utmRows[0]).toMatchObject({ previous_date: "2026-10-23", previous_end_date: "2026-10-27" });
    expect(out.utmEndDate).toBe("2026-11-01");
  });

  test("only the single day today cuts the compared side at the last completed hour", async () => {
    const today = fakeConn();
    await newService().getDailyFunnel({
      ...baseSpec, conn: today.conn, start: "2026-11-03", end: "2026-11-03",
      utmDate: "2026-11-03", compareUtmDate: "2026-11-02",
    });
    const hourly = today.calls.filter((c) => c.sql.includes("FROM utm_source_hourly"));
    expect(hourly).toHaveLength(1);
    expect(hourly[0].replacements).toEqual(["2026-11-02", "2026-11-02", 13]);

    const range = fakeConn();
    await newService().getDailyFunnel({
      ...baseSpec, conn: range.conn, start: "2026-11-01", end: "2026-11-03",
      utmDate: "2026-11-01", utmEndDate: "2026-11-03",
      compareUtmDate: "2026-10-29", compareUtmEndDate: "2026-10-31",
    });
    expect(range.calls.some((c) => c.sql.includes("utm_source_hourly"))).toBe(false);
  });

  test("the campaign grain takes the same ranges", async () => {
    const { conn, calls } = fakeConn();
    await newService().getDailyFunnel({
      ...baseSpec, conn, start: "2026-10-28", end: "2026-11-01", utmSource: "facebook",
      utmDate: "2026-10-28", utmEndDate: "2026-11-01",
      compareUtmDate: "2026-10-23", compareUtmEndDate: "2026-10-27",
    });
    const campaign = calls.filter((c) => c.sql.includes("FROM utm_source_campaign_daily"));
    expect(campaign.map((c) => c.replacements)).toEqual([
      ["2026-10-28", "2026-11-01", "facebook"],
      ["2026-10-23", "2026-10-27", "facebook"],
    ]);
  });
});

describe("daily-funnel request validation", () => {
  const spec = { conn: {}, start: "2026-11-03", end: "2026-11-03" };
  function run(query) {
    const getDailyFunnel = jest.fn(async () => ({ ok: true }));
    jest.resetModules();
    jest.doMock("../../../modules/metrics/requestNormalizer", () => ({
      normalizeMetricRequest: () => ({ ok: true, spec }),
    }));
    const { buildTrendController: build } = require("../../../modules/metrics/trendController");
    const controller = build({ metricsService: { getDailyFunnel } });
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    return controller.dailyFunnel({ query, user: { isAuthor: true } }, res).then(() => ({ res, getDailyFunnel }));
  }

  test("up to 7 days on each side is accepted and passed on", async () => {
    const { res, getDailyFunnel } = await run({
      utm_date: "2026-10-27", utm_end_date: "2026-11-02",
      compare_utm_date: "2026-10-20", compare_utm_end_date: "2026-10-26",
    });
    expect(res.statusCode).toBe(200);
    expect(getDailyFunnel).toHaveBeenCalledWith(expect.objectContaining({
      utmDate: "2026-10-27", utmEndDate: "2026-11-02",
      compareUtmDate: "2026-10-20", compareUtmEndDate: "2026-10-26",
    }));
  });

  test("8 days is rejected, on either side", async () => {
    const current = await run({ utm_date: "2026-10-26", utm_end_date: "2026-11-02" });
    expect(current.res.statusCode).toBe(400);
    expect(current.res.body.error).toMatch(/cannot exceed 7 days/);
    const compare = await run({
      utm_date: "2026-11-02", compare_utm_date: "2026-10-19", compare_utm_end_date: "2026-10-26",
    });
    expect(compare.res.statusCode).toBe(400);
    expect(compare.getDailyFunnel).not.toHaveBeenCalled();
  });

  test("an end before the start, or a bad date, is rejected", async () => {
    expect((await run({ utm_date: "2026-11-02", utm_end_date: "2026-11-01" })).res.statusCode).toBe(400);
    expect((await run({ utm_date: "11/02/2026" })).res.statusCode).toBe(400);
  });

  test("the old single-date request still works and ends on the same day", async () => {
    const { res, getDailyFunnel } = await run({ utm_date: "2026-11-02", compare_utm_date: "2026-11-01" });
    expect(res.statusCode).toBe(200);
    expect(getDailyFunnel).toHaveBeenCalledWith(expect.objectContaining({
      utmDate: "2026-11-02", utmEndDate: "2026-11-02",
      compareUtmDate: "2026-11-01", compareUtmEndDate: "2026-11-01",
    }));
  });
});
