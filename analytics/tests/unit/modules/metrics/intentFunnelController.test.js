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
      pathSteps: 5,
      skipPaths: false,
    });
  });

  test("skip_paths leaves the path data out of the page payload", async () => {
    const res = createRes();
    await controller.getIntentFunnel(createReq({ skip_paths: "1" }), res);
    expect(service.getIntentFunnel).toHaveBeenCalledWith(expect.objectContaining({ skipPaths: true }));
  });

  test("defaults are applied when optional params are absent", async () => {
    const res = createRes();
    await controller.getIntentFunnel(createReq(), res);
    expect(service.getIntentFunnel).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "all", sort: "views", pathStart: "page_viewed", pathTop: 5 }),
    );
  });

  test("path_steps is validated and passed on; out of range is rejected", async () => {
    const ok = createRes();
    await controller.getIntentFunnel(createReq({ path_steps: "7" }), ok);
    expect(service.getIntentFunnel).toHaveBeenCalledWith(expect.objectContaining({ pathSteps: 7 }));

    for (const bad of ["2", "9", "x", "5.5"]) {
      const res = createRes();
      await controller.getIntentFunnel(createReq({ path_steps: bad }), res);
      expect(res.statusCode).toBe(400);
    }
  });

  describe("live paths and path products", () => {
    let live;
    beforeEach(() => {
      service = {
        getPaths: jest.fn().mockResolvedValue({ paths: {} }),
        getPathProducts: jest.fn().mockResolvedValue({ products: [] }),
      };
      live = buildIntentFunnelController({
        intentFunnelService: service,
        readTopProductsCache: jest.fn(),
      });
    });

    test("getPaths validates and forwards every filter", async () => {
      const req = createReq({
        intent: "High",
        basis: "score",
        path_start: "click",
        steps: "6",
        product_id: "10261835809063",
      });
      const res = createRes();
      await live.getPaths(req, res);

      expect(res.statusCode).toBe(200);
      expect(service.getPaths).toHaveBeenCalledWith({
        conn: req.brandDb.sequelize,
        brandKey: "BBB",
        start: "2026-10-10",
        end: "2026-10-12",
        intent: "high",
        basis: "score",
        pathStart: "click",
        steps: 6,
        productId: "10261835809063",
      });
    });

    test("getPaths defaults: all intents, behaviour basis, 5 steps, no product", async () => {
      await live.getPaths(createReq(), createRes());
      expect(service.getPaths).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: "all",
          basis: "behavior",
          pathStart: "page_viewed",
          steps: 5,
          productId: null,
        }),
      );
    });

    test.each([
      [{ intent: "extreme" }],
      [{ basis: "x" }],
      [{ path_start: "scroll" }],
      [{ steps: "2" }],
      [{ steps: "9" }],
      [{ product_id: "1; DROP TABLE x" }],
      [{ product_id: "abc" }],
    ])("getPaths rejects %j with 400 before querying", async (query) => {
      const res = createRes();
      await live.getPaths(createReq(query), res);
      expect(res.statusCode).toBe(400);
      expect(service.getPaths).not.toHaveBeenCalled();
    });

    test("getPaths answers 504 on a query timeout and 500 without internals otherwise", async () => {
      service.getPaths.mockRejectedValueOnce(Object.assign(new Error("t"), { code: "ER_QUERY_TIMEOUT" }));
      const timeout = createRes();
      await live.getPaths(createReq(), timeout);
      expect(timeout.statusCode).toBe(504);

      service.getPaths.mockRejectedValueOnce(new Error("secret SELECT * FROM x"));
      const failed = createRes();
      await live.getPaths(createReq(), failed);
      expect(failed.statusCode).toBe(500);
      expect(JSON.stringify(failed.body)).not.toMatch(/SELECT/);
    });

    test("getPathProducts hands the Redis reader to the service", async () => {
      const req = createReq();
      const res = createRes();
      await live.getPathProducts(req, res);

      expect(res.statusCode).toBe(200);
      const [spec, deps] = service.getPathProducts.mock.calls[0];
      expect(spec).toMatchObject({ brandKey: "BBB", start: "2026-10-10", end: "2026-10-12" });
      expect(typeof deps.readTopProductsCache).toBe("function");
    });

    test("both endpoints need the dates and a brand connection", async () => {
      const noDates = createRes();
      await live.getPaths({ ...createReq(), query: {} }, noDates);
      expect(noDates.statusCode).toBe(400);

      const noConn = createRes();
      await live.getPathProducts(createReq({}, { brandDb: { sequelize: null } }), noConn);
      expect(noConn.statusCode).toBe(500);
    });
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
