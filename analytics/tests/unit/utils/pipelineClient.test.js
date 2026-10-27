jest.mock("axios", () => ({ post: jest.fn() }));
jest.mock("../../../shared/utils/logger", () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const axios = require("axios");
const logger = require("../../../shared/utils/logger");
const { triggerPnlBackfill } = require("../../../shared/utils/pipelineClient");

describe("pipelineClient.triggerPnlBackfill", () => {
  const ENV = { ...process.env };

  beforeEach(() => {
    axios.post.mockReset();
    logger.warn.mockReset();
    logger.info.mockReset();
    logger.error.mockReset();
    process.env.PIPELINE_API_URL = "http://pipeline.internal:5000";
    process.env.PIPELINE_AUTH_HEADER = "secret";
    delete process.env.X_PIPELINE_KEY;
  });

  afterEach(() => {
    process.env = { ...ENV };
  });

  test("posts brand_id + a 30-day range ending yesterday, with the shared key header", async () => {
    axios.post.mockResolvedValue({ data: { state: "started" } });

    const result = await triggerPnlBackfill("bbb");

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = axios.post.mock.calls[0];
    expect(url).toBe("http://pipeline.internal:5000/workers/pnl/trigger");
    expect(body.brand_id).toBe("bbb");
    expect(config.headers).toEqual({ "x-pipeline-key": "secret" });

    const start = new Date(`${body.start}T00:00:00Z`);
    const end = new Date(`${body.end}T00:00:00Z`);
    const diffDays = Math.round((end - start) / 86400000);
    expect(diffDays).toBe(29); // 30 days inclusive

    const today = new Date();
    const expectedEnd = new Date(today);
    expectedEnd.setUTCDate(expectedEnd.getUTCDate() - 1);
    expect(body.end).toBe(expectedEnd.toISOString().slice(0, 10));

    expect(result).toMatchObject({ triggered: true, start: body.start, end: body.end });
  });

  test("falls back to X_PIPELINE_KEY when PIPELINE_AUTH_HEADER is unset", async () => {
    delete process.env.PIPELINE_AUTH_HEADER;
    process.env.X_PIPELINE_KEY = "backup-secret";
    axios.post.mockResolvedValue({ data: {} });

    await triggerPnlBackfill("bbb");

    expect(axios.post.mock.calls[0][2].headers).toEqual({ "x-pipeline-key": "backup-secret" });
  });

  test("skips the call and warns when PIPELINE_API_URL is not configured", async () => {
    delete process.env.PIPELINE_API_URL;

    const result = await triggerPnlBackfill("bbb");

    expect(axios.post).not.toHaveBeenCalled();
    expect(result).toEqual({ triggered: false, syncing: false, reason: "not_configured" });
    expect(logger.warn).toHaveBeenCalled();
  });

  // An in-flight run already covers the dates this trigger asked for, so the
  // brand is still told a sync is happening even though this call didn't
  // start one.
  test("treats a 409 (already running) as a benign non-error still counting as syncing", async () => {
    axios.post.mockRejectedValue({ response: { status: 409, data: { message: "already running" } } });

    const result = await triggerPnlBackfill("bbb");

    expect(result).toEqual({ triggered: false, syncing: true, reason: "already_running" });
  });

  test("swallows other failures rather than throwing", async () => {
    axios.post.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(triggerPnlBackfill("bbb")).resolves.toMatchObject({ triggered: false, reason: "error" });
    expect(logger.error).toHaveBeenCalled();
  });
});
