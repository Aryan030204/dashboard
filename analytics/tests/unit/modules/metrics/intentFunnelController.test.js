/* eslint-env jest */

jest.mock("../../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { buildIntentFunnelController } = require("../../../../modules/metrics/intentFunnelController");

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function createReq(query = {}, overrides = {}) {
  return {
    query: { start: "2026-10-10", end: "2026-10-12", ...query },
    brandKey: "BBB",
    brandDb: { sequelize: { query: jest.fn() } },
    tenantRoute: { timezone: "Asia/Kolkata" },
    ...overrides,
  };
}

describe("intentFunnelController", () => {
  let service;
  let controller;

  beforeEach(() => {
    service = { getIntentFunnel: jest.fn().mockResolvedValue({ ok: true }) };
    controller = buildIntentFunnelController({ intentFunnelService: service });
  });

  test("passes the resolved brand connection and validated params to the service", async () => {
    const req = createReq({ sort: "add_to_cart", path_start: "product_viewed", path_top: "4", intent: "high" });
    const res = createRes();
    await controller.getIntentFunnel(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(service.getIntentFunnel).toHaveBeenCalledWith({
      conn: req.brandDb.sequelize,
      brandKey: "BBB",
      start: "2026-10-10",
      end: "2026-10-12",
      timezone: "Asia/Kolkata",
      intent: "high",
      sort: "add_to_cart",
      pathStart: "product_viewed",
      pathTop: 4,
    });
  });

  test("defaults are applied when optional params are absent", async () => {
    const res = createRes();
    await controller.getIntentFunnel(createReq(), res);
    expect(service.getIntentFunnel).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "all", sort: "views", pathStart: "page_viewed", pathTop: 5 }),
    );
  });

  test("an invalid date is rejected before any query runs", async () => {
    const res = createRes();
    await controller.getIntentFunnel(createReq({ start: "not-a-date" }), res);
    expect(res.statusCode).toBe(400);
    expect(service.getIntentFunnel).not.toHaveBeenCalled();
  });

  test.each([
    ["only start", { end: undefined }],
    ["only end", { start: undefined }],
    ["empty end", { end: "" }],
  ])("both dates are required: %s is rejected, not treated as a single day", async (_label, query) => {
    const res = createRes();
    await controller.getIntentFunnel(createReq(query), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Both start and end dates are required" });
    expect(service.getIntentFunnel).not.toHaveBeenCalled();
  });

  test("start after end is rejected", async () => {
    const res = createRes();
    await controller.getIntentFunnel(createReq({ start: "2026-10-12", end: "2026-10-10" }), res);
    expect(res.statusCode).toBe(400);
  });

  test("missing dates are rejected", async () => {
    const res = createRes();
    await controller.getIntentFunnel(createReq({ start: undefined, end: undefined }), res);
    expect(res.statusCode).toBe(400);
    expect(service.getIntentFunnel).not.toHaveBeenCalled();
  });

  test("ranges longer than a year are rejected", async () => {
    const res = createRes();
    await controller.getIntentFunnel(createReq({ start: "2024-01-01", end: "2026-10-12" }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/cannot exceed/);
  });

  test.each([
    [{ sort: "revenue" }, "Invalid sort"],
    [{ sort: "views; DROP TABLE x" }, "Invalid sort"],
    [{ sort: "constructor" }, "Invalid sort"],
    [{ intent: "extreme" }, "Invalid intent"],
    [{ path_start: "collection_viewed" }, "Invalid path_start"],
    [{ path_top: "2" }, /path_top/],
    [{ path_top: "9" }, /path_top/],
    [{ path_top: "abc" }, /path_top/],
  ])("invalid params %j are rejected before any query runs", async (query, message) => {
    const res = createRes();
    await controller.getIntentFunnel(createReq(query), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toEqual(typeof message === "string" ? message : expect.stringMatching(message));
    expect(service.getIntentFunnel).not.toHaveBeenCalled();
  });

  test("returns 500 when the brand connection is missing", async () => {
    const res = createRes();
    await controller.getIntentFunnel(createReq({}, { brandDb: undefined }), res);
    expect(res.statusCode).toBe(500);
    expect(service.getIntentFunnel).not.toHaveBeenCalled();
  });

  test("a query timeout answers 504 with a hint to shorten the range, without internals", async () => {
    service.getIntentFunnel.mockRejectedValue(
      Object.assign(new Error("Query execution was interrupted, maximum statement execution time exceeded"), {
        code: "ER_QUERY_TIMEOUT",
        errno: 3024,
      }),
    );
    const res = createRes();
    await controller.getIntentFunnel(createReq(), res);
    expect(res.statusCode).toBe(504);
    expect(res.body).toEqual({ error: "Intent data took too long. Try a shorter date range." });
    expect(JSON.stringify(res.body)).not.toMatch(/statement|interrupted/i);
  });

  test("database failures return a generic error without SQL or internals", async () => {
    service.getIntentFunnel.mockRejectedValue(
      new Error("ER_PARSE_ERROR near 'SELECT secret' at line 1 (password=hunter2)"),
    );
    const res = createRes();
    await controller.getIntentFunnel(createReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "intent-funnel failed" });
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|password|hunter2/);
  });
});
