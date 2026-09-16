const pnlService = require("../../../services/pnl.service");

const { MISSING } = pnlService;

function dbRow(overrides = {}) {
  return {
    day_count: 3,
    meta_synced_days: 0,
    gross_sales: "1000.00",
    discounts: "100.00",
    cancellations: "50.00",
    gst: "129.66",
    net_sales: "720.34",
    cogs: "200.00",
    freight_inwards: "0.00",
    gross_margin: "520.34",
    shipping: "40.00",
    rto: "0.00",
    payment_gateway: "0.00",
    packaging: "0.00",
    cm1: "480.34",
    meta: "0.00",
    google: "0.00",
    other_paid: "0.00",
    cm2: "480.34",
    influencers: "0.00",
    content: "0.00",
    sponsorships: "0.00",
    other_brand: "0.00",
    cm3: "480.34",
    salaries: "0.00",
    rent: "0.00",
    technology: "0.00",
    agency_fees: "0.00",
    other_overheads: "0.00",
    ebitda: "480.34",
    ...overrides,
  };
}

function connReturning(...rowsPerCall) {
  const query = jest.fn();
  for (const row of rowsPerCall) query.mockResolvedValueOnce([row]);
  return { query };
}

const lineByKey = (summary, key) => summary.lineItems.find((row) => row.key === key);

describe("pnl.service getSummary", () => {
  test("reads overall_pnl for the current and previous ranges", async () => {
    const conn = connReturning(dbRow(), dbRow({ day_count: 3 }));

    const summary = await pnlService.getSummary({
      brandKey: "BBB",
      start: "2026-09-08",
      end: "2026-09-10",
      conn,
    });

    expect(conn.query).toHaveBeenCalledTimes(2);
    expect(conn.query.mock.calls[0][0]).toMatch(/FROM `overall_pnl`/);
    expect(conn.query.mock.calls[0][0]).toMatch(/`brand_key` = \?/);
    expect(conn.query.mock.calls[0][1].replacements).toEqual(["BBB", "2026-09-08", "2026-09-10"]);
    expect(conn.query.mock.calls[1][1].replacements).toEqual(["BBB", "2026-09-05", "2026-09-07"]);
    expect(summary.source).toBe("overall_pnl");
    expect(summary.coverage).toEqual({ days: 3, expectedDays: 3, previousDays: 3 });
  });

  test("returns summed revenue lines and subtotals as numbers", async () => {
    const conn = connReturning(dbRow(), dbRow());
    const summary = await pnlService.getSummary({ brandKey: "BBB", start: "2026-09-08", end: "2026-09-10", conn });

    expect(lineByKey(summary, "grossSales").amount).toBe(1000);
    expect(lineByKey(summary, "discounts").amount).toBe(-100);
    expect(lineByKey(summary, "netSales").amount).toBe(720.34);
    expect(lineByKey(summary, "cogs").amount).toBe(-200);
    expect(lineByKey(summary, "ebitda").amount).toBe(480.34);
    expect(summary.kpis.netSales.value).toBe(720.34);
    expect(summary.kpis.grossMarginPct.value).toBe(72.2);
  });

  test("returns '-' for cost lines nothing was attributed to", async () => {
    const conn = connReturning(dbRow(), dbRow());
    const summary = await pnlService.getSummary({ brandKey: "BBB", start: "2026-09-08", end: "2026-09-10", conn });

    for (const key of ["rent", "salaries", "google", "meta", "paymentGateway"]) {
      const row = lineByKey(summary, key);
      expect(row.amount).toBe(MISSING);
      expect(row.previousAmount).toBe(MISSING);
      expect(row.pctOfNetSales).toBe(MISSING);
      expect(row.changePct).toBe(MISSING);
    }
    expect(summary.metaAdSpend.available).toBe(false);
    expect(lineByKey(summary, "meta").isLive).toBe(false);
  });

  test("returns '-' everywhere when the range has no rows", async () => {
    const empty = { day_count: 0, meta_synced_days: 0 };
    const conn = connReturning(empty, empty);
    const summary = await pnlService.getSummary({ brandKey: "BBB", start: "2026-09-08", end: "2026-09-10", conn });

    for (const row of summary.lineItems) {
      expect(row.amount).toBe(MISSING);
      expect(row.previousAmount).toBe(MISSING);
      expect(row.pctOfNetSales).toBe(MISSING);
      expect(row.changePct).toBe(MISSING);
    }
    expect(summary.kpis.netSales).toEqual({ value: MISSING, previousValue: MISSING, changePct: MISSING });
    expect(summary.kpis.ebitdaPct).toEqual({ value: MISSING, previousValue: MISSING, changePp: MISSING });
    expect(summary.metaAdSpend.available).toBe(false);
    expect(summary.coverage.days).toBe(0);
  });

  test("returns '-' for the comparison when only the previous range is empty", async () => {
    const conn = connReturning(dbRow(), { day_count: 0, meta_synced_days: 0 });
    const summary = await pnlService.getSummary({ brandKey: "BBB", start: "2026-09-08", end: "2026-09-10", conn });

    const gross = lineByKey(summary, "grossSales");
    expect(gross.amount).toBe(1000);
    expect(gross.previousAmount).toBe(MISSING);
    expect(gross.changePct).toBe(MISSING);
    expect(summary.kpis.netSales.changePct).toBe(MISSING);
    expect(summary.kpis.cm1Pct.changePp).toBe(MISSING);
  });

  test("computes change percentages when both ranges have data", async () => {
    const conn = connReturning(dbRow(), dbRow({ gross_sales: "800.00", net_sales: "600.00", gross_margin: "400.00" }));
    const summary = await pnlService.getSummary({ brandKey: "BBB", start: "2026-09-08", end: "2026-09-10", conn });

    expect(lineByKey(summary, "grossSales").changePct).toBe(25);
    expect(summary.kpis.netSales.changePct).toBe(20.1);
    expect(summary.kpis.grossMarginPct.previousValue).toBe(66.7);
    expect(summary.kpis.grossMarginPct.changePp).toBe(5.5);
  });

  test("marks Meta as synced when the rollup covered the range", async () => {
    const conn = connReturning(dbRow({ meta_synced_days: 3, meta: "90.00" }), dbRow());
    const summary = await pnlService.getSummary({ brandKey: "BBB", start: "2026-09-08", end: "2026-09-10", conn });

    expect(summary.metaAdSpend).toMatchObject({ available: true, spend: 90, source: "rollup", syncedDays: 3 });
    expect(lineByKey(summary, "meta")).toMatchObject({ amount: -90, isLive: true });
  });

  test("treats a missing overall_pnl table as no data", async () => {
    const query = jest.fn().mockRejectedValue({ original: { code: "ER_NO_SUCH_TABLE" } });
    const summary = await pnlService.getSummary({ brandKey: "BBB", start: "2026-09-08", end: "2026-09-10", conn: { query } });

    expect(lineByKey(summary, "grossSales").amount).toBe(MISSING);
    expect(summary.coverage.days).toBe(0);
  });

  test("rethrows unexpected database errors", async () => {
    const query = jest.fn().mockRejectedValue(new Error("boom"));
    await expect(
      pnlService.getSummary({ brandKey: "BBB", start: "2026-09-08", end: "2026-09-10", conn: { query } }),
    ).rejects.toThrow("boom");
  });

  test("returns '-' everywhere without a brand connection", async () => {
    const summary = await pnlService.getSummary({ brandKey: "BBB", start: "2026-09-08", end: "2026-09-10", conn: null });
    expect(lineByKey(summary, "netSales").amount).toBe(MISSING);
    expect(summary.kpis.netSales.value).toBe(MISSING);
  });

  test("monthly granularity compares against the previous calendar month", () => {
    expect(pnlService.computePreviousRange("2026-09-01", "2026-09-16", "monthly")).toEqual([
      "2026-08-01",
      "2026-08-31",
    ]);
  });
});
