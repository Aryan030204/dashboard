/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const {
  buildMarketplaceHistoryService,
  normalizeRangeRequest,
  normalizeProductRequest,
  buildOverview,
  buildProduct,
} = require("../../../services/marketplaceHistoryService");

const NOW = new Date("2026-11-27T20:00:00Z"); // 28 Nov 01:30 in India
const ZONE = { timezone: "Asia/Kolkata", now: NOW };
const SPEC = { start: "2026-11-01", end: "2026-11-28", pincode: "", timezone: "Asia/Kolkata" };
const NAMES = new Map([["AMAZON", "Amazon"], ["FLIPKART", "Flipkart"], ["BLINKIT", "Blinkit"]]);

const listing = (id, variantId, code, extra = {}) => ({
  listing_id: id, variant_id: variantId, code, listing_status: "ACTIVE", match_status: "AUTO_MATCHED",
  canonical_url: `https://example.com/${id}`, shopify_variant_id: variantId * 100, variant_title: "Default Title",
  price: "1000.00", compare_at_price: "1500.00", size_value: "100.000", size_unit: "ml", pack_count: 1,
  variant_active: 1, product_id: variantId, shopify_product_id: variantId * 10, product_title: `Product ${variantId}`,
  product_active: 1, ...extra,
});

const check = (listingId, variantId, code, at, price, extra = {}) => ({
  listing_id: listingId, variant_id: variantId, code, checked_at: at, status: "OK", availability: "IN_STOCK",
  validation: "OK", mkt_sp: price === null ? null : String(price), mkt_best_at_price: null, brand_sp: "1000.00",
  brand_mrp: "1500.00", ...extra,
});

const overview = (listings, snapshots, units = []) => buildOverview({ listings, snapshots, units, names: NAMES, spec: SPEC });

describe("request", () => {
  test("defaults to the last 90 days ending today in the brand's timezone", () => {
    expect(normalizeRangeRequest({}, ZONE).spec).toMatchObject({ start: "2026-08-31", end: "2026-11-28", pincode: "" });
    expect(normalizeRangeRequest({ range: "all" }, ZONE).spec.start).toBeNull();
  });

  test("rejects bad dates, order, pincode and variant", () => {
    expect(normalizeRangeRequest({ start: "yesterday" }, ZONE).status).toBe(400);
    expect(normalizeRangeRequest({ start: "2026-11-20", end: "2026-11-01" }, ZONE).status).toBe(400);
    expect(normalizeRangeRequest({ pincode: "1 OR 1=1" }, ZONE).status).toBe(400);
    expect(normalizeProductRequest({ variant_id: "abc" }, ZONE).status).toBe(400);
    expect(normalizeProductRequest({ variant_id: "7" }, ZONE).spec.variantId).toBe(7);
  });
});

describe("overview", () => {
  test("uses the latest good check of a day, in the brand's timezone", () => {
    const out = overview([listing(1, 1, "AMAZON")], [
      check(1, 1, "AMAZON", "2026-11-26 19:00:00", 900), // 27 Nov 00:30 in India
      check(1, 1, "AMAZON", "2026-11-27 03:00:00", 950),
      check(1, 1, "AMAZON", "2026-11-27 04:00:00", null, { status: "BLOCKED" }),
      check(1, 1, "AMAZON", "2026-11-27 05:00:00", 10, { validation: "SUSPECT" }),
    ]);
    expect(out.series.map((p) => p.date)).toEqual(["2026-11-27"]);
    expect(out.products[0].cells.AMAZON).toMatchObject({ state: "ok", price: 950, gap: { pct: -5, abs: -50 }, stale: false });
    expect(out.products[0]).toMatchObject({ size: "100ML", ourPrice: 1000, mrp: 1500, rank: null });
  });

  test("tells apart not listed, not read, out of stock and stale", () => {
    const out = overview(
      [listing(1, 1, "AMAZON"), listing(2, 1, "FLIPKART"), listing(3, 2, "BLINKIT"), listing(4, 2, "AMAZON")],
      [
        check(1, 1, "AMAZON", "2026-11-25 06:00:00", 900),
        check(2, 1, "FLIPKART", "2026-11-27 06:00:00", null, { status: "NETWORK_ERROR" }),
        check(3, 2, "BLINKIT", "2026-11-27 06:00:00", null, { status: "OUT_OF_STOCK", availability: "OUT_OF_STOCK" }),
      ],
    );
    const [first, second] = out.products;
    expect(first.cells.AMAZON).toMatchObject({ state: "ok", stale: true, day: "2026-11-25" });
    expect(first.cells.FLIPKART.state).toBe("unread");
    expect(first.cells.BLINKIT.state).toBe("unlisted");
    expect(second.cells.BLINKIT).toMatchObject({ state: "oos", gap: { pct: null } });
    expect(second.cells.AMAZON.state).toBe("unread");
    expect(out.series.at(-1).listed.BLINKIT.n).toBe(0); // out of stock is not in the median
  });

  test("leaves out rejected listings with their history, keeps replaced ones", () => {
    const out = overview(
      [
        listing(1, 1, "AMAZON", { listing_status: "DISABLED", match_status: "MANUAL_REJECTED" }),
        listing(2, 1, "FLIPKART", { listing_status: "DISABLED" }),
        listing(3, 1, "FLIPKART"),
      ],
      [
        check(1, 1, "AMAZON", "2026-11-26 06:00:00", 100),
        check(2, 1, "FLIPKART", "2026-11-26 06:00:00", 800),
        check(3, 1, "FLIPKART", "2026-11-27 06:00:00", 700),
      ],
    );
    expect(out.marketplaces.map((m) => m.code)).toEqual(["FLIPKART"]);
    expect(out.series.map((p) => p.listed.FLIPKART.median.pct)).toEqual([-20, -30]);
  });

  test("two listings on one marketplace: the cheapest in stock", () => {
    const out = overview(
      [listing(1, 1, "AMAZON"), listing(2, 1, "AMAZON")],
      [check(1, 1, "AMAZON", "2026-11-27 06:00:00", 900), check(2, 1, "AMAZON", "2026-11-27 06:00:00", 850)],
    );
    expect(out.products[0].cells.AMAZON).toMatchObject({ price: 850, url: "https://example.com/2" });
  });

  test("median and average, listed and best price, missing days", () => {
    const listings = [1, 2, 3].map((v) => listing(v, v, "FLIPKART"));
    const snapshots = [900, 950, 1300].map((price, i) =>
      check(i + 1, i + 1, "FLIPKART", "2026-11-25 06:00:00", price, i === 0 ? { mkt_best_at_price: "800" } : {}));
    snapshots.push(check(1, 1, "FLIPKART", "2026-11-27 06:00:00", 1000));
    const out = overview(listings, snapshots);
    expect(out.series.map((p) => p.date)).toEqual(["2026-11-25", "2026-11-26", "2026-11-27"]);
    expect(out.series[0].listed.FLIPKART).toEqual({ n: 3, median: { pct: -5, abs: -50 }, average: { pct: 5, abs: 50 } });
    expect(out.series[0].best.FLIPKART).toMatchObject({ n: 1, median: { pct: -20 } }); // unknown is not the listed price
    expect(out.series[1].listed.FLIPKART).toMatchObject({ n: 0, median: { pct: null } });
  });

  test("shows the best selling size and ranks products by units", () => {
    const listings = [
      listing(1, 1, "AMAZON", { product_id: 1, shopify_product_id: 10, size_value: "30" }),
      listing(2, 2, "AMAZON", { product_id: 1, shopify_product_id: 10 }),
      listing(3, 3, "AMAZON"),
    ];
    const units = [
      { product_id: 10, variant_id: 200, units: "5" },
      { product_id: 10, variant_id: 100, units: "1" },
      { product_id: 30, variant_id: 300, units: "50" },
      { product_id: 999, variant_id: 9, units: "20" },
    ];
    const out = overview(listings, [], units);
    expect(out.products.map((p) => [p.variantId, p.rank])).toEqual([[3, 1], [2, 3]]);
    expect(out.products[1].sizes.map((s) => s.label)).toEqual(["100ML", "30ML"]);
  });

  test("only https links are returned", () => {
    const out = overview([listing(1, 1, "AMAZON", { canonical_url: "javascript:alert(1)" })], []);
    expect(out.products[0].cells.AMAZON).toEqual({ state: "unread", url: null });
  });
});

describe("product", () => {
  test("daily series with our price, gaps for missing days, current rows", () => {
    const out = buildProduct({
      listings: [listing(1, 1, "AMAZON"), listing(2, 1, "BLINKIT")],
      snapshots: [
        check(1, 1, "AMAZON", "2026-11-25 06:00:00", 900),
        check(2, 1, "BLINKIT", "2026-11-27 06:00:00", 1100, { brand_sp: "950.00", availability: "UNKNOWN" }),
      ],
      names: NAMES,
      spec: { ...SPEC, variantId: 1 },
    });
    expect(out.series.map((p) => [p.date, p.ours])).toEqual([["2026-11-25", 1000], ["2026-11-26", null], ["2026-11-27", 950]]);
    expect(out.series[1].marketplaces.AMAZON).toBeNull();
    expect(out.current.map((c) => [c.code, c.state, c.stock, c.stale])).toEqual([
      ["AMAZON", "ok", "in", true], ["BLINKIT", "ok", "unknown", false],
    ]);
    expect(buildProduct({ listings: [], snapshots: [], names: NAMES, spec: { ...SPEC, variantId: 1 } })).toBeNull();
  });
});

describe("service", () => {
  const spec = { start: null, end: "2026-11-28", pincode: "999999", timezone: "Asia/Kolkata" };

  test("a brand without scraper tables is not set up; other errors surface", async () => {
    const missing = Object.assign(new Error("Table 'x.mm_marketplaces' doesn't exist"), { code: "ER_NO_SUCH_TABLE" });
    const service = buildMarketplaceHistoryService();
    await expect(service.getOverview({ conn: { query: async () => { throw missing; } }, ...spec })).resolves.toEqual({ available: false });
    await expect(service.getOverview({ conn: { query: async () => { throw new Error("boom"); } }, ...spec })).rejects.toThrow("boom");
  });

  test("queries are parameterised and an unknown pincode falls back to a real one", async () => {
    const conn = {
      query: jest.fn(async (sql) => {
        if (sql.includes("DISTINCT pincode")) return [{ pincode: "110092" }];
        if (sql.includes("daily_inventory_summary")) {
          throw Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE" });
        }
        return [];
      }),
    };
    const out = await buildMarketplaceHistoryService().getOverview({ conn, ...spec });
    expect(out).toMatchObject({ available: true, pincode: "110092", products: [], series: [] });
    const [sql, options] = conn.query.mock.calls.find(([s]) => s.includes("FROM mm_price_snapshots s"));
    expect(sql).not.toContain("2026-11");
    expect(options.replacements).toEqual(["2026-11-30", "110092"]);
  });
});
