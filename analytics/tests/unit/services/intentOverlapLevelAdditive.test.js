/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { buildIntentFunnelService, createQueryCache, _internal } = require("../../../services/intentFunnelService");

const { buildOverlapBase, buildOverlapSingleQuery, buildOverlapTopSourcesQuery, buildOverlapRegionsQuery } = _internal;

const args = { basis: "behavior", curStart: "2026-10-10", endExclusive: "2026-10-13" };

describe("the intent level chooses sessions, not visitors", () => {
  test("every session of the range is a row; the level only sets in_level and is never in the WHERE", () => {
    const base = buildOverlapBase({ ...args, intent: "high" });
    expect(base.sql).toMatch(/\) AS in_level/);
    const where = base.sql.slice(base.sql.lastIndexOf("WHERE session_start"));
    expect(where).not.toContain("intent_bucket");
    expect(where).not.toContain("session_time_spent_ms");
    expect(where).not.toContain("click_count");
  });

  test("with no level every row is in the level (the constant 1, no parameter)", () => {
    const base = buildOverlapBase({ ...args, intent: "all" });
    expect(base.sql).toContain("(1) AS in_level");
    expect(base.params).toEqual(["2026-10-10", "2026-10-14", "2026-10-10", "2026-10-13"]);
  });

  test("the session-UTM base does the same", () => {
    const base = buildOverlapBase({ ...args, intent: "medium", sessionUtm: true });
    expect(base.sql).toContain("AS in_level");
    expect(base.params).toEqual(["medium", "2026-10-10", "2026-10-13"]);
    expect(base.sql.match(/\?/g)).toHaveLength(base.params.length);
  });

  test("the single query takes the circles from ALL sessions and the counts from the in-level ones only", () => {
    const { sql } = buildOverlapSingleQuery(buildOverlapBase({ ...args, intent: "high" }));
    expect(sql).toContain("MAX(src = 'google') AS g1");              // membership: every session
    expect(sql).toContain("SUM(in_level) AS sessions");             // counts: in-level sessions
    expect(sql).toContain("SUM(in_level AND checked_out) AS checkout_sessions");
    expect(sql).toContain("SUM(in_level AND src = 'google') AS c1");
    expect(sql).toContain("WHERE sessions > 0");                     // a visitor with no in-level session is not counted
  });

  test("the two-query path counts the same way", () => {
    const base = buildOverlapBase({ ...args, intent: "high" });
    const top = buildOverlapTopSourcesQuery(base).sql;
    expect(top).toContain("SUM(in_level) AS sessions");
    expect(top).toContain("COUNT(DISTINCT CASE WHEN in_level = 1 THEN actor_id END)");
    expect(top).toContain("HAVING SUM(in_level) > 0");
    const regions = buildOverlapRegionsQuery(base, ["google", "meta", "others"]).sql;
    expect(regions).toContain("SUM(in_level AND src IN (?, ?, ?)) AS sessions");
    expect(regions).toContain("SUM(in_level AND src IN (?, ?, ?) AND checked_out) AS checkout_sessions");
    expect(regions).toContain("MAX(src = ?) AS g1");
  });

  test("the numbers of the levels add up to All Intents (the arithmetic the SQL implements)", async () => {
    // visitors and their sessions: source, level, checkout. Every session has a level here.
    const sessions = [
      { a: "v1", src: "google", level: "high", co: 1 },
      { a: "v1", src: "meta", level: "medium", co: 0 },
      { a: "v1", src: "others", level: "low", co: 1 },     // v1 is seen in all three sources, across three levels
      { a: "v2", src: "google", level: "low", co: 0 },
      { a: "v2", src: "meta", level: "low", co: 1 },
      { a: "v3", src: "others", level: "high", co: 1 },
    ];

    // an in-memory evaluation of the single query
    function regionRows(level) {
      const actors = new Map();
      sessions.forEach((s) => {
        const inLevel = level === "all" || s.level === level;
        const a = actors.get(s.a) || { flags: [0, 0, 0], sessions: 0, co: 0 };
        a.flags[["google", "meta", "others"].indexOf(s.src)] = 1;     // circles: all sessions
        if (inLevel) {
          a.sessions += 1;
          a.co += s.co;
        }
        actors.set(s.a, a);
      });
      const regions = new Map();
      actors.forEach((a) => {
        if (a.sessions === 0) return;
        const key = a.flags.join("");
        const r = regions.get(key) || { g1: a.flags[0], g2: a.flags[1], g3: a.flags[2], users: 0, sessions: 0, checkout_sessions: 0, c1: 0, c2: 0, c3: 0 };
        r.users += 1;
        r.sessions += a.sessions;
        r.checkout_sessions += a.co;
        regions.set(key, r);
      });
      return [...regions.values()];
    }

    const service = buildIntentFunnelService({ cache: createQueryCache({ shared: null }) });
    const run = async (intent) => {
      const conn = { query: jest.fn(async () => regionRows(intent)) };
      return service.getSourceOverlap({ conn, brandKey: `B-${intent}`, start: "2026-10-10", end: "2026-10-12", intent, basis: "behavior" });
    };
    const [all, high, medium, low] = await Promise.all(["all", "high", "medium", "low"].map(run));

    for (const region of all.regions) {
      const parts = [high, medium, low].map((r) => r.regions.find((x) => x.id === region.id));
      expect(parts.reduce((s, r) => s + r.sessions, 0)).toBe(region.sessions);
      expect(parts.reduce((s, r) => s + r.checkoutSessions, 0)).toBe(region.checkoutSessions);
      expect(parts.reduce((s, r) => s + r.value, 0)).toBe(region.value);
    }
    // the centre (all three sources) is v1 only: checkouts 1 (high) + 0 (medium) + 1 (low) = 2 = All Intents
    const centre = (r) => r.regions.find((x) => x.kind === "all");
    expect([high, medium, low].map((r) => centre(r).value)).toEqual([1, 0, 1]);
    expect(centre(all).value).toBe(2);
  });
});
