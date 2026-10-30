/* eslint-env jest */

jest.mock("../../../modules/metrics/requestNormalizer", () => ({
  normalizeMetricRequest: jest.fn(),
}));
jest.mock("../../../shared/middleware/handleControllerError", () => ({
  handleControllerError: jest.fn((res) => res.status(500).json({ error: "boom" })),
}));
jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { normalizeMetricRequest } = require("../../../modules/metrics/requestNormalizer");
const { buildHeatmapController } = require("../../../modules/metrics/heatmapController");

function makeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  return res;
}

const OK_SPEC = { conn: { id: "conn" }, brandKey: "BBB", start: "2026-10-22", end: "2026-10-28" };

function setup({ pages, elements } = {}) {
  const heatmapService = {
    getHeatmapPages: jest.fn(pages || (async () => ({ pages: [] }))),
    getHeatmapElements: jest.fn(elements || (async () => ({ elements: [] }))),
  };
  normalizeMetricRequest.mockReturnValue({ ok: true, spec: OK_SPEC });
  return { heatmapService, controller: buildHeatmapController({ heatmapService }) };
}

const query = (extra = {}) => ({ query: { start: "2026-10-22", end: "2026-10-28", ...extra } });

describe("getHeatmapPages", () => {
  test("passes the validated range, device, search and limit to the service", async () => {
    const { controller, heatmapService } = setup();
    const res = makeRes();
    await controller.getHeatmapPages(query({ device: "MOBILE", search: " shop ", limit: "25" }), res);
    expect(heatmapService.getHeatmapPages).toHaveBeenCalledWith({
      conn: OK_SPEC.conn, brandKey: "BBB", start: "2026-10-22", end: "2026-10-28",
      device: "mobile", search: "shop", limit: 25,
    });
    expect(res.statusCode).toBe(200);
  });

  test("defaults to all devices and the service's default limit", async () => {
    const { controller, heatmapService } = setup();
    await controller.getHeatmapPages(query(), makeRes());
    expect(heatmapService.getHeatmapPages).toHaveBeenCalledWith(
      expect.objectContaining({ device: "all", search: "", limit: undefined }),
    );
  });

  test.each([
    [{ start: undefined }, "Both start and end dates are required"],
    [{ end: undefined }, "Both start and end dates are required"],
    [{ device: "phone" }, "Invalid device"],
    [{ limit: "0" }, "limit must be an integer between 1 and 200"],
    [{ limit: "999" }, "limit must be an integer between 1 and 200"],
    [{ limit: "1.5" }, "limit must be an integer between 1 and 200"],
    [{ search: "x".repeat(101) }, "search must be at most 100 characters"],
  ])("rejects %j", async (extra, message) => {
    const { controller, heatmapService } = setup();
    const res = makeRes();
    await controller.getHeatmapPages(query(extra), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: message });
    expect(heatmapService.getHeatmapPages).not.toHaveBeenCalled();
  });

  test("rejects a range longer than a year", async () => {
    const { controller } = setup();
    normalizeMetricRequest.mockReturnValue({ ok: true, spec: { ...OK_SPEC, start: "2025-01-01", end: "2026-10-28" } });
    const res = makeRes();
    await controller.getHeatmapPages(query({ start: "2025-01-01" }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/cannot exceed 366 days/);
  });

  test("answers 500 when there is no brand connection, and passes normaliser errors through", async () => {
    const { controller } = setup();
    normalizeMetricRequest.mockReturnValue({ ok: true, spec: { ...OK_SPEC, conn: null } });
    const noConn = makeRes();
    await controller.getHeatmapPages(query(), noConn);
    expect(noConn.statusCode).toBe(500);

    normalizeMetricRequest.mockReturnValue({ ok: false, status: 403, body: { error: "Forbidden" } });
    const denied = makeRes();
    await controller.getHeatmapPages(query(), denied);
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toEqual({ error: "Forbidden" });
  });

  test("a query timeout is a 504 with a useful message", async () => {
    const timeout = Object.assign(new Error("t"), { code: "ER_QUERY_TIMEOUT", errno: 3024 });
    const { controller } = setup({ pages: async () => { throw timeout; } });
    const res = makeRes();
    await controller.getHeatmapPages(query(), res);
    expect(res.statusCode).toBe(504);
    expect(res.body.error).toMatch(/shorter date range/);
  });
});

describe("getHeatmapElements", () => {
  test("normalises a full URL to the page path the rollups use", async () => {
    const { controller, heatmapService } = setup();
    const res = makeRes();
    await controller.getHeatmapElements(
      query({ path: "https://blabliblulife.com/Products/Build-Your-Own-Box/?utm_source=facebook#x" }),
      res,
    );
    expect(heatmapService.getHeatmapElements).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/products/build-your-own-box", brandKey: "BBB" }),
    );
    expect(res.statusCode).toBe(200);
  });

  test("the home page is '/'", async () => {
    const { controller, heatmapService } = setup();
    await controller.getHeatmapElements(query({ path: "/" }), makeRes());
    expect(heatmapService.getHeatmapElements).toHaveBeenCalledWith(expect.objectContaining({ path: "/" }));
  });

  test.each([
    [{ path: undefined }, "A valid page path is required"],
    [{ path: "   " }, "A valid page path is required"],
    [{ path: `/${"a".repeat(300)}` }, "A valid page path is required"],
    [{ path: "/", limit: "51" }, "limit must be an integer between 1 and 50"],
    [{ path: "/", limit: "-1" }, "limit must be an integer between 1 and 50"],
  ])("rejects %j", async (extra, message) => {
    const { controller, heatmapService } = setup();
    const res = makeRes();
    await controller.getHeatmapElements(query(extra), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: message });
    expect(heatmapService.getHeatmapElements).not.toHaveBeenCalled();
  });

  test("a query timeout is a 504, other failures go to the shared error handler", async () => {
    const timeout = Object.assign(new Error("t"), { code: "ER_QUERY_TIMEOUT", errno: 3024 });
    const slow = setup({ elements: async () => { throw timeout; } });
    const res = makeRes();
    await slow.controller.getHeatmapElements(query({ path: "/" }), res);
    expect(res.statusCode).toBe(504);

    const broken = setup({ elements: async () => { throw new Error("db down"); } });
    const res2 = makeRes();
    await broken.controller.getHeatmapElements(query({ path: "/" }), res2);
    expect(res2.statusCode).toBe(500);
  });
});
