/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { buildIntentFunnelService, createQueryCache, _internal } = require("../../../services/intentFunnelService");

const { buildOverlapSingleQuery, buildOverlapBase, mapOverlapSources } = _internal;

const SPEC = { brandKey: "BBB", start: "2026-10-10", end: "2026-10-12", intent: "all", basis: "behavior" };
const newService = () => buildIntentFunnelService({ cache: createQueryCache() });

// Visitors with their sessions, as the base query would return them: one row per session (actor, group, checked out).
const SESSIONS = [
  // a: Google only (2 sessions, one reached checkout)
  { actor: "a", src: "google", co: 1 }, { actor: "a", src: "google", co: 0 },
  // b: Meta only
  { actor: "b", src: "meta", co: 0 },
  // c: Google + Meta
  { actor: "c", src: "google", co: 0 }, { actor: "c", src: "meta", co: 1 },
  // d: all three groups
  { actor: "d", src: "google", co: 0 }, { actor: "d", src: "meta", co: 0 }, { actor: "d", src: "others", co: 1 },
  // e, f: Others only
  { actor: "e", src: "others", co: 0 }, { actor: "f", src: "others", co: 1 },
];
const KEYS = ["google", "meta", "others"];

// What the two separate queries return for SESSIONS (an in-memory evaluation of their SQL).
function twoQueryRows() {
  const bySrc = new Map();
  SESSIONS.forEach((s) => {
    const e = bySrc.get(s.src) || { sessions: 0, actors: new Set() };
    e.sessions += 1;
    e.actors.add(s.actor);
    bySrc.set(s.src, e);
  });
  const top = [...bySrc.entries()]
    .map(([src, e]) => ({ src, sessions: e.sessions, users: e.actors.size }))
    .sort((a, b) => b.sessions - a.sessions || a.src.localeCompare(b.src));

  const actors = new Map();
  SESSIONS.forEach((s) => {
    const a = actors.get(s.actor) || { sessions: 0, co: 0, flags: [0, 0, 0] };
    a.sessions += 1;
    a.co += s.co;
    a.flags[KEYS.indexOf(s.src)] = 1;
    actors.set(s.actor, a);
  });
  const regions = new Map();
  actors.forEach((a) => {
    const k = a.flags.join("");
    const r = regions.get(k) || { g1: a.flags[0], g2: a.flags[1], g3: a.flags[2], users: 0, sessions: 0, checkout_sessions: 0 };
    r.users += 1;
    r.sessions += a.sessions;
    r.checkout_sessions += a.co;
    regions.set(k, r);
  });
  return { top, regions: [...regions.values()] };
}

// What the single query returns for SESSIONS: the same region rows plus the per-group session counts c1..c3.
function singleQueryRows() {
  const actors = new Map();
  SESSIONS.forEach((s) => {
    const a = actors.get(s.actor) || { sessions: 0, co: 0, flags: [0, 0, 0], c: [0, 0, 0] };
    a.sessions += 1;
    a.co += s.co;
    a.flags[KEYS.indexOf(s.src)] = 1;
    a.c[KEYS.indexOf(s.src)] += 1;
    actors.set(s.actor, a);
  });
  const regions = new Map();
  actors.forEach((a) => {
    const k = a.flags.join("");
    const r = regions.get(k) || {
      g1: a.flags[0], g2: a.flags[1], g3: a.flags[2], users: 0, sessions: 0, checkout_sessions: 0, c1: 0, c2: 0, c3: 0,
    };
    r.users += 1;
    r.sessions += a.sessions;
    r.checkout_sessions += a.co;
    r.c1 += a.c[0];
    r.c2 += a.c[1];
    r.c3 += a.c[2];
    regions.set(k, r);
  });
  return [...regions.values()];
}

function makeConn(mode) {
  const { top, regions } = twoQueryRows();
  const single = singleQueryRows();
  const query = jest.fn(async (sql) => {
    if (sql.includes("GROUP BY src")) return top;
    if (sql.includes("GROUP BY g1, g2, g3")) return sql.includes("c1") ? single : regions;
    throw new Error(`unexpected sql: ${sql}`);
  });
  return { query, mode };
}

afterEach(() => {
  delete process.env.INTENT_OVERLAP_SINGLE_QUERY;
});

describe("single-query overlap", () => {
  test("gives exactly the sources and regions of the two separate queries", async () => {
    process.env.INTENT_OVERLAP_SINGLE_QUERY = "off";
    const twoConn = makeConn("two");
    const two = await newService().getSourceOverlap({ ...SPEC, conn: twoConn });
    delete process.env.INTENT_OVERLAP_SINGLE_QUERY;

    const oneConn = makeConn("one");
    const one = await newService().getSourceOverlap({ ...SPEC, conn: oneConn });

    expect(one).toEqual(two);
    expect(one.sources.map((s) => [s.key, s.sessions, s.users])).toEqual([
      ["google", 4, 3], ["meta", 3, 3], ["others", 3, 3],
    ]);
    expect(twoConn.query).toHaveBeenCalledTimes(2);
    expect(oneConn.query).toHaveBeenCalledTimes(1);
  });

  test("the join runs once: one execution of the base, one parameter list", () => {
    const base = buildOverlapBase({ basis: "behavior", intent: "all", curStart: "2026-10-10", endExclusive: "2026-10-13" });
    const { sql, params } = buildOverlapSingleQuery(base);

    expect(sql.match(/FROM behavioral_events/g)).toHaveLength(1);
    expect(params).toEqual(base.params);
    expect(sql.match(/\?/g)).toHaveLength(params.length);
    expect(sql).toContain("MAX_EXECUTION_TIME(");
    expect(sql).toContain("GROUP BY g1, g2, g3");
  });

  test("source groups are constants in the SQL, never request values", () => {
    const base = buildOverlapBase({ basis: "behavior", intent: "high", curStart: "2026-10-10", endExclusive: "2026-10-13" });
    const { sql } = buildOverlapSingleQuery(base);
    ["google", "meta", "others"].forEach((key) => expect(sql).toContain(`src = '${key}'`));
    expect(sql).not.toContain("2026-10");
    expect(sql).not.toMatch(/=\s*'high'/);
  });

  test("no sessions in the range answers empty sources and regions, as before", async () => {
    const conn = { query: jest.fn(async () => []) };
    const out = await newService().getSourceOverlap({ ...SPEC, conn });
    expect(out).toMatchObject({ meta: { available: true }, sources: [], regions: [] });
  });

  test("sources are summed from the region rows", () => {
    const sources = mapOverlapSources(singleQueryRows());
    expect(sources).toEqual([
      { key: "google", label: "Google", sessions: 4, users: 3 },
      { key: "meta", label: "Meta", sessions: 3, users: 3 },
      { key: "others", label: "Others", sessions: 3, users: 3 },
    ]);
  });

  test("an older database (unknown column) still answers available:false", async () => {
    const err = Object.assign(new Error("Unknown column"), { code: "ER_BAD_FIELD_ERROR", errno: 1054 });
    const conn = { query: jest.fn(async () => { throw err; }) };
    const out = await newService().getSourceOverlap({ ...SPEC, conn });
    expect(out.meta).toMatchObject({ available: false, reason: "schema_unsupported" });
  });
});
