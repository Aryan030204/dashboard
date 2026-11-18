/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const {
  buildIntentFunnelService,
  createQueryCache,
  _internal,
} = require("../../../services/intentFunnelService");

const { buildCombinedScanQuery, mapCombinedScan, rangeCacheTtl } = _internal;

const METRICS = ["visitors", "productViews", "pageViews", "addToCart", "checkouts", "scored"];
const LEVELS = ["high", "medium", "low"];

// ---- the numbers of one brand, in the shape each of the four separate queries returns --------------------------
const TOTALS = (() => {
  const row = {};
  METRICS.forEach((id) => {
    ["cur", "prev"].forEach((p) => {
      row[`${p}_${id}_sessions`] = 0;
      row[`${p}_${id}_users`] = 0;
    });
  });
  return {
    ...row,
    cur_visitors_sessions: 120, cur_visitors_users: 100, prev_visitors_sessions: 60, prev_visitors_users: 50,
    cur_productViews_sessions: 80, cur_productViews_users: 70, prev_productViews_sessions: 40, prev_productViews_users: 35,
    cur_pageViews_sessions: 118, cur_pageViews_users: 98,
    cur_addToCart_sessions: 30, cur_addToCart_users: 28,
    cur_checkouts_sessions: 12, cur_checkouts_users: 11,
    cur_scored_sessions: 60, cur_scored_users: 55,
  };
})();
const BUCKETS = [
  { intent_bucket: "high", cur_sessions: 10, cur_users: 9, prev_sessions: 5, prev_users: 4, cur_atc_sessions: 8, cur_atc_users: 7, cur_checkout_sessions: 6, cur_checkout_users: 5 },
  { intent_bucket: "medium", cur_sessions: 20, cur_users: 18, prev_sessions: 20, prev_users: 18, cur_atc_sessions: 10, cur_atc_users: 9, cur_checkout_sessions: 4, cur_checkout_users: 4 },
  { intent_bucket: "low", cur_sessions: 30, cur_users: 28, prev_sessions: 0, prev_users: 0, cur_atc_sessions: 2, cur_atc_users: 2, cur_checkout_sessions: 0, cur_checkout_users: 0 },
];
const VISITORS = [
  { cur_high_users: 8, cur_medium_users: 17, cur_low_users: 27, prev_high_users: 3, prev_medium_users: 16, prev_low_users: 30 },
];
const BEHAVIOR = [
  {
    cur_high_sessions: 10, cur_medium_sessions: 40, cur_low_sessions: 50, cur_bot_sessions: 4,
    cur_high_users: 9, cur_medium_users: 30, cur_low_users: 41,
    prev_high_sessions: 10, prev_medium_sessions: 30, prev_low_sessions: 40, prev_bot_sessions: 2,
    prev_high_users: 9, prev_medium_users: 24, prev_low_users: 32,
  },
];

// The same numbers as the ONE row the combined query returns (the inverse of mapCombinedScan, written
// independently from the production mapper so the two check each other).
function combinedRow({ totals = TOTALS, buckets = BUCKETS, visitors = VISITORS[0], behavior = BEHAVIOR[0] } = {}) {
  const r = {};
  ["cur", "prev"].forEach((p) => {
    METRICS.forEach((id) => {
      r[`t_${p}_${id}_sessions`] = totals[`${p}_${id}_sessions`];
      r[`t_${p}_${id}_users`] = totals[`${p}_${id}_users`];
    });
    LEVELS.forEach((level) => {
      const b = buckets.find((x) => x.intent_bucket === level) || {};
      r[`b_${p}_${level}_sessions`] = b[`${p}_sessions`] ?? 0;
      r[`b_${p}_${level}_users`] = b[`${p}_users`] ?? 0;
      r[`s_${p}_${level}_users`] = visitors[`${p}_${level}_users`];
      r[`h_${p}_${level}_users`] = behavior[`${p}_${level}_users`];
      r[`h_${p}_${level}_sessions`] = behavior[`${p}_${level}_sessions`];
    });
    r[`h_${p}_bot_sessions`] = behavior[`${p}_bot_sessions`];
  });
  LEVELS.forEach((level) => {
    const b = buckets.find((x) => x.intent_bucket === level) || {};
    ["atc", "checkout"].forEach((tag) => {
      r[`b_cur_${tag}_${level}_sessions`] = b[`cur_${tag}_sessions`] ?? 0;
      r[`b_cur_${tag}_${level}_users`] = b[`cur_${tag}_users`] ?? 0;
    });
  });
  return r;
}

function makeConn({ mode, combined = () => [combinedRow()], failCombined = null } = {}) {
  const query = jest.fn(async (sql) => {
    if (sql.includes("AS t_cur_visitors")) {
      if (mode === "legacy") throw new Error("the combined query must not run when it is switched off");
      if (failCombined) throw failCombined;
      return combined();
    }
    if (sql.includes("FROM behavioral_path_daily")) return sql.includes("GROUP BY sequence_hash") ? [] : [{ sessions: 0 }];
    if (sql.includes("sessions_started")) return [{ cur_started: "300", prev_started: "200" }];
    if (sql.includes("FROM intent_daily_summary")) return [];
    if (sql.includes("FROM product_behavior_daily")) return [];
    if (sql.includes("open_sessions")) return [{ open_sessions: "20" }];
    if (sql.includes("FROM intent_actor_cursors")) return [];
    if (sql.includes("best_rank")) return [];
    if (sql.includes("GROUP_CONCAT")) return VISITORS;
    if (sql.includes(") levelled")) return BEHAVIOR;
    if (sql.includes("GROUP BY intent_bucket")) return BUCKETS;
    if (sql.includes("FROM intent_sessions")) return [TOTALS];
    throw new Error(`unexpected sql: ${sql}`);
  });
  return { query };
}

const SPEC = {
  brandKey: "BBB",
  start: "2026-10-10",
  end: "2026-10-12",
  timezone: "Asia/Kolkata",
  intent: "all",
  sort: "views",
  pathStart: "page_viewed",
  pathTop: 5,
};

const newService = () => buildIntentFunnelService({ cache: createQueryCache() });
const scans = (conn) => conn.query.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes("FROM intent_sessions"));

afterEach(() => {
  delete process.env.INTENT_COMBINED_SCAN;
});

describe("combined scan query", () => {
  const query = buildCombinedScanQuery({ prevStart: "2026-10-07", curStart: "2026-10-10", endExclusive: "2026-10-13" });

  test("reads intent_sessions once, with one bound parameter per placeholder and no dates in the SQL", () => {
    expect(query.sql.match(/FROM intent_sessions/g)).toHaveLength(1);
    expect(query.sql.match(/\?/g)).toHaveLength(query.params.length);
    expect(query.params).toEqual(["2026-10-10", "2026-10-07", "2026-10-13"]);
    expect(query.sql).not.toContain("2026-10");
  });

  test("keeps the execution timeout, drops the per-group sort of the old score-visitor query, groups once per visitor", () => {
    expect(query.sql).toContain("MAX_EXECUTION_TIME(");
    expect(query.sql).not.toContain("GROUP_CONCAT");
    expect(query.sql.match(/GROUP BY actor_id/g)).toHaveLength(1);
  });

  test("the best scored session of a visitor sorts by score descending, then session id", () => {
    expect(query.sql).toContain("MIN(CASE WHEN is_cur = 1");
    expect(query.sql).toContain("LPAD(100000 - CAST(ROUND(COALESCE(predictive_score, 0) * 100) AS UNSIGNED), 6, '0'), session_id, ':', intent_bucket");
  });

  test("every KPI flag, bucket, behaviour level and score level of both periods has a column", () => {
    METRICS.forEach((id) => ["cur", "prev"].forEach((p) => expect(query.sql).toContain(`AS t_${p}_${id}_sessions`)));
    LEVELS.forEach((level) => {
      ["cur", "prev"].forEach((p) => {
        expect(query.sql).toContain(`AS b_${p}_${level}_sessions`);
        expect(query.sql).toContain(`AS s_${p}_${level}_users`);
        expect(query.sql).toContain(`AS h_${p}_${level}_users`);
      });
      expect(query.sql).toContain(`AS b_cur_atc_${level}_sessions`);
      expect(query.sql).toContain(`AS b_cur_checkout_${level}_users`);
    });
  });
});

describe("mapCombinedScan", () => {
  test("splits the one row back into the rows of the four separate queries", () => {
    const mapped = mapCombinedScan(combinedRow());

    expect(mapped.totalsRows[0]).toMatchObject(TOTALS);
    expect(mapped.bucketRows).toEqual(BUCKETS);
    expect(mapped.visitorRows[0]).toEqual(VISITORS[0]);
    expect(mapped.behaviorRows[0]).toEqual(BEHAVIOR[0]);
  });

  test("a level with no scored sessions in either period has no bucket row, like the old GROUP BY", () => {
    const row = combinedRow({ buckets: BUCKETS.filter((b) => b.intent_bucket !== "low") });
    expect(mapCombinedScan(row).bucketRows.map((b) => b.intent_bucket)).toEqual(["high", "medium"]);
  });

  test("a brand with no sessions maps to zeros without throwing", () => {
    const mapped = mapCombinedScan({});
    expect(mapped.bucketRows).toEqual([]);
    expect(mapped.totalsRows).toHaveLength(1);
  });
});

describe("getIntentFunnel with the combined scan", () => {
  test("gives exactly the same page payload as the four separate queries", async () => {
    const legacyConn = makeConn({ mode: "legacy" });
    process.env.INTENT_COMBINED_SCAN = "off";
    const legacy = await newService().getIntentFunnel({ ...SPEC, conn: legacyConn });
    delete process.env.INTENT_COMBINED_SCAN;

    const combinedConn = makeConn({ mode: "combined" });
    const combined = await newService().getIntentFunnel({ ...SPEC, conn: combinedConn });

    expect(combined).toEqual(legacy);
    expect(combined.kpis.length).toBeGreaterThan(0);
    expect(combined.behavior).not.toBeNull();
  });

  test("reads intent_sessions once for the core numbers instead of four times", async () => {
    const conn = makeConn({ mode: "combined" });
    await newService().getIntentFunnel({ ...SPEC, conn });
    expect(scans(conn)).toHaveLength(1);

    const legacyConn = makeConn({ mode: "legacy" });
    process.env.INTENT_COMBINED_SCAN = "off";
    await newService().getIntentFunnel({ ...SPEC, conn: legacyConn });
    expect(scans(legacyConn)).toHaveLength(4);
  });

  test("INTENT_COMBINED_SCAN=off never sends the combined query", async () => {
    process.env.INTENT_COMBINED_SCAN = "off";
    const conn = makeConn({ mode: "legacy" });
    await expect(newService().getIntentFunnel({ ...SPEC, conn })).resolves.toBeTruthy();
  });

  test("an older brand database (unknown column) falls back to the separate queries and still answers", async () => {
    const err = Object.assign(new Error("Unknown column 'intent_exclusion_reason'"), { code: "ER_BAD_FIELD_ERROR", errno: 1054 });
    const conn = makeConn({ mode: "combined", failCombined: err });
    const out = await newService().getIntentFunnel({ ...SPEC, conn });

    expect(scans(conn).length).toBe(1 + 4);
    expect(out.meta.available).toBe(true);
    expect(out.kpis.length).toBeGreaterThan(0);
  });

  test("a query timeout is an error, not a silent fallback to four more heavy queries", async () => {
    const err = Object.assign(new Error("timeout"), { code: "ER_QUERY_TIMEOUT", errno: 3024 });
    const conn = makeConn({ mode: "combined", failCombined: err });
    await expect(newService().getIntentFunnel({ ...SPEC, conn })).rejects.toBe(err);
    expect(scans(conn)).toHaveLength(1);
  });

  test("missing intent tables answer available:false", async () => {
    const err = Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
    const conn = {
      query: jest.fn(async (sql) => {
        if (sql.includes("intent_sessions")) throw err;
        return [];
      }),
    };
    const out = await newService().getIntentFunnel({ ...SPEC, conn });
    expect(out.meta).toMatchObject({ available: false, reason: "intent_tables_missing" });
  });

  test("the path controls can be left out of the page payload (they load their own data)", async () => {
    const conn = makeConn({ mode: "combined" });
    const out = await newService().getIntentFunnel({ ...SPEC, skipPaths: true, conn });
    expect(conn.query.mock.calls.some(([sql]) => sql.includes("behavioral_path_daily"))).toBe(false);
    expect(out.paths.nodes).toEqual([]);
  });

  test("the core scan and the other sections start together, not in two waves", async () => {
    const order = [];
    const conn = {
      query: jest.fn(async (sql) => {
        order.push(sql.includes("AS t_cur_visitors") ? "core" : "other");
        await new Promise((resolve) => setImmediate(resolve));
        if (sql.includes("AS t_cur_visitors")) return [combinedRow()];
        if (sql.includes("sessions_started")) return [{ cur_started: "1", prev_started: "1" }];
        if (sql.includes("open_sessions")) return [{ open_sessions: "0" }];
        if (sql.includes("FROM behavioral_path_daily")) return sql.includes("GROUP BY sequence_hash") ? [] : [{ sessions: 0 }];
        return [];
      }),
    };
    await newService().getIntentFunnel({ ...SPEC, conn });
    // every other query was issued before the core scan finished: the first calls include both kinds at once
    expect(order.slice(0, 3)).toContain("core");
    expect(order.slice(0, 3).filter((x) => x === "other").length).toBeGreaterThan(0);
  });
});

describe("cache lifetime by range", () => {
  const at = (iso) => new Date(iso);

  test("a range that ended before yesterday is final", () => {
    expect(rangeCacheTtl("2026-10-20", "Asia/Kolkata", at("2026-10-27T06:00:00Z"))).toBe(10 * 60 * 1000);
  });

  test("a range ending yesterday is final only after 03:00 store time", () => {
    // 2026-10-27 01:00 IST = 2026-10-26 19:30Z -> still settling; 10:00 IST -> final
    expect(rangeCacheTtl("2026-10-26", "Asia/Kolkata", at("2026-10-26T19:30:00Z"))).toBeUndefined();
    expect(rangeCacheTtl("2026-10-26", "Asia/Kolkata", at("2026-10-27T04:30:00Z"))).toBe(10 * 60 * 1000);
  });

  test("a range that includes today keeps the default lifetime", () => {
    expect(rangeCacheTtl("2026-10-27", "Asia/Kolkata", at("2026-10-27T06:00:00Z"))).toBeUndefined();
    expect(rangeCacheTtl("", "Asia/Kolkata")).toBeUndefined();
  });

  test("a longer lifetime is honoured per call and the default stays short", async () => {
    let clock = 0;
    const cache = createQueryCache({ ttlMs: 1000, now: () => clock });
    const loader = jest.fn(async () => "value");

    await cache("k", loader);
    clock = 5000;
    await cache("k", loader); // default lifetime passed: loads again
    expect(loader).toHaveBeenCalledTimes(2);

    clock = 10000;
    await cache("long", loader, { ttlMs: 60000 });
    clock = 30000;
    await cache("long", loader, { ttlMs: 60000 }); // still fresh for this call
    expect(loader).toHaveBeenCalledTimes(3);
  });
});
