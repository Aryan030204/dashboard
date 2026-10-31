/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { buildIntentFunnelService, createQueryCache } = require("../../../services/intentFunnelService");

const SPEC = { brandKey: "BBB", start: "2026-10-10", end: "2026-10-12", timezone: "Asia/Kolkata", intent: "all", sort: "views", pathStart: "page_viewed", pathTop: 5 };

function trackingConn() {
  const state = { active: 0, max: 0, calls: 0 };
  const query = jest.fn(async (sql) => {
    state.calls += 1;
    state.active += 1;
    state.max = Math.max(state.max, state.active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    state.active -= 1;
    if (sql.includes("AS t_cur_visitors")) return [{}];
    if (sql.includes("FROM behavioral_path_daily")) return sql.includes("GROUP BY sequence_hash") ? [] : [{ sessions: 0 }];
    if (sql.includes("open_sessions")) return [{ open_sessions: "0" }];
    return [];
  });
  return { query, state };
}

afterEach(() => {
  delete process.env.INTENT_QUERY_CONCURRENCY;
});

test("one page load never runs more heavy queries at once than the per-brand limit", async () => {
  process.env.INTENT_QUERY_CONCURRENCY = "2";
  const conn = trackingConn();
  await buildIntentFunnelService({ cache: createQueryCache() }).getIntentFunnel({ ...SPEC, conn });

  expect(conn.state.calls).toBeGreaterThan(3);
  expect(conn.state.max).toBeLessThanOrEqual(2);
});

test("a cached answer does not run a query again", async () => {
  const conn = trackingConn();
  const service = buildIntentFunnelService({ cache: createQueryCache() });
  await service.getIntentFunnel({ ...SPEC, conn });
  const first = conn.state.calls;
  await service.getIntentFunnel({ ...SPEC, conn });

  // only the uncached live-session lookups may run again
  expect(conn.state.calls - first).toBeLessThan(first);
});
