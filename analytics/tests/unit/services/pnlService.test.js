const pnlService = require("../../../services/pnl.service");

const { MISSING, META_SPEND_TABLE, GOOGLE_SPEND_TABLE } = pnlService;

function dbRow(overrides = {}) {
  return {
    day_count: 3,
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

const NO_ROLLUP = { day_count: 0, spend: "0.00" };

// A fake brand connection: overall_pnl answers come from `pnlRows` in call
// order (current range, then previous); each ad-spend rollup answers from
// its own list the same way, defaulting to "no rows" when not given.
function connReturning(...pnlRows) {
  return connWith({ pnl: pnlRows });
}

function connWith({ pnl = [], meta = [], google = [] }) {
  const queues = { pnl: [...pnl], meta: [...meta], google: [...google] };
  const query = jest.fn(async (sql) => {
    let queue = queues.pnl;
    if (sql.includes(`\`${META_SPEND_TABLE}\``)) queue = queues.meta;
    else if (sql.includes(`\`${GOOGLE_SPEND_TABLE}\``)) queue = queues.google;
    const row = queue.shift();
    if (row === undefined) return [queue === queues.pnl ? { day_count: 0 } : NO_ROLLUP];
    return [row];
  });
  return { query };
}

const sqlCalls = (conn, table) => conn.query.mock.calls.filter(([sql]) => sql.includes(`\`${table}\``));

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

    const pnlCalls = sqlCalls(conn, "overall_pnl");
    expect(pnlCalls).toHaveLength(2);
    expect(pnlCalls[0][0]).toMatch(/`brand_key` = \?/);
    expect(pnlCalls[0][1].replacements).toEqual(["BBB", "2026-09-08", "2026-09-10"]);
    expect(pnlCalls[1][1].replacements).toEqual(["BBB", "2026-09-05", "2026-09-07"]);
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

    for (const key of ["rent", "salaries", "paymentGateway"]) {
      const row = lineByKey(summary, key);
      expect(row.amount).toBe(MISSING);
      expect(row.previousAmount).toBe(MISSING);
      expect(row.pctOfNetSales).toBe(MISSING);
      expect(row.changePct).toBe(MISSING);
    }
  });

  test("returns '-' everywhere when the range has no rows", async () => {
    const empty = { day_count: 0 };
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
    expect(summary.googleAdSpend.available).toBe(false);
    expect(summary.coverage.days).toBe(0);
  });

  test("returns '-' for the comparison when only the previous range is empty", async () => {
    const conn = connReturning(dbRow(), { day_count: 0 });
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

  test("reads the Meta and Google lines from their rollup tables, not overall_pnl", async () => {
    const conn = connWith({
      pnl: [dbRow({ meta: "80.00", google: "50.00", cm2: "350.34", cm3: "350.34", ebitda: "350.34" }), dbRow()],
      meta: [{ day_count: 3, spend: "90.00" }],
      google: [{ day_count: 2, spend: "30.00" }],
    });
    const summary = await pnlService.getSummary({ brandKey: "BBB", start: "2026-09-08", end: "2026-09-10", conn });

    const metaCalls = sqlCalls(conn, META_SPEND_TABLE);
    expect(metaCalls).toHaveLength(2);
    expect(metaCalls[0][1].replacements).toEqual(["2026-09-08", "2026-09-10"]);
    expect(sqlCalls(conn, GOOGLE_SPEND_TABLE)[1][1].replacements).toEqual(["2026-09-05", "2026-09-07"]);

    expect(lineByKey(summary, "meta")).toMatchObject({ amount: -90, isLive: true });
    expect(lineByKey(summary, "google")).toMatchObject({ amount: -30, isLive: true });
    expect(summary.metaAdSpend).toMatchObject({ available: true, spend: 90, source: "rollup", syncedDays: 3, totalDays: 3 });
    expect(summary.googleAdSpend).toMatchObject({ available: true, spend: 30, source: "rollup", syncedDays: 2, totalDays: 3 });
  });

  test("shifts CM2/CM3/EBITDA so they add up from the rollup spend shown", async () => {
    // Worker deducted 80 (meta) + 50 (google) from CM1 = 480.34; the rollups
    // say the real spend was 90 + 30, so the subtotals move by +10.
    const conn = connWith({
      pnl: [dbRow({ meta: "80.00", google: "50.00", cm2: "350.34", cm3: "350.34", ebitda: "350.34" }), dbRow()],
      meta: [{ day_count: 3, spend: "90.00" }],
      google: [{ day_count: 3, spend: "30.00" }],
    });
    const summary = await pnlService.getSummary({ brandKey: "BBB", start: "2026-09-08", end: "2026-09-10", conn });

    expect(lineByKey(summary, "cm1").amount).toBe(480.34);
    expect(lineByKey(summary, "cm2").amount).toBe(360.34);
    expect(lineByKey(summary, "cm3").amount).toBe(360.34);
    expect(lineByKey(summary, "ebitda").amount).toBe(360.34);
    expect(summary.kpis.ebitdaPct.value).toBe(50);
  });

  test("returns '-' for Meta and Google when their rollups have no rows, and backs the estimate out of the subtotals", async () => {
    // Worker had no synced spend, so it charged the configured/default
    // percentages (80 meta, 50 google). Neither is real spend: both lines are
    // "-" and the subtotals go back to CM1.
    const conn = connWith({
      pnl: [dbRow({ meta: "80.00", google: "50.00", cm2: "350.34", cm3: "350.34", ebitda: "350.34" }), dbRow()],
    });
    const summary = await pnlService.getSummary({ brandKey: "BBB", start: "2026-09-08", end: "2026-09-10", conn });

    for (const key of ["meta", "google"]) {
      const row = lineByKey(summary, key);
      expect(row.amount).toBe(MISSING);
      expect(row.previousAmount).toBe(MISSING);
      expect(row.pctOfNetSales).toBe(MISSING);
      expect(row.changePct).toBe(MISSING);
      expect(row.isLive).toBe(false);
    }
    expect(lineByKey(summary, "cm2").amount).toBe(480.34);
    expect(lineByKey(summary, "ebitda").amount).toBe(480.34);
    expect(summary.metaAdSpend).toMatchObject({ available: false, source: "none" });
    expect(summary.googleAdSpend).toMatchObject({ available: false, source: "none" });
  });

  test("treats a missing rollup table as no synced spend", async () => {
    const query = jest.fn(async (sql) => {
      if (sql.includes("`overall_pnl`")) return [dbRow()];
      throw { original: { code: "ER_NO_SUCH_TABLE" } };
    });
    const summary = await pnlService.getSummary({ brandKey: "BBB", start: "2026-09-08", end: "2026-09-10", conn: { query } });

    expect(lineByKey(summary, "grossSales").amount).toBe(1000);
    expect(lineByKey(summary, "meta").amount).toBe(MISSING);
    expect(lineByKey(summary, "google").amount).toBe(MISSING);
  });

  test("shows rollup spend even when overall_pnl has no rows for the range", async () => {
    const conn = connWith({ pnl: [], meta: [{ day_count: 1, spend: "12.50" }] });
    const summary = await pnlService.getSummary({ brandKey: "BBB", start: "2026-09-08", end: "2026-09-10", conn });

    expect(lineByKey(summary, "meta").amount).toBe(-12.5);
    expect(lineByKey(summary, "google").amount).toBe(MISSING);
    expect(lineByKey(summary, "cm2").amount).toBe(MISSING);
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
