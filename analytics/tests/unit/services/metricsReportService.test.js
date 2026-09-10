/* eslint-env jest */

const {
  buildMetricsReportService,
} = require("../../../services/metricsReportService");

describe("metricsReportService", () => {
  test("builds hourly sales compare from contiguous date-range fetches", async () => {
    const conn = {
      query: jest.fn().mockImplementation((sql, options = {}) => {
        const [start, end] = options.replacements || [];
        if (start === "2026-03-30" && end === "2026-03-31") {
          return Promise.resolve([
            { date: "2026-03-31", hour: 0, total_sales: 10 },
            { date: "2026-03-31", hour: 12, total_sales: 25 },
            { date: "2026-03-30", hour: 23, total_sales: 40 },
          ]);
        }
        if (start === "2026-03-29" && end === "2026-03-30") {
          return Promise.resolve([
            { date: "2026-03-30", hour: 0, total_sales: 7 },
            { date: "2026-03-30", hour: 12, total_sales: 15 },
            { date: "2026-03-29", hour: 23, total_sales: 20 },
          ]);
        }
        return Promise.resolve([]);
      }),
    };

    const service = buildMetricsReportService();
    const response = await service.getHourlySalesCompare({
      conn,
      days: 2,
      now: new Date("2026-03-31T06:30:00Z"),
      timezone: "Asia/Kolkata",
    });

    expect(conn.query).toHaveBeenCalledTimes(2);
    expect(response.timezone).toBe("Asia/Kolkata");
    expect(response.tz).toBe("Asia/Kolkata");
    expect(response.labels).toHaveLength(37);
    expect(response.series.current[0]).toBe(10);
    expect(response.series.current[12]).toBe(25);
    expect(response.series.current[36]).toBe(40);
    expect(response.series.yesterday[0]).toBe(7);
    expect(response.series.yesterday[12]).toBe(15);
    expect(response.series.yesterday[36]).toBe(20);
  });

  test("builds hourly buckets in non-IST store timezone", async () => {
    const conn = {
      query: jest.fn().mockImplementation((sql, options = {}) => {
        const [start, end] = options.replacements || [];
        if (start === "2026-03-31" && end === "2026-03-31") {
          return Promise.resolve([{ date: "2026-03-31", hour: 10, total_sales: 25 }]);
        }
        if (start === "2026-03-30" && end === "2026-03-30") {
          return Promise.resolve([{ date: "2026-03-30", hour: 10, total_sales: 15 }]);
        }
        return Promise.resolve([]);
      }),
    };

    const service = buildMetricsReportService();
    const response = await service.getHourlySalesCompare({
      conn,
      days: 1,
      now: new Date("2026-03-31T07:30:00Z"),
      timezone: "Asia/Riyadh",
    });

    expect(response.timezone).toBe("Asia/Riyadh");
    expect(response.labels).toHaveLength(11);
    expect(response.series.current[10]).toBe(25);
    expect(response.series.yesterday[10]).toBe(15);
  });

  test("returns payment sales split with pure filter predicates", async () => {
    const conn = {
      query: jest.fn().mockResolvedValue([
        { payment_type: "COD", sales: 90 },
        { payment_type: "Prepaid", sales: 210 },
      ]),
    };

    const service = buildMetricsReportService();
    const response = await service.getPaymentSalesSplit({
      conn,
      start: "2026-03-01",
      end: "2026-03-02",
      hourLte: 11,
      productId: "sku-1",
      filters: { utm_source: "google" },
      includeSql: true,
    });

    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      metric: "PAYMENT_SPLIT_SALES",
      cod_sales: 90,
      prepaid_sales: 210,
      partial_sales: 0,
      total_sales_from_split: 300,
      cod_percent: 30,
      prepaid_percent: 70,
      partial_percent: 0,
    });
    expect(response.sql_used).toContain("created_date");
    expect(response.sql_used).toContain("utm_source = ?");
    expect(conn.query.mock.calls[0][1].replacements).toEqual([
      "2026-03-01",
      "2026-03-02",
      "sku-1",
      "12:00:00",
      "google",
    ]);
  });

  test("returns UTM-filtered order split from daily aggregate tables", async () => {
    const conn = {
      query: jest.fn().mockResolvedValue([
        {
          cod_orders: 12,
          prepaid_orders: 30,
          partially_paid_orders: 3,
        },
      ]),
    };

    const service = buildMetricsReportService();
    const response = await service.getOrderSplit({
      conn,
      start: "2026-03-01",
      end: "2026-03-02",
      filters: { utm_medium: "cpc", utm_campaign: "launch" },
      includeSql: true,
    });

    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(conn.query.mock.calls[0][0]).toContain("FROM utm_medium_campaign_daily");
    expect(conn.query.mock.calls[0][0]).toContain("SUM(ppcod_orders)");
    expect(conn.query.mock.calls[0][1].replacements).toEqual([
      "2026-03-01",
      "2026-03-02",
      "cpc",
      "launch",
    ]);
    expect(response).toMatchObject({
      cod_orders: 12,
      prepaid_orders: 30,
      partially_paid_orders: 3,
      total_orders_from_split: 45,
    });
  });

  test("returns UTM-filtered order split from hourly aggregate tables when hour_lte is explicit", async () => {
    const conn = {
      query: jest.fn().mockResolvedValue([
        {
          cod_orders: 8,
          prepaid_orders: 20,
          partially_paid_orders: 2,
        },
      ]),
    };

    const service = buildMetricsReportService();
    const response = await service.getOrderSplit({
      conn,
      start: "2026-03-31",
      end: "2026-03-31",
      hourLte: 10,
      filters: { utm_medium: "cpc", utm_campaign: "launch" },
      includeSql: true,
    });

    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(conn.query.mock.calls[0][0]).toContain("FROM utm_medium_campaign_hourly");
    expect(conn.query.mock.calls[0][0]).toContain("metric_hour <= ?");
    expect(conn.query.mock.calls[0][1].replacements).toEqual([
      "2026-03-31",
      "2026-03-31",
      10,
      "cpc",
      "launch",
    ]);
    expect(response).toMatchObject({
      range: { start: "2026-03-31", end: "2026-03-31", hour_lte: 10 },
      total_orders_from_split: 30,
    });
  });

  test("returns discount-filtered order split from discount payment daily table", async () => {
    const conn = {
      query: jest.fn().mockResolvedValue([
        { payment_mode: "cod", value: 5 },
        { payment_mode: "prepaid", value: 9 },
        { payment_mode: "partially_paid", value: 2 },
      ]),
    };

    const service = buildMetricsReportService();
    const response = await service.getOrderSplit({
      conn,
      start: "2026-03-01",
      end: "2026-03-02",
      filters: { discount_code: "SAVE10" },
      includeSql: true,
    });

    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(conn.query.mock.calls[0][0]).toContain("FROM dashboard_discount_payment_daily");
    expect(conn.query.mock.calls[0][1].replacements).toEqual([
      "2026-03-01",
      "2026-03-02",
      "SAVE10",
    ]);
    expect(response).toMatchObject({
      cod_orders: 5,
      prepaid_orders: 9,
      partially_paid_orders: 2,
      total_orders_from_split: 16,
    });
  });

  test("aggregates multiple discount codes with an IN clause", async () => {
    const conn = {
      query: jest.fn().mockResolvedValue([
        { payment_mode: "cod", value: 5 },
        { payment_mode: "prepaid", value: 9 },
      ]),
    };

    const service = buildMetricsReportService();
    await service.getOrderSplit({
      conn,
      start: "2026-03-01",
      end: "2026-03-02",
      filters: { discount_code: ["SAVE10", "SAVE20", "SAVE30"] },
      includeSql: true,
    });

    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(conn.query.mock.calls[0][0]).toContain(
      "discount_code IN (?, ?, ?)",
    );
    expect(conn.query.mock.calls[0][1].replacements).toEqual([
      "2026-03-01",
      "2026-03-02",
      "SAVE10",
      "SAVE20",
      "SAVE30",
    ]);
  });

  test("returns discount-filtered sales split from discount payment hourly table", async () => {
    const conn = {
      query: jest.fn().mockResolvedValue([
        { payment_mode: "cod", value: 500 },
        { payment_mode: "prepaid", value: 1500 },
        { payment_mode: "partially_paid", value: 250 },
      ]),
    };

    const service = buildMetricsReportService();
    const response = await service.getPaymentSalesSplit({
      conn,
      start: "2026-03-31",
      end: "2026-03-31",
      hourLte: 15,
      filters: { discount_code: "SAVE10" },
      includeSql: true,
    });

    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(conn.query.mock.calls[0][0]).toContain("FROM dashboard_discount_payment_hourly");
    expect(conn.query.mock.calls[0][0]).toContain("hour <= ?");
    expect(conn.query.mock.calls[0][1].replacements).toEqual([
      "2026-03-31",
      "2026-03-31",
      15,
      "SAVE10",
    ]);
    expect(response).toMatchObject({
      cod_sales: 500,
      prepaid_sales: 1500,
      partial_sales: 250,
      total_sales_from_split: 2250,
    });
  });

  test("returns order split from a single aggregate summary query when unfiltered", async () => {
    const conn = {
      query: jest.fn().mockResolvedValue([
        {
          cod_orders: 40,
          prepaid_orders: 50,
          partially_paid_orders: 10,
        },
      ]),
    };

    const service = buildMetricsReportService();
    const response = await service.getOrderSplit({
      conn,
      start: "2026-03-01",
      end: "2026-03-02",
    });

    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(conn.query.mock.calls[0][0]).toContain("SUM(cod_orders)");
    expect(response).toMatchObject({
      metric: "ORDER_SPLIT",
      cod_orders: 40,
      prepaid_orders: 50,
      partially_paid_orders: 10,
      total_orders_from_split: 100,
      cod_percent: 40,
      prepaid_percent: 50,
      partially_paid_percent: 10,
    });
  });

  test("returns traffic source split with resolved previous range", async () => {
    const conn = {
      query: jest.fn().mockResolvedValue([
        { date: "2026-03-10", utm_source: "google" },
      ]),
    };

    const service = buildMetricsReportService();
    const response = await service.getTrafficSourceSplit({
      conn,
      start: "2026-03-10",
      end: "2026-03-12",
    });

    expect(response).toEqual({
      rows: [{ date: "2026-03-10", utm_source: "google" }],
      prev_range: { start: "2026-03-07", end: "2026-03-09" },
    });
    expect(conn.query.mock.calls[0][0]).toContain("FROM overall_traffic_split");
    expect(conn.query.mock.calls[0][1].replacements).toEqual([
      "2026-03-10",
      "2026-03-12",
      "2026-03-07",
      "2026-03-09",
    ]);
  });

  test("returns product-scoped traffic source split for a single product", async () => {
    const conn = {
      query: jest.fn().mockResolvedValue([
        { date: "2026-03-10", utm_source: '[{\"utm_name\":\"google\",\"sessions\":5}]' },
      ]),
    };

    const service = buildMetricsReportService();
    const response = await service.getTrafficSourceSplit({
      conn,
      start: "2026-03-10",
      end: "2026-03-12",
      productId: "7987757023402",
    });

    expect(response).toEqual({
      rows: [{ date: "2026-03-10", utm_source: '[{\"utm_name\":\"google\",\"sessions\":5}]' }],
      prev_range: { start: "2026-03-07", end: "2026-03-09" },
    });
    expect(conn.query.mock.calls[0][0]).toContain("FROM product_traffic_split");
    expect(conn.query.mock.calls[0][0]).toContain("WHERE ((date >= ? AND date <= ?) OR (date >= ? AND date <= ?))");
    expect(conn.query.mock.calls[0][0]).toContain("AND product_id = ?");
    expect(conn.query.mock.calls[0][1].replacements).toEqual([
      "2026-03-10",
      "2026-03-12",
      "2026-03-07",
      "2026-03-09",
      "7987757023402",
    ]);
  });

  test("returns product-scoped traffic source split for multiple products", async () => {
    const conn = {
      query: jest.fn().mockResolvedValue([
        { date: "2026-03-10", utm_source: "[]" },
      ]),
    };

    const service = buildMetricsReportService();
    await service.getTrafficSourceSplit({
      conn,
      start: "2026-03-10",
      end: "2026-03-12",
      productId: ["7987757023402", "7987757383850"],
    });

    expect(conn.query.mock.calls[0][0]).toContain("FROM product_traffic_split");
    expect(conn.query.mock.calls[0][0]).toContain("AND product_id IN (?)");
    expect(conn.query.mock.calls[0][1].replacements).toEqual([
      "2026-03-10",
      "2026-03-12",
      "2026-03-07",
      "2026-03-09",
      ["7987757023402", "7987757383850"],
    ]);
  });
});
