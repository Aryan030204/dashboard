import test from "node:test";
import assert from "node:assert/strict";
import { resolveDonutView, sessionsBreakdown } from "./viewModels.js";

// A Score distribution as the API returns it: visitors (one level each) and sessions per level.
const SCORE = {
  total: 52,
  totalSessions: 60,
  visitorBasis: "best_session",
  items: [
    { level: "high", users: 8, sessions: 10, pct: (8 / 52) * 100, sessionsPct: (10 / 60) * 100 },
    { level: "medium", users: 17, sessions: 20, pct: (17 / 52) * 100, sessionsPct: (20 / 60) * 100 },
    { level: "low", users: 27, sessions: 30, pct: (27 / 52) * 100, sessionsPct: (30 / 60) * 100 },
  ],
};

test("Score + Sessions shows sessions: the values, the shares and the total are the session ones", () => {
  const view = resolveDonutView({ distribution: SCORE, metric: "sessions", basis: "score" });
  assert.equal(view.bySessions, true);
  assert.deepEqual(view.items.map((i) => [i.level, i.value]), [["high", 10], ["medium", 20], ["low", 30]]);
  assert.equal(view.total, 60);
  assert.equal(view.centerLabel, "Sessions");
  assert.ok(Math.abs(view.items[2].pct - 50) < 1e-9);
});

test("Score + Visitors shows visitors, one level each, labelled Visitors", () => {
  const view = resolveDonutView({ distribution: SCORE, metric: "users", basis: "score" });
  assert.equal(view.bySessions, false);
  assert.deepEqual(view.items.map((i) => [i.level, i.value]), [["high", 8], ["medium", 17], ["low", 27]]);
  assert.equal(view.total, 52);
  assert.equal(view.items.reduce((sum, i) => sum + i.value, 0), view.total);   // the segments add up to the total
  assert.equal(view.centerLabel, "Visitors");
  assert.equal(view.note, null);
});

test("the two metrics give different numbers from the same Score distribution", () => {
  const visitors = resolveDonutView({ distribution: SCORE, metric: "users", basis: "score" });
  const sessions = resolveDonutView({ distribution: SCORE, metric: "sessions", basis: "score" });
  assert.notEqual(visitors.total, sessions.total);
  assert.notDeepEqual(visitors.items.map((i) => i.value), sessions.items.map((i) => i.value));
});

test("the metric is honoured in Behaviour too, with the bots note only on sessions", () => {
  const behaviour = { total: 80, totalSessions: 100, botsExcluded: 4, items: [
    { level: "high", users: 9, sessions: 10, pct: 11.25, sessionsPct: 10 },
    { level: "medium", users: 30, sessions: 40, pct: 37.5, sessionsPct: 40 },
    { level: "low", users: 41, sessions: 50, pct: 51.25, sessionsPct: 50 },
  ] };
  assert.equal(resolveDonutView({ distribution: behaviour, metric: "sessions", basis: "behavior" }).total, 100);
  assert.equal(resolveDonutView({ distribution: behaviour, metric: "sessions", basis: "behavior" }).botsExcluded, 4);
  assert.equal(resolveDonutView({ distribution: behaviour, metric: "users", basis: "behavior" }).total, 80);
  assert.equal(resolveDonutView({ distribution: behaviour, metric: "users", basis: "behavior" }).botsExcluded, 0);
});

test("old per-bucket visitor counts are not passed off as unique visitors", () => {
  const legacy = { ...SCORE, visitorBasis: "per_bucket" };
  assert.match(resolveDonutView({ distribution: legacy, metric: "users", basis: "score" }).note, /more than one level/);
  assert.equal(resolveDonutView({ distribution: legacy, metric: "sessions", basis: "score" }).note, null);
});

test("missing or malformed data gives zeros, not NaN", () => {
  for (const distribution of [undefined, null, {}, { items: [{ level: "high", users: "x", sessions: null }] }]) {
    for (const metric of ["users", "sessions"]) {
      const view = resolveDonutView({ distribution, metric, basis: "score" });
      assert.equal(Number.isNaN(view.total), false);
      view.items.forEach((i) => {
        assert.equal(Number.isNaN(i.value), false);
        assert.equal(Number.isNaN(i.pct), false);
      });
    }
  }
  assert.equal(resolveDonutView().total, 0);
});

test("the breakdown lists the parts in the order they add up to Total Sessions", () => {
  const card = { value: 12418, analysed: 12353, bots: 25, live: 1, waiting: 39, other: 0, rollupBehind: 190 };
  const { lines, rollupBehind } = sessionsBreakdown(card);
  assert.deepEqual(lines.map((l) => l.key), ["analysed", "bots", "live", "waiting"]);   // "other" is hidden when 0
  assert.equal(lines.reduce((sum, l) => sum + l.value, 0), card.value);
  assert.equal(rollupBehind, 190);
});

test("the breakdown is safe without a card and hides a rollup that is ahead", () => {
  assert.deepEqual(sessionsBreakdown(null), { lines: [], rollupBehind: 0 });
  assert.equal(sessionsBreakdown({ closed: 5, rollupBehind: -3 }).rollupBehind, 0);
  assert.equal(sessionsBreakdown({ closed: 5 }).lines[0].value, 5);                       // falls back to closed
});
