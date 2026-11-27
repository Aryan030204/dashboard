/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const {
  buildInventorySnapshotService,
  normalizeSnapshotRequest,
} = require("../../../services/inventorySnapshotService");

const NOW = new Date("2026-11-26T20:00:00Z"); // 27 Nov 01:30 in India
const request = (months, now = NOW) =>
  normalizeSnapshotRequest(months === undefined ? {} : { months }, { timezone: "Asia/Kolkata", now });

const NAMES = new Map([
  ["1", { sku: "OUD", title: "Oud 100ml" }],
  ["2", { sku: "oud", title: "Oud 30ml" }],
  ["3", { sku: "BLU", title: "Blu" }],
]);
const rec = (date, variantId, units) => ({ date, variant_id: variantId, units });

const run = async (records, spec, names = NAMES) => {
  const conn = { query: jest.fn(async () => records) };
  const service = buildInventorySnapshotService({ loadNames: async () => names });
  const out = await service.getSnapshot({ conn, brandKey: "X", ...spec });
  return { out, conn };
};

describe("inventory snapshot request", () => {
  test("defaults to the current and last month in the brand's timezone", () => {
    expect(request().spec).toMatchObject({ months: ["2026-10", "2026-11"], today: "2026-11-27" });
  });

  test("on the 1st the default is the two finished months; January reaches back a year", () => {
    expect(request(undefined, new Date("2026-12-01T06:00:00Z")).spec.months).toEqual(["2026-10", "2026-11"]);
    expect(request(undefined, new Date("2027-01-15T06:00:00Z")).spec.months).toEqual(["2026-12", "2027-01"]);
  });

  test("any two different past months are accepted and put in order", () => {
    expect(request("2026-11,2025-09").spec.months).toEqual(["2025-09", "2026-11"]);
  });

  test.each(["2026-11", "2026-09,2026-10,2026-11", "2026-11,2026-11", "2026-11,2026-12", "2026-13,2026-11", "a,b"])(
    "rejects %s",
    (months) => {
      expect(request(months)).toMatchObject({ ok: false, status: 400 });
    },
  );
});

describe("inventory snapshot data", () => {
  const spec = { months: ["2026-09", "2026-11"], today: "2026-11-04" };
  const records = [
    rec("2026-09-01", 1, 10),
    rec("2026-09-02", 2, "20"),
    rec("2026-11-01", 1, 4),
    rec("2026-11-01", 2, 2),
    rec("2026-11-03", 3, 9),
  ];

  test("reads both months once, ending yesterday", async () => {
    const { conn } = await run(records, spec);
    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(conn.query.mock.calls[0][1].replacements).toEqual(["2026-09-01", "2026-09-30", "2026-11-01", "2026-11-03"]);
  });

  test("variants of one SKU are one row; days belong to the later month", async () => {
    const { out } = await run(records, spec);
    expect(out.days).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    const oud = out.rows.find((r) => r.sku === "OUD");
    expect(oud.title).toBe("Oud 100ml (+1 more)");
    // 2 Nov has no row for any variant: a gap, shown empty. 3 Nov has data but no OUD sale: 0.
    expect(oud.units).toEqual([6, null, 0]);
    expect(out.rows.find((r) => r.sku === "BLU").units).toEqual([0, null, 9]);
  });

  test("DRR divides by the days that have data, counting days without a sale", async () => {
    const { out } = await run(records, spec);
    expect(out.months.map((m) => m.days_with_data)).toEqual([2, 2]);
    expect(out.rows.find((r) => r.sku === "OUD").drr).toEqual([15, 3]);
    expect(out.rows.find((r) => r.sku === "BLU").drr).toEqual([0, 4.5]);
  });

  test("a current month without a finished day is not queried and has no days", async () => {
    const { out, conn } = await run([rec("2026-10-05", 3, 5)], { months: ["2026-10", "2026-11"], today: "2026-11-01" });
    expect(conn.query.mock.calls[0][1].replacements).toEqual(["2026-10-01", "2026-10-31"]);
    expect(out.days).toEqual([]);
    expect(out.rows[0].drr).toEqual([5, null]);
  });

  test("a variant missing from the inventory cache is still listed", async () => {
    const { out } = await run([rec("2026-11-01", 99, 1)], spec);
    expect(out.rows[0]).toMatchObject({ sku: "Variant 99", title: "" });
  });

  test("a brand without the table is reported as unavailable; other errors are not swallowed", async () => {
    const failing = (original) => {
      const conn = { query: async () => Promise.reject(Object.assign(new Error("x"), { original })) };
      return buildInventorySnapshotService({ loadNames: async () => new Map() }).getSnapshot({ conn, ...spec });
    };
    await expect(failing({ errno: 1146, message: "Table 'db.daily_inventory_summary' doesn't exist" })).resolves.toEqual({
      available: false,
    });
    await expect(failing({ errno: 1054, message: "Unknown column" })).rejects.toThrow("x");
  });
});
