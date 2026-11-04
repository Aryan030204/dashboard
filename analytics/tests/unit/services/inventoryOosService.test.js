/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const {
  buildInventoryOosService,
  normalizeOosTrendRequest,
  _internal,
} = require("../../../services/inventoryOosService");

const { localToUtcMs, zoneOffsetMs, parseDbUtc, toDbUtc, isMissingTableError } = _internal;

const mysqlCore = require("mysql2");

const IST = "Asia/Kolkata";
const NOW = Date.parse("2026-11-04T08:00:00Z"); // 13:30 in India

// Stock-outs as the pipeline stores them (UTC wall clock, naive strings).
//  A: out 2026-11-03 15:46 IST, back 2026-11-04 09:55 IST with 9137 units
//  B: out 2026-11-03 01:30 IST, still out
//  C: out 2026-11-04 06:13 IST, still out
const ROWS = [
  { id: 3, product_id: "200", variant_id: "2001", oos_at: "2026-11-04 00:43:00", back_at: null, start_quantity: 0, recovery_quantity: null },
  { id: 1, product_id: "100", variant_id: "1001", oos_at: "2026-11-03 10:16:00", back_at: "2026-11-04 04:25:00", start_quantity: 0, recovery_quantity: 9137 },
  { id: 2, product_id: "100", variant_id: "1002", oos_at: "2026-11-02 20:00:00", back_at: null, start_quantity: 0, recovery_quantity: null },
];

function fakeConn({ rows = ROWS, open = 2, error = null } = {}) {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (sql, options) => {
      // Same formatting the tenant connection applies (mysql2 format: positional `?` only).
      const finalSql = mysqlCore.format(sql, options.replacements);
      calls.push({ sql, replacements: options.replacements, finalSql });
      if (error) throw error;
      return /COUNT\(\*\)/.test(sql) ? [{ n: open }] : rows;
    }),
  };
}

const service = (extra = {}) => buildInventoryOosService({ now: () => NOW, loadNames: async () => new Map(), ...extra });
const base = { brandKey: "TMC", resolveShopSubdomain: () => "tmc", timezone: IST };

describe("timezone helpers", () => {
  test("India midnight is 18:30 UTC the day before", () => {
    expect(new Date(localToUtcMs("2026-11-04", 0, IST)).toISOString()).toBe("2026-11-03T18:30:00.000Z");
    expect(zoneOffsetMs(NOW, IST)).toBe(5.5 * 3600 * 1000);
  });

  test("database strings are read as UTC and written back the same way", () => {
    expect(new Date(parseDbUtc("2026-11-04 04:25:49")).toISOString()).toBe("2026-11-04T04:25:49.000Z");
    expect(toDbUtc(Date.parse("2026-11-04T04:25:49Z"))).toBe("2026-11-04 04:25:49");
    expect(parseDbUtc(null)).toBeNull();
    expect(parseDbUtc("")).toBeNull();
  });
});

describe("normalizeOosTrendRequest", () => {
  test("accepts a range and picks hourly for one or two days, daily for longer", () => {
    expect(normalizeOosTrendRequest({ start: "2026-11-04", end: "2026-11-04" }).spec.granularity).toBe("hourly");
    expect(normalizeOosTrendRequest({ start: "2026-11-01", end: "2026-11-04" }).spec.granularity).toBe("daily");
    expect(normalizeOosTrendRequest({ start: "2026-11-04" }).spec).toMatchObject({ start: "2026-11-04", end: "2026-11-04" });
  });

  test("rejects bad dates, reversed ranges and over-long ranges", () => {
    for (const query of [
      { start: "11/04/2026", end: "11/05/2026" },
      { start: "2026-11-05", end: "2026-11-04" },
      { start: "2026-10-01", end: "2026-11-05" }, // 36 days
      { start: "2026-11-01", end: "2026-11-09", granularity: "hourly" }, // 9 days hourly
      { start: "2026-11-01", end: "2026-11-02", granularity: "weekly" },
    ]) {
      const out = normalizeOosTrendRequest(query);
      expect(out.ok).toBe(false);
      expect(out.status).toBe(400);
    }
    expect(normalizeOosTrendRequest({ start: "2026-10-05", end: "2026-11-04" }).ok).toBe(true); // exactly 31 days
    expect(normalizeOosTrendRequest({ start: "2026-10-29", end: "2026-11-04", granularity: "hourly" }).ok).toBe(true); // exactly 7 days
  });

  test("a product id may be a Shopify gid, but must end in digits", () => {
    expect(normalizeOosTrendRequest({ start: "2026-11-04", product_id: "gid://shopify/Product/123" }).spec.productId).toBe("123");
    expect(normalizeOosTrendRequest({ start: "2026-11-04", product_id: "1; DROP" }).ok).toBe(false);
  });
});

describe("getOosTrend: daily", () => {
  const args = { ...base, start: "2026-11-03", end: "2026-11-04", granularity: "daily" };

  test("reads the range in UTC, bucketed by the brand's day", async () => {
    const conn = fakeConn();
    const out = await service().getOosTrend({ ...args, conn });
    expect(conn.calls[0].replacements).toEqual(["2026-11-04 18:30:00", "2026-11-02 18:30:00"]);
    expect(conn.calls[0].finalSql).toContain("out_of_stock_at < '2026-11-04 18:30:00'");
    expect(conn.calls[0].finalSql).toContain("back_in_stock_at >= '2026-11-02 18:30:00'");
    for (const call of conn.calls) expect(call.finalSql).not.toMatch(/:\w+(?![^']*')/); // no unreplaced :name left
    expect(out.available).toBe(true);
    expect(out.buckets.map((b) => b.label)).toEqual(["2026-11-03", "2026-11-04"]);

    const [nov3, nov4] = out.buckets;
    expect(nov3).toMatchObject({ oos_count: 2, new_oos: 2, restocked: 0, restock_qty: 0, future: false });
    // by now (13:30 IST): A is back, B and C are out
    expect(nov4).toMatchObject({ oos_count: 2, new_oos: 1, restocked: 1, restock_qty: 9137, future: false });
  });

  test("summary: stock-outs, restocks, units, average duration and what is out right now", async () => {
    const out = await service().getOosTrend({ ...args, conn: fakeConn({ open: 2 }) });
    expect(out.summary).toEqual({
      currently_out_of_stock: 2,
      stock_outs_in_range: 3,
      restocks_in_range: 1,
      units_restocked: 9137,
      avg_duration_minutes: 1089, // 15:46 IST -> 09:55 IST next day
    });
    expect(out.episodes).toEqual([]); // the list is only for a selected product
  });

  test("a stock-out that began before the range is out for the whole range, but not 'new'", async () => {
    const rows = [{ id: 9, product_id: "1", variant_id: "11", oos_at: "2026-10-20 05:00:00", back_at: null, start_quantity: 0, recovery_quantity: null }];
    const out = await service().getOosTrend({ ...args, conn: fakeConn({ rows, open: 1 }) });
    expect(out.buckets.map((b) => [b.oos_count, b.new_oos])).toEqual([[1, 0], [1, 0]]);
    expect(out.summary.stock_outs_in_range).toBe(0);
  });

  test("days in the future have no count", async () => {
    const out = await service().getOosTrend({ ...args, end: "2026-11-06", conn: fakeConn() });
    const last = out.buckets[out.buckets.length - 1];
    expect(last).toMatchObject({ label: "2026-11-06", future: true, oos_count: null });
  });
});

describe("getOosTrend: hourly", () => {
  test("24 hourly buckets for one day, events land in the right hour of the brand's day", async () => {
    const out = await service().getOosTrend({ ...base, start: "2026-11-04", end: "2026-11-04", granularity: "hourly", conn: fakeConn() });
    expect(out.buckets).toHaveLength(24);
    expect(out.buckets[0]).toMatchObject({ label: "2026-11-04 00:00", start: "2026-11-03T18:30:00.000Z" });

    const byLabel = Object.fromEntries(out.buckets.map((b) => [b.label, b]));
    expect(byLabel["2026-11-04 06:00"]).toMatchObject({ new_oos: 1 }); // C: 06:13 IST
    expect(byLabel["2026-11-04 09:00"]).toMatchObject({ restocked: 1, restock_qty: 9137 }); // A: 09:55 IST
    expect(byLabel["2026-11-04 09:00"].oos_count).toBe(2); // B and C
    expect(byLabel["2026-11-04 05:00"].oos_count).toBe(2); // A and B, before C
    // 13:30 IST now: the 14:00 hour has not started
    expect(byLabel["2026-11-04 14:00"]).toMatchObject({ future: true, oos_count: null });
    expect(byLabel["2026-11-04 13:00"].future).toBe(false);
  });
});

describe("getOosTrend: one product", () => {
  test("filters by product and returns its stock-outs with variant names and durations", async () => {
    const conn = fakeConn({ rows: ROWS.filter((r) => r.product_id === "100") });
    const names = new Map([["1001", { sku: "SKU-1", title: "Rose Perfume" }]]);
    const out = await service({ loadNames: async () => names }).getOosTrend({
      ...base, start: "2026-11-03", end: "2026-11-04", granularity: "daily", productId: "100", conn,
    });
    expect(conn.calls[0].finalSql).toContain("AND product_id = '100'");
    expect(conn.calls[1].finalSql).toContain("back_in_stock_at IS NULL AND product_id = '100'");
    expect(out.product_id).toBe("100");
    expect(out.episodes).toHaveLength(2);

    const restocked = out.episodes.find((e) => e.variant_id === "1001");
    expect(restocked).toMatchObject({
      sku: "SKU-1", title: "Rose Perfume", is_open: false, recovery_quantity: 9137, duration_minutes: 1089,
      out_of_stock_at: "2026-11-03T10:16:00.000Z", back_in_stock_at: "2026-11-04T04:25:00.000Z",
    });
    const open = out.episodes.find((e) => e.variant_id === "1002");
    expect(open).toMatchObject({ is_open: true, back_in_stock_at: null, sku: null });
    expect(open.duration_minutes).toBe(Math.round((NOW - Date.parse("2026-11-02T20:00:00Z")) / 60000)); // runs to now
  });

  test("the list is capped", async () => {
    const rows = Array.from({ length: 700 }, (_, i) => ({
      id: i + 1, product_id: "100", variant_id: String(5000 + i), oos_at: "2026-11-03 10:00:00", back_at: null, start_quantity: 0, recovery_quantity: null,
    }));
    const out = await service().getOosTrend({ ...base, start: "2026-11-03", end: "2026-11-04", granularity: "daily", productId: "100", conn: fakeConn({ rows, open: 700 }) });
    expect(out.episodes).toHaveLength(500);
    expect(out.buckets[0].oos_count).toBe(700); // the chart still counts all of them
  });
});

describe("missing table", () => {
  test("a brand without inventory_oos_history gets available:false, not an error", async () => {
    const error = Object.assign(new Error("wrapped"), {
      original: { code: "ER_NO_SUCH_TABLE", errno: 1146, message: "Table 'TMC.inventory_oos_history' doesn't exist" },
    });
    const out = await service().getOosTrend({ ...base, start: "2026-11-03", end: "2026-11-04", granularity: "daily", conn: fakeConn({ error }) });
    expect(out).toEqual({ available: false });
    expect(isMissingTableError(error)).toBe(true);
  });

  test("other database errors are not swallowed", async () => {
    const error = Object.assign(new Error("connection lost"), { code: "ECONNRESET" });
    await expect(
      service().getOosTrend({ ...base, start: "2026-11-03", end: "2026-11-04", granularity: "daily", conn: fakeConn({ error }) }),
    ).rejects.toThrow("connection lost");
  });
});
