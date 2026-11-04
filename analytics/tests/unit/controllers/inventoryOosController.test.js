/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { buildProductConversionController } = require("../../../modules/product-conversion/controller");

function run(req) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return buildProductConversionController()
    .oosTrend(req, res)
    .then(() => res);
}

const rows = [
  { id: 1, product_id: "100", variant_id: "1001", oos_at: "2026-11-03 10:16:00", back_at: "2026-11-04 04:25:00", start_quantity: 0, recovery_quantity: 9137 },
];
const sequelize = { query: jest.fn(async (sql) => (/COUNT\(\*\)/.test(sql) ? [{ n: 0 }] : rows)) };
const request = (query, extra = {}) => ({
  query,
  brandKey: "TMC",
  tenantRoute: { timezone: "Asia/Kolkata" },
  brandDb: { sequelize },
  ...extra,
});

describe("GET /product-conversion/oos-trend", () => {
  test("validation errors are 400 and never reach the database", async () => {
    sequelize.query.mockClear();
    const res = await run(request({ start: "2026-11-01", end: "2026-11-30", granularity: "hourly" }));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Hourly view is limited to 7 days/);
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test("answers with buckets and a summary from the brand database", async () => {
    const res = await run(request({ start: "2026-11-03", end: "2026-11-04", granularity: "daily" }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ available: true, granularity: "daily", timezone: "Asia/Kolkata" });
    expect(res.body.buckets).toHaveLength(2);
    expect(res.body.summary.units_restocked).toBe(9137);
  });

  test("500 when the brand database connection is missing", async () => {
    const res = await run(request({ start: "2026-11-03", end: "2026-11-04" }, { brandDb: undefined }));
    expect(res.statusCode).toBe(500);
  });
});
