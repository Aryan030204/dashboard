/* eslint-env jest */

jest.mock("../../../shared/db/redis", () => ({
  get: jest.fn(),
  scan: jest.fn(),
  mget: jest.fn(),
}));

const {
  buildProductConversionService,
} = require("../../../services/productConversionService");
const redisClient = require("../../../shared/db/redis");

describe("productConversionService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test("returns paginated rows with compare data and product-type parity", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-03-31T06:30:00Z"));

    const conn = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes("FROM product_landing_mapping m")) {
          return Promise.resolve([
            {
              product_id: "sku-1",
              landing_page_path: "/products/a",
              sessions: 100,
              atc: 25,
              atc_rate: 25,
              ci_events: 14,
              checkout_rate: 14,
              orders: 8,
              sales: 640,
              cvr: 8,
              prev_sessions: 80,
              prev_atc: 16,
              prev_atc_rate: 20,
              prev_ci_events: 9,
              prev_checkout_rate: 11.25,
              prev_orders: 6,
              prev_sales: 480,
              prev_cvr: 7.5,
              total_count: 1,
            },
          ]);
        }
        return Promise.resolve([]);
      }),
    };

    const service = buildProductConversionService();
    const normalized = service.normalizeProductConversionRequest({
      start: "2026-03-31",
      end: "2026-03-31",
      page: "1",
      page_size: "5",
      sort_by: "sales",
      sort_dir: "asc",
      compare_start: "2026-03-30",
      compare_end: "2026-03-30",
      search: "/products",
      product_types: JSON.stringify(["Bundle"]),
      page_types: JSON.stringify(["Product"]),
      filters: JSON.stringify([{ field: "sales", operator: "gt", value: 100 }]),
    });

    expect(normalized.ok).toBe(true);
    const response = await service.getProductConversion({
      ...normalized.spec,
      conn,
    });

    expect(conn.query.mock.calls[0][0]).toContain("COUNT(*) OVER() AS total_count");
    expect(conn.query.mock.calls[0][0]).toContain("FROM product_landing_mapping m");
    expect(conn.query.mock.calls[0][0]).toContain("m.product_type IN (?)");
    expect(conn.query.mock.calls[0][0]).toContain("LIMIT 5 OFFSET 0");
    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(response.total_count).toBe(1);
    expect(response.rows[0]).toEqual(expect.objectContaining({
      product_id: "sku-1",
      landing_page_path: "/products/a",
      sessions: 100,
      atc: 25,
      atc_rate: 25,
      ci_events: 14,
      checkout_rate: 14,
      orders: 8,
      sales: 640,
      cvr: 8,
      previous: {
        sessions: 80,
        atc: 16,
        atc_rate: 20,
        ci_events: 9,
        checkout_rate: 11.25,
        orders: 6,
        sales: 480,
        cvr: 7.5,
      },
    }));
  });

  test("builds csv output with compare columns and visible-column parity", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-03-31T06:30:00Z"));

    const conn = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes("FROM sessions_60d s") && sql.includes("ORDER BY sessions DESC")) {
          return Promise.resolve([
            {
              product_id: "sku-1",
              landing_page_path: "/products/a",
              sessions: 100,
              atc: 25,
              atc_rate: 25,
              ci_events: 14,
              checkout_rate: 14,
              orders: 8,
              sales: 640,
              cvr: 8,
              prev_sessions: 80,
              prev_atc: 16,
              prev_atc_rate: 20,
              prev_ci_events: 9,
              prev_checkout_rate: 11.25,
              prev_orders: 6,
              prev_sales: 480,
              prev_cvr: 7.5,
            },
          ]);
        }
        return Promise.resolve([]);
      }),
    };

    const service = buildProductConversionService();
    const normalized = service.normalizeProductConversionRequest({
      start: "2026-03-31",
      end: "2026-03-31",
      compare_start: "2026-03-30",
      compare_end: "2026-03-30",
      visible_columns: JSON.stringify(["sessions", "ci_events", "checkout_rate", "cvr"]),
    });

    const response = await service.getProductConversionCsv({
      ...normalized.spec,
      conn,
    });

    expect(response.filename).toBe("product_conversion_2026-03-31.csv");
    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(response.headers).toEqual([
      "landing_page_path",
      "sessions",
      "ci_events",
      "checkout_rate",
      "cvr",
      "prev_sessions",
      "prev_ci_events",
      "prev_checkout_rate",
      "prev_cvr",
    ]);
    expect(response.csv).toContain(
      "landing_page_path,sessions,ci_events,checkout_rate,cvr,prev_sessions,prev_ci_events,prev_checkout_rate,prev_cvr",
    );
    expect(response.csv).toContain("/products/a,100,14,14,8,80,9,11.25,7.5");
  });

  test("uses completed-hour cutoff symmetrically for compare mode when current range includes today", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-04-03T05:20:00Z"));

    const calls = [];
    const conn = {
      query: jest.fn().mockImplementation((sql, options = {}) => {
        calls.push({ sql, replacements: options.replacements || [] });
        return Promise.resolve([]);
      }),
    };

    const service = buildProductConversionService();
    const normalized = service.normalizeProductConversionRequest({
      start: "2026-04-03",
      end: "2026-04-03",
      compare_start: "2026-04-02",
      compare_end: "2026-04-02",
    });

    await service.getProductConversion({
      ...normalized.spec,
      conn,
    });

    expect(calls[0].sql).toContain("COUNT(*) OVER() AS total_count");
    expect(calls[0].sql).toContain("FROM hourly_product_sessions");
    expect(calls[0].sql).toContain("AND (created_date < ? OR created_time < ?)");
    expect(calls[0].sql).toContain("AND (date < ? OR hour <= ?)");
    expect(calls[0].sql).toContain("LIMIT 10 OFFSET 0");
    expect(calls).toHaveLength(1);
    expect(calls[0].replacements).toEqual(
      expect.arrayContaining([
        "2026-04-03",
        "2026-04-03",
        "10:00:00",
        9,
        "2026-04-02",
        "2026-04-02",
        "10:00:00",
        9,
      ]),
    );
    expect(calls[0].replacements).not.toContain("10:50:00");
  });

  test("falls back to the daily rollup for a compare range outside hourly retention, even when current range includes today", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-28T05:20:00Z"));

    const calls = [];
    const conn = {
      query: jest.fn().mockImplementation((sql, options = {}) => {
        calls.push({ sql, replacements: options.replacements || [] });
        return Promise.resolve([]);
      }),
    };

    const service = buildProductConversionService();
    const normalized = service.normalizeProductConversionRequest({
      start: "2026-09-22",
      end: "2026-09-28",
      compare_start: "2026-09-01",
      compare_end: "2026-09-10",
    });

    await service.getProductConversion({
      ...normalized.spec,
      conn,
    });

    const sql = calls[0].sql;
    // Current period (includes today) still reads the hot hourly table.
    const sessionsCteSql = sql.slice(sql.indexOf("sessions_60d AS"), sql.indexOf("previous_orders AS"));
    expect(sessionsCteSql).toContain("FROM hourly_product_sessions");

    // Compare period is well outside the retention window (rows there are
    // purged/archived), so it must read the full-history daily rollup instead
    // of silently returning zero rows from the hourly table.
    const previousSessionsCteSql = sql.slice(sql.indexOf("previous_sessions AS"));
    expect(previousSessionsCteSql).toContain("FROM mv_product_sessions_by_path_daily");
    expect(previousSessionsCteSql).not.toContain("hourly_product_sessions");
    expect(previousSessionsCteSql).not.toContain("AND (date < ? OR hour <= ?)");

    expect(calls[0].replacements).toEqual(
      expect.arrayContaining(["2026-09-01", "2026-09-10"]),
    );
  });

  test("keeps full post-processing path for inventory-derived sorting and filtering", async () => {
    const conn = {
      query: jest.fn().mockResolvedValue([
        {
          product_id: "sku-1",
          landing_page_path: "/products/a",
          sessions: 100,
          atc: 25,
          atc_rate: 25,
          ci_events: 14,
          checkout_rate: 14,
          orders: 8,
          sales: 640,
          cvr: 8,
          drr: null,
          doh: null,
        },
      ]),
    };

    const service = buildProductConversionService();
    const normalized = service.normalizeProductConversionRequest({
      start: "2026-03-31",
      end: "2026-03-31",
      sort_by: "drr",
      filters: JSON.stringify([{ field: "doh", operator: "gt", value: 5 }]),
    });

    const response = await service.getProductConversion({
      ...normalized.spec,
      conn,
    });

    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(conn.query.mock.calls[0][0]).not.toContain("COUNT(*) AS total_count");
    expect(response).toEqual(
      expect.objectContaining({
        total_count: 0,
        rows: [],
      }),
    );
  });

  test("inventory_only reads the new single-key inventory_cache shop payload and sums DOH from grouped SKUs", async () => {
    redisClient.scan.mockResolvedValue(["0", []]);
    redisClient.get.mockImplementation((key) => {
      if (key === "Inventory_cache:ajmal-perfumes-india") {
        return Promise.resolve(
          JSON.stringify({
            shop: "ajmal-perfumes-india",
            cached_at: "2026-08-18T08:48:42Z",
            row_count: 2,
            items: [
              {
                product_id: 8271489106090,
                product_title: "Aristocrat Perfume 14 ML for Men",
                variant_id: 47530002055338,
                sku: "ARISTOCRAT_EDP_14ML",
                inventory_available: 1000,
                drr_7d: 20,
                doh_7d: 50,
                updated_at: "2026-08-18 08:48:41",
              },
              {
                product_id: 7987757023402,
                product_title: "ARISTOCRAT",
                variant_id: 48165674647722,
                sku: "ARISTOCRAT_EDP_14ML",
                inventory_available: 500,
                drr_7d: 5,
                doh_7d: 100,
                updated_at: "2026-08-18 08:46:41",
              },
            ],
          }),
        );
      }
      return Promise.resolve(null);
    });

    const service = buildProductConversionService();
    const normalized = service.normalizeProductConversionRequest({
      start: "2026-08-18",
      end: "2026-08-18",
      inventory_period: "7d",
      inventory_only: "true",
    });

    const response = await service.getProductConversion({
      ...normalized.spec,
      resolveShopSubdomain: () => "ajmal-perfumes-india",
    });

    expect(redisClient.get).toHaveBeenCalledWith("Inventory_cache:ajmal-perfumes-india");
    expect(response.rows).toHaveLength(1);
    const [row] = response.rows;
    expect(row.sku).toBe("ARISTOCRAT_EDP_14ML");
    // Grouped by SKU: drr summed (20 + 5 = 25), inventory summed (1000 + 500 = 1500),
    // DOH derived from the summed values (1500 / 25 = 60) rather than either item's own doh_7d.
    expect(row.drr).toBe(25);
    expect(row.doh).toBe(60);
  });

  test("non-inventory-only path merges drr_/doh_ fields directly from the new cache shape", async () => {
    redisClient.get.mockImplementation((key) => {
      if (key === "Inventory_cache:ajmal-perfumes-india") {
        return Promise.resolve(
          JSON.stringify({
            shop: "ajmal-perfumes-india",
            cached_at: "2026-08-18T08:48:42Z",
            row_count: 1,
            items: [
              {
                product_id: 8271489106090,
                variant_id: 47530002055338,
                sku: "ARISTOCRAT_EDP_14ML",
                drr_7d: 20,
                doh_7d: 50,
                updated_at: "2026-08-18 08:48:41",
              },
            ],
          }),
        );
      }
      return Promise.resolve(null);
    });

    const conn = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes("COUNT(*) AS total_count")) {
          return Promise.resolve([{ total_count: 1 }]);
        }
        if (sql.includes("FROM sessions_60d s")) {
          return Promise.resolve([
            {
              product_id: "8271489106090",
              landing_page_path: "/products/aristocrat",
              sessions: 100,
              atc: 25,
              atc_rate: 25,
              ci_events: 14,
              checkout_rate: 14,
              orders: 8,
              sales: 640,
              cvr: 8,
              drr: null,
              doh: null,
            },
          ]);
        }
        return Promise.resolve([]);
      }),
    };

    const service = buildProductConversionService();
    const normalized = service.normalizeProductConversionRequest({
      start: "2026-08-18",
      end: "2026-08-18",
      inventory_period: "7d",
    });

    const response = await service.getProductConversion({
      ...normalized.spec,
      conn,
      resolveShopSubdomain: () => "ajmal-perfumes-india",
    });

    expect(response.rows).toHaveLength(1);
    expect(response.rows[0].drr).toBe(20);
    expect(response.rows[0].doh).toBe(50);
  });
});
