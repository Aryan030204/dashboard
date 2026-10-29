/* eslint-env jest */

// Verifies the /intent-funnel route is wired behind the gateway identity edge
// and the intent_funnel_panel permission, and that brand/tenant resolution runs
// only after authorization.

const mockHandler = jest.fn((req, res) => res.json({ ok: true, brandKey: req.brandKey }));
const mockBrandContext = jest.fn((req, _res, next) => {
  req.brandDb = { sequelize: {} };
  req.brandKey = req.user?.brandKey;
  next();
});

jest.mock("../../../modules/metrics/intentFunnelController", () => ({
  // every intent-funnel route is registered at router build time, so every handler must exist
  buildIntentFunnelController: jest.fn(() => ({
    getIntentFunnel: mockHandler,
    getSourceOverlap: mockHandler,
    getIntentReport: mockHandler,
    getPaths: mockHandler,
    getPathProducts: mockHandler,
  })),
}));

jest.mock("../../../shared/middleware/brandContext", () => ({
  brandContext: (...args) => mockBrandContext(...args),
  authorizeBrandContext: (...args) => mockBrandContext(...args),
}));

jest.mock("../../../shared/db/redis", () => null);

jest.mock("../../../shared/middleware/apiKeyAuth", () => ({
  createApiKeyAuthMiddleware: jest.fn(() => (_req, _res, next) => next()),
}));

jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

function invoke(router, { url, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = {
      method: "GET",
      url,
      originalUrl: url,
      headers,
      query: { start: "2026-10-10", end: "2026-10-12" },
      body: {},
      get(name) {
        return this.headers[String(name).toLowerCase()];
      },
    };
    const res = {
      statusCode: 200,
      body: null,
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value;
      },
      on() {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        resolve(this);
        return this;
      },
      send(payload) {
        this.body = payload;
        resolve(this);
        return this;
      },
      end() {
        resolve(this);
        return this;
      },
    };
    router.handle(req, res, (err) => (err ? reject(err) : resolve(res)));
  });
}

describe("GET /metrics/intent-funnel identity edge", () => {
  let router;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATEWAY_SHARED_SECRET;
    jest.isolateModules(() => {
      const { buildMetricsRouter } = require("../../../modules/metrics");
      router = buildMetricsRouter({});
    });
  });

  const base = { "x-user-id": "u1", "x-brand-id": "BBB", "x-role": "viewer" };

  test("rejects requests without gateway identity headers (401)", async () => {
    const res = await invoke(router, { url: "/intent-funnel", headers: {} });
    expect(res.statusCode).toBe(401);
    expect(mockHandler).not.toHaveBeenCalled();
    expect(mockBrandContext).not.toHaveBeenCalled();
  });

  test("rejects viewers without intent_funnel_panel (403) before resolving the brand", async () => {
    const res = await invoke(router, {
      url: "/intent-funnel",
      headers: { ...base, "x-permissions": "daily_funnel_panel,bundles_panel" },
    });
    expect(res.statusCode).toBe(403);
    expect(mockHandler).not.toHaveBeenCalled();
    expect(mockBrandContext).not.toHaveBeenCalled();
  });

  test("allows viewers granted intent_funnel_panel", async () => {
    const res = await invoke(router, {
      url: "/intent-funnel",
      headers: { ...base, "x-permissions": "intent_funnel_panel" },
    });
    expect(res.statusCode).toBe(200);
    expect(mockBrandContext).toHaveBeenCalledTimes(1);
    expect(mockHandler).toHaveBeenCalledTimes(1);
  });

  test("allows the 'all' permission", async () => {
    const res = await invoke(router, {
      url: "/intent-funnel",
      headers: { ...base, "x-permissions": "all" },
    });
    expect(res.statusCode).toBe(200);
  });

  test("allows authors without an explicit permission", async () => {
    const res = await invoke(router, {
      url: "/intent-funnel",
      headers: { ...base, "x-role": "author" },
    });
    expect(res.statusCode).toBe(200);
    expect(mockHandler).toHaveBeenCalledTimes(1);
  });
});
