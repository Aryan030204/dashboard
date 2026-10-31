const { QueryTypes } = require("sequelize");
const logger = require("../shared/utils/logger");
const { runLimited } = require("../shared/utils/brandLimiter");
const {
  DEFAULT_TIMEZONE,
  daysInclusive,
  normalizeTimezone,
  shiftDays,
} = require("../shared/utils/date");
const {
  LIVE_WINDOW_MINUTES,
  LIVE_ROW_LIMIT,
  FUTURE_TOLERANCE_HOURS,
  classifyOpenSessions,
  applyLive,
} = require("./intentLiveSessions");

// Read-only aggregation over the intent pipeline tables of one brand database.
// The pipeline owns scoring (predictive_score / intent_bucket / intent_status);
// nothing here rescores or infers data. All dates are the brand's local dates,
// matching how the intent pipeline stores session_start / occurred_at /
// summary_date. The brand connection comes from brandContext (tenant-router),
// never from request input.

const INTENT_LEVELS = Object.freeze(["high", "medium", "low"]);
const INTENT_FILTERS = Object.freeze(["all", ...INTENT_LEVELS]);

// whitelist: request value -> field on the merged product row
const PRODUCT_SORTS = Object.freeze({
  views: "views",
  add_to_cart: "addToCart",
  checkouts: "checkouts",
});

// ORDER BY expression per sort key (the keys are PRODUCT_SORTS values). The request only
// ever picks a key from the whitelist; these strings are constants and never carry input.
const PRODUCT_SORT_SQL = Object.freeze({
  views: "SUM(product_views)",
  addToCart: "SUM(add_to_cart_count)",
  checkouts: "SUM(checkout_started_count)",
});

// Real first events seen in behavioral_path_daily.sequence.
const PATH_STARTS = Object.freeze([
  "page_viewed",
  "product_viewed",
  "click",
  "product_added_to_cart",
]);

// Path length: how many steps (columns) the Funnel Exploration shows. Branches per step are fixed.
const PATH_STEPS_DEFAULT = 5;
const PATH_STEPS_MIN = 3;
const PATH_STEPS_MAX = 8;
const PATH_BRANCHES_PER_STEP = 5;
const PATH_TOP_MIN = 3;
const PATH_TOP_MAX = 8;
const PATH_ROW_LIMIT = 500;
// Live paths (a product or an intent level is chosen) read sessions instead of the daily rollup, so
// they are bounded: at most this many PDP events / sessions are read per request.
const PATH_LIVE_EVENT_CAP = 50000;
const PATH_LIVE_SESSION_CAP = 40000;
const PATH_LIVE_CHUNK = 2000;
const PATH_LIVE_BATCH = 1000;
// Same cap as the rollup (pipeline/rollups.py SEQUENCE_MAX_STEPS) so live and rollup paths agree.
const PATH_SEQUENCE_MAX_STEPS = 15;
const PRODUCT_RESULT_LIMIT = 10;
// Upper bound on distinct products scanned per request (catalog-sized).
const PRODUCT_SCAN_LIMIT = 500;
const CHECKOUT_PRODUCT_SCAN_LIMIT = 5000;
const PRODUCT_QUERY_TIMEOUT_MS = 20000;
// The two session queries scan intent_sessions for the current and the previous period.
const CORE_QUERY_TIMEOUT_MS = 30000;
const MAX_RANGE_DAYS = 366;

const EVENT_LABELS = Object.freeze({
  page_viewed: "Page View",
  product_viewed: "Product View",
  click: "Click",
  product_added_to_cart: "Add to Cart",
  checkout_started: "Checkout Started",
  exit: "Exit",
});

// Session-level flags. Conditions are constants, never request input.
const SESSION_METRICS = Object.freeze([
  { id: "visitors", cond: null },
  { id: "productViews", cond: "product_view_count > 0" },
  { id: "pageViews", cond: "page_view_count > 0" },
  { id: "addToCart", cond: "add_to_cart_count > 0" },
  { id: "checkouts", cond: "checkout_started_count > 0" },
  { id: "scored", cond: "intent_status = 'scored'" },
]);

const KPI_DEFS = Object.freeze([
  { id: "visitors", label: "Unique Visitors", source: "visitors", tone: "neutral" },
  { id: "high", label: "High Intent Users", source: "high", tone: "high" },
  { id: "medium", label: "Medium Intent Users", source: "medium", tone: "medium" },
  { id: "low", label: "Low Intent Users", source: "low", tone: "low" },
  { id: "productViews", label: "Product Page Views", source: "productViews", tone: "neutral" },
  { id: "pageViews", label: "Page Views", source: "pageViews", tone: "neutral" },
  { id: "addToCart", label: "Add to Cart", source: "addToCart", tone: "neutral" },
  { id: "checkouts", label: "Checkouts Started", source: "checkouts", tone: "neutral" },
]);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safePct(numerator, denominator) {
  const d = num(denominator);
  if (d <= 0) return 0;
  return (num(numerator) / d) * 100;
}

function pctChange(current, previous) {
  const p = num(previous);
  if (p <= 0) return null;
  return ((num(current) - p) / p) * 100;
}

function isMissingTable(err) {
  return err?.code === "ER_NO_SUCH_TABLE" || err?.errno === 1146;
}

// Older brand databases have an earlier intent_sessions layout (for example
// without intent_status); treat it like a missing table instead of failing.
function isSchemaMismatch(err) {
  return err?.code === "ER_BAD_FIELD_ERROR" || err?.errno === 1054;
}

function isQueryTimeout(err) {
  return (
    err?.code === "ER_QUERY_TIMEOUT" ||
    err?.errno === 3024 ||
    err?.code === "ER_QUERY_INTERRUPTED" ||
    err?.errno === 1317
  );
}

// COUNT / COUNT(DISTINCT actor_id) expression restricted to a period and an
// optional extra condition. `?` placeholders are used because the tenant
// connection formats replacements with mysql2 (positional only).
function periodExpr({ unit, period, cond }, curStart, params) {
  const periodCond = period === "cur" ? "session_start >= ?" : "session_start < ?";
  params.push(curStart);
  const where = cond ? `${periodCond} AND ${cond}` : periodCond;
  return unit === "users"
    ? `COUNT(DISTINCT CASE WHEN ${where} THEN actor_id END)`
    : `COUNT(CASE WHEN ${where} THEN 1 END)`;
}

// One scan over [prevStart, endExclusive) for the current and the previous
// period of equal length. Sessions are first grouped per actor (one hash group
// instead of a dozen COUNT(DISTINCT) sets, roughly twice as fast on real data);
// the outer query then sums sessions and counts actors with at least one.
function buildTotalsQuery({ prevStart, curStart, endExclusive }) {
  const params = [];
  const inner = [];
  const outer = [];
  SESSION_METRICS.forEach((metric) => {
    ["cur", "prev"].forEach((period) => {
      const periodCond = period === "cur" ? "session_start >= ?" : "session_start < ?";
      params.push(curStart);
      const cond = metric.cond ? `${periodCond} AND ${metric.cond}` : periodCond;
      const key = `${period}_${metric.id}`;
      inner.push(`SUM(${cond}) AS ${key}`);
      outer.push(`SUM(${key}) AS ${key}_sessions`, `SUM(${key} > 0) AS ${key}_users`);
    });
  });
  params.push(prevStart, endExclusive);
  const sql = `
    SELECT /*+ MAX_EXECUTION_TIME(${CORE_QUERY_TIMEOUT_MS}) */
      ${outer.join(",\n      ")}
    FROM (
      SELECT
        actor_id,
        ${inner.join(",\n        ")}
      FROM intent_sessions
      WHERE session_start >= ? AND session_start < ?
      GROUP BY actor_id
    ) per_actor
  `;
  return { sql, params };
}

// Per intent bucket (scored sessions only): size for both periods, and how
// many of the current period reached ATC / checkout.
function buildBucketQuery({ prevStart, curStart, endExclusive }) {
  const params = [];
  const cols = [];
  [
    ["cur", "sessions", null],
    ["cur", "users", null],
    ["prev", "sessions", null],
    ["prev", "users", null],
    ["cur", "sessions", "add_to_cart_count > 0", "atc"],
    ["cur", "users", "add_to_cart_count > 0", "atc"],
    ["cur", "sessions", "checkout_started_count > 0", "checkout"],
    ["cur", "users", "checkout_started_count > 0", "checkout"],
  ].forEach(([period, unit, cond, tag]) => {
    const expr = periodExpr({ unit, period, cond }, curStart, params);
    cols.push(`${expr} AS ${period}_${tag ? `${tag}_` : ""}${unit}`);
  });
  params.push(prevStart, endExclusive);
  const sql = `
    SELECT /*+ MAX_EXECUTION_TIME(${CORE_QUERY_TIMEOUT_MS}) */
      intent_bucket,
      ${cols.join(",\n      ")}
    FROM intent_sessions
    WHERE session_start >= ? AND session_start < ?
      AND intent_status = 'scored'
      AND intent_bucket IN ('high', 'medium', 'low')
    GROUP BY intent_bucket
  `;
  return { sql, params };
}

// Score view, visitors: every visitor gets exactly ONE level, the bucket of their highest-scoring scored session
// in the period (ties broken by session id), the same rule the pipeline uses for a visitor's intent
// (intent_engine/actor_scorer.py recompute_actors). So High + Medium + Low add up to the scored visitors, which is
// the "unique visitors" of the score population. Counting COUNT(DISTINCT actor_id) per bucket instead, as this
// page used to, put a visitor with a Low and a High session in both. GROUP_CONCAT ... ORDER BY puts the best
// session's bucket first, and SUBSTRING_INDEX keeps only that one (a long list truncated by
// group_concat_max_len still starts with it). Visitors with only pending or excluded sessions have no level and
// are not in this population. One scan of intent_sessions for both periods, one result row.
function buildScoreVisitorsQuery({ prevStart, curStart, endExclusive }) {
  const outer = [];
  ["cur", "prev"].forEach((period) => {
    INTENT_LEVELS.forEach((level) => {
      outer.push(`COALESCE(SUM(${period}_best = '${level}'), 0) AS ${period}_${level}_users`);
    });
  });
  const sql = `
    SELECT /*+ MAX_EXECUTION_TIME(${CORE_QUERY_TIMEOUT_MS}) */
      ${outer.join(",\n      ")}
    FROM (
      SELECT
        actor_id,
        SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN is_cur = 1 THEN intent_bucket END
                                     ORDER BY predictive_score DESC, session_id), ',', 1) AS cur_best,
        SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN is_cur = 0 THEN intent_bucket END
                                     ORDER BY predictive_score DESC, session_id), ',', 1) AS prev_best
      FROM (
        SELECT actor_id, session_id, intent_bucket, predictive_score, session_start >= ? AS is_cur
        FROM intent_sessions
        WHERE session_start >= ? AND session_start < ?
          AND intent_status = 'scored'
          AND intent_bucket IN ('high', 'medium', 'low')
      ) scored
      GROUP BY actor_id
    ) per_actor
  `;
  return { sql, params: [curStart, prevStart, endExclusive] };
}

// { high: { cur_users, prev_users }, medium: {...}, low: {...} } from the one result row, or null.
function buildScoreVisitors(rows) {
  const row = rows?.[0];
  if (!row) return null;
  const out = {};
  INTENT_LEVELS.forEach((level) => {
    out[level] = { cur_users: num(row[`cur_${level}_users`]), prev_users: num(row[`prev_${level}_users`]) };
  });
  return out;
}

// Behaviour-based intent: what the visitor actually did in each session, not where the session's score
// falls among the brand's other sessions. Written to line up with Microsoft Clarity's User Intent:
//   low    - under 5 seconds on the site, or any length with no clicks and no scrolls
//   high   - over 5 seconds with clicks and a strong intent signal: add to cart or checkout started
//   medium - over 5 seconds with some interaction, but no strong signal
// A product view is a supporting engagement signal, not a High trigger on its own: on a store most clicking
// visitors view a product, so counting it made High far too easy (about 31% of sessions against about 13%
// when only add to cart and checkout count). add_to_cart_count counts product_added_to_cart events (one per
// product per session, the pipeline de-duplicates them) and checkout_started_count counts checkout_started
// events; only "greater than 0" is used, so a repeated event cannot count twice.
// It reads every closed session (scored, excluded as zero-signal, or still pending), so one-page bounces
// land in "low" instead of disappearing. Bots are counted separately and left out of the three levels.
// The score-based buckets above stay percentile based (about 28% of a brand's sessions are always "high").
const BEHAVIOR_MIN_DURATION_MS = 5000;
const BEHAVIOR_LEVEL_SQL = `CASE
        WHEN intent_exclusion_reason = 'bot' THEN 'bot'
        WHEN session_time_spent_ms < ${BEHAVIOR_MIN_DURATION_MS} OR (click_count = 0 AND scroll_count = 0) THEN 'low'
        WHEN click_count > 0 AND (add_to_cart_count > 0 OR checkout_started_count > 0) THEN 'high'
        ELSE 'medium'
      END`;
const BEHAVIOR_RULES = Object.freeze({
  minDurationSeconds: BEHAVIOR_MIN_DURATION_MS / 1000,
  low: "Under 5 seconds, or no clicks and no scrolls",
  medium: "Over 5 seconds with some interaction",
  high: "Over 5 seconds with clicks and an add to cart or checkout started",
});

// Short column tags for the per-actor counters below.
const BEHAVIOR_TAGS = Object.freeze([
  ["high", "h"],
  ["medium", "m"],
  ["low", "l"],
  ["bot", "b"],
]);

// One scan of intent_sessions for both periods, one result row. Sessions are counted per level; a visitor
// is counted once, at the best level any of their sessions reached in the period (high over medium over
// low), so the three user counts add up to the visitors seen (bot-only visitors excluded). Sessions are
// grouped per actor first (a hash group, the same pattern as buildTotalsQuery), then summed.
function buildBehaviorQuery({ prevStart, curStart, endExclusive }) {
  const inner = [];
  const outer = [];
  ["cur", "prev"].forEach((period) => {
    const isCur = period === "cur" ? 1 : 0;
    BEHAVIOR_TAGS.forEach(([level, tag]) => {
      inner.push(`SUM(is_cur = ${isCur} AND lvl = '${level}') AS ${period}_${tag}`);
      outer.push(`COALESCE(SUM(${period}_${tag}), 0) AS ${period}_${level}_sessions`);
    });
    outer.push(
      `COALESCE(SUM(${period}_h > 0), 0) AS ${period}_high_users`,
      `COALESCE(SUM(${period}_h = 0 AND ${period}_m > 0), 0) AS ${period}_medium_users`,
      `COALESCE(SUM(${period}_h = 0 AND ${period}_m = 0 AND ${period}_l > 0), 0) AS ${period}_low_users`,
    );
  });
  const sql = `
    SELECT /*+ MAX_EXECUTION_TIME(${CORE_QUERY_TIMEOUT_MS}) */
      ${outer.join(",\n      ")}
    FROM (
      SELECT
        actor_id,
        ${inner.join(",\n        ")}
      FROM (
        SELECT
          actor_id,
          session_start >= ? AS is_cur,
          ${BEHAVIOR_LEVEL_SQL} AS lvl
        FROM intent_sessions
        WHERE session_start >= ? AND session_start < ?
          AND session_time_spent_ms IS NOT NULL
      ) levelled
      GROUP BY actor_id
    ) per_actor
  `;
  return { sql, params: [curStart, prevStart, endExclusive] };
}

// ---- One scan for the four core queries -----------------------------------------------------------------------
// The totals, bucket, score-visitor and behaviour queries above each scanned intent_sessions over the same
// [prevStart, endExclusive) window and grouped it per visitor, so one page load read the same rows four times.
// This is the same arithmetic in one pass: sessions get their flags once (is_cur, behaviour level), are
// grouped per visitor once, and one outer row sums everything. The one row is then split back into the exact
// row shapes the four queries returned (mapCombinedScan), so nothing downstream changes. The old builders stay:
// they are the path for older brand databases (no intent_exclusion_reason column) and INTENT_COMBINED_SCAN=off.
//
// A visitor's best scored session (highest score, ties by session id, the rule of buildScoreVisitorsQuery) is
// found with MIN over a key that sorts as "score descending, then session id": the score as a zero-padded
// number counted down from 100000, the session id, then ":" and the bucket. predictive_score is DECIMAL(5, 2).
const COMBINED_SCORED = "intent_status = 'scored' AND intent_bucket IN ('high', 'medium', 'low')";

function combinedScanEnabled(env = process.env) {
  return String(env.INTENT_COMBINED_SCAN || "on").trim().toLowerCase() !== "off";
}

function buildCombinedScanQuery({ prevStart, curStart, endExclusive }) {
  const periods = [
    ["cur", 1],
    ["prev", 0],
  ];
  const actor = [];
  const outer = [];

  periods.forEach(([period, isCur]) => {
    // totals: sessions per visitor for each KPI flag
    SESSION_METRICS.forEach((metric) => {
      const cond = metric.cond ? ` AND ${metric.cond}` : "";
      actor.push(`SUM(is_cur = ${isCur}${cond}) AS t_${period}_${metric.id}`);
      outer.push(
        `COALESCE(SUM(t_${period}_${metric.id}), 0) AS t_${period}_${metric.id}_sessions`,
        `COALESCE(SUM(t_${period}_${metric.id} > 0), 0) AS t_${period}_${metric.id}_users`,
      );
    });

    // buckets: scored sessions per level (and, for the current period, those that reached cart / checkout)
    INTENT_LEVELS.forEach((level) => {
      const inBucket = `is_cur = ${isCur} AND ${COMBINED_SCORED} AND intent_bucket = '${level}'`;
      actor.push(`SUM(${inBucket}) AS b_${period}_${level}`);
      outer.push(
        `COALESCE(SUM(b_${period}_${level}), 0) AS b_${period}_${level}_sessions`,
        `COALESCE(SUM(b_${period}_${level} > 0), 0) AS b_${period}_${level}_users`,
      );
      if (isCur === 1) {
        [
          ["atc", "add_to_cart_count > 0"],
          ["checkout", "checkout_started_count > 0"],
        ].forEach(([tag, cond]) => {
          actor.push(`SUM(${inBucket} AND ${cond}) AS b_cur_${tag}_${level}`);
          outer.push(
            `COALESCE(SUM(b_cur_${tag}_${level}), 0) AS b_cur_${tag}_${level}_sessions`,
            `COALESCE(SUM(b_cur_${tag}_${level} > 0), 0) AS b_cur_${tag}_${level}_users`,
          );
        });
      }
    });

    // score visitors: the bucket of the visitor's best scored session in the period
    actor.push(
      `MIN(CASE WHEN is_cur = ${isCur} AND ${COMBINED_SCORED} THEN CONCAT(LPAD(100000 - CAST(ROUND(COALESCE(predictive_score, 0) * 100) AS UNSIGNED), 6, '0'), session_id, ':', intent_bucket) END) AS s_${period}`,
    );
    INTENT_LEVELS.forEach((level) => {
      outer.push(
        `COALESCE(SUM(SUBSTRING_INDEX(s_${period}, ':', -1) = '${level}'), 0) AS s_${period}_${level}_users`,
      );
    });

    // behaviour levels (closed sessions with a measured duration; lvl is NULL otherwise)
    BEHAVIOR_TAGS.forEach(([level, tag]) => {
      actor.push(`SUM(is_cur = ${isCur} AND lvl = '${level}') AS h_${period}_${tag}`);
      outer.push(`COALESCE(SUM(h_${period}_${tag}), 0) AS h_${period}_${level}_sessions`);
    });
    outer.push(
      `COALESCE(SUM(h_${period}_h > 0), 0) AS h_${period}_high_users`,
      `COALESCE(SUM(h_${period}_h = 0 AND h_${period}_m > 0), 0) AS h_${period}_medium_users`,
      `COALESCE(SUM(h_${period}_h = 0 AND h_${period}_m = 0 AND h_${period}_l > 0), 0) AS h_${period}_low_users`,
    );
  });

  const sql = `
    SELECT /*+ MAX_EXECUTION_TIME(${CORE_QUERY_TIMEOUT_MS}) */
      ${outer.join(",\n      ")}
    FROM (
      SELECT
        actor_id,
        ${actor.join(",\n        ")}
      FROM (
        SELECT
          actor_id,
          session_id,
          session_start >= ? AS is_cur,
          intent_status,
          intent_bucket,
          predictive_score,
          product_view_count,
          page_view_count,
          add_to_cart_count,
          checkout_started_count,
          CASE WHEN session_time_spent_ms IS NULL THEN NULL ELSE ${BEHAVIOR_LEVEL_SQL} END AS lvl
        FROM intent_sessions
        WHERE session_start >= ? AND session_start < ?
      ) sessions
      GROUP BY actor_id
    ) per_actor
  `;
  return { sql, params: [curStart, prevStart, endExclusive] };
}

// The one combined row -> the rows the four separate queries returned.
function mapCombinedScan(row) {
  const r = row || {};
  const totals = {};
  ["cur", "prev"].forEach((period) => {
    SESSION_METRICS.forEach((metric) => {
      totals[`${period}_${metric.id}_sessions`] = r[`t_${period}_${metric.id}_sessions`];
      totals[`${period}_${metric.id}_users`] = r[`t_${period}_${metric.id}_users`];
    });
  });

  // buildBucketQuery returned a row only for a level that had scored sessions in the two periods
  const bucketRows = [];
  INTENT_LEVELS.forEach((level) => {
    const entry = {
      intent_bucket: level,
      cur_sessions: r[`b_cur_${level}_sessions`],
      cur_users: r[`b_cur_${level}_users`],
      prev_sessions: r[`b_prev_${level}_sessions`],
      prev_users: r[`b_prev_${level}_users`],
      cur_atc_sessions: r[`b_cur_atc_${level}_sessions`],
      cur_atc_users: r[`b_cur_atc_${level}_users`],
      cur_checkout_sessions: r[`b_cur_checkout_${level}_sessions`],
      cur_checkout_users: r[`b_cur_checkout_${level}_users`],
    };
    if (num(entry.cur_sessions) + num(entry.prev_sessions) > 0) bucketRows.push(entry);
  });

  const visitors = {};
  const behavior = {};
  ["cur", "prev"].forEach((period) => {
    INTENT_LEVELS.forEach((level) => {
      visitors[`${period}_${level}_users`] = r[`s_${period}_${level}_users`];
      behavior[`${period}_${level}_users`] = r[`h_${period}_${level}_users`];
    });
    BEHAVIOR_TAGS.forEach(([level]) => {
      behavior[`${period}_${level}_sessions`] = r[`h_${period}_${level}_sessions`];
    });
  });

  return { totalsRows: [totals], bucketRows, visitorRows: [visitors], behaviorRows: [behavior] };
}

// `live` (optional): { sessions: [{ actorId, level }], closedBest: Map, truncated } from the open-session
// cursors, merged in at each session's current level (see intentLiveSessions.js).
function buildBehavior(rows, live = null) {
  const row = rows?.[0] || {};
  // same shape as a score bucket row, so buildKpis can be reused
  let byLevel = {};
  INTENT_LEVELS.forEach((level) => {
    byLevel[level] = {
      cur_users: num(row[`cur_${level}_users`]),
      cur_sessions: num(row[`cur_${level}_sessions`]),
      prev_users: num(row[`prev_${level}_users`]),
      prev_sessions: num(row[`prev_${level}_sessions`]),
    };
  });
  const liveSessions = live?.sessions || [];
  if (liveSessions.length) byLevel = applyLive(byLevel, liveSessions, live.closedBest);
  byLevel.bot = { cur_sessions: num(row.cur_bot_sessions) };
  const items = INTENT_LEVELS.map((level) => ({
    level,
    users: num(byLevel[level]?.cur_users),
    sessions: num(byLevel[level]?.cur_sessions),
  }));
  const userSum = items.reduce((sum, item) => sum + item.users, 0);
  const sessionSum = items.reduce((sum, item) => sum + item.sessions, 0);
  return {
    available: true,
    rules: BEHAVIOR_RULES,
    distribution: {
      total: userSum,
      totalSessions: sessionSum,
      botsExcluded: num(byLevel.bot?.cur_sessions),
      items: items.map((item) => ({
        ...item,
        pct: safePct(item.users, userSum),
        sessionsPct: safePct(item.sessions, sessionSum),
      })),
    },
    // same card shape as the score-based KPIs, for the three intent cards only
    kpis: buildKpis({}, byLevel).filter((kpi) => INTENT_LEVELS.includes(kpi.id)),
    live: { sessions: liveSessions.length, truncated: Boolean(live?.truncated) },
  };
}

// Open sessions (intent_actor_cursors: one row per visitor, their latest session) that are still live: last
// event within LIVE_WINDOW_MINUTES of the newest believable cursor time, and started in the period. Time is
// measured against the newest cursor, not the wall clock, because event times are the store's local clock
// and the pipeline may be behind; a cursor stamped further ahead than any clock can be is ignored so one bad
// timestamp cannot become "now". Older open cursors are the backlog the pipeline's sweep is still closing.
function buildLiveSessionsQuery({ curStart, endExclusive }) {
  const believable = `session_id <> '' AND last_event_at <= UTC_TIMESTAMP() + INTERVAL ${FUTURE_TOLERANCE_HOURS} HOUR`;
  return {
    sql: `
      SELECT /*+ MAX_EXECUTION_TIME(${CORE_QUERY_TIMEOUT_MS}) */
        actor_id, session_start, last_event_at, events_seq
      FROM intent_actor_cursors
      WHERE ${believable}
        AND last_event_at >= (
          SELECT MAX(last_event_at) FROM intent_actor_cursors WHERE ${believable}
        ) - INTERVAL ${LIVE_WINDOW_MINUTES} MINUTE
        AND session_start >= ? AND session_start < ?
      ORDER BY last_event_at DESC
      LIMIT ${LIVE_ROW_LIMIT}
    `,
    params: [curStart, endExclusive],
  };
}

// Best closed level (3 high, 2 medium, 1 low) per visitor, for just the visitors with a live session, so a
// visitor is counted once. Bots are left out, as in the main behaviour query. IN lists are chunked.
const CLOSED_BEST_CHUNK = 1000;
function buildClosedBestQueries({ actorIds, curStart, endExclusive }) {
  const queries = [];
  for (let i = 0; i < actorIds.length; i += CLOSED_BEST_CHUNK) {
    queries.push({
      sql: `
        SELECT /*+ MAX_EXECUTION_TIME(${CORE_QUERY_TIMEOUT_MS}) */
          actor_id,
          MAX(CASE lvl WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) AS best_rank
        FROM (
          SELECT actor_id, ${BEHAVIOR_LEVEL_SQL} AS lvl
          FROM intent_sessions
          WHERE actor_id IN (?)
            AND session_start >= ? AND session_start < ?
            AND session_time_spent_ms IS NOT NULL
        ) closed
        WHERE lvl <> 'bot'
        GROUP BY actor_id
      `,
      params: [actorIds.slice(i, i + CLOSED_BEST_CHUNK), curStart, endExclusive],
    });
  }
  return queries;
}

// Total Sessions: ONE canonical definition. A session is a row of intent_sessions (finished: closed by the
// visitor coming back, or by the pipeline's idle-session sweep) or, until it finishes, the visitor's open session
// in intent_actor_cursors. Total = finished rows + open sessions that started in the period. Everything else on the
// page is a part of that: the intent distribution counts the finished sessions without bots plus the live open
// ones, so
//     total = bots + analysed + live + waiting        (waiting = open sessions older than the live window)
// and the card shows each of those. The daily rollup (intent_daily_summary.sessions_started, built the same way by
// the pipeline) only supplies the previous period for the change figure, and is kept as `rollup` to show how far
// behind it is. It used to be COUNT(DISTINCT session_id) over behavioral_events, a different population that
// missed click-only sessions.
//
// Open sessions started in the period, all of them (not only the live window). A range on the indexed
// last_event_at, the same future-time guard as the live query, then session_start picks the ones that began in the
// period. One indexed read, no events table.
function buildOpenSessionsCountQuery({ curStart, endExclusive }) {
  return {
    sql: `
      SELECT /*+ MAX_EXECUTION_TIME(${CORE_QUERY_TIMEOUT_MS}) */
        COUNT(*) AS open_sessions
      FROM intent_actor_cursors
      WHERE session_id <> ''
        AND last_event_at >= ? AND last_event_at <= UTC_TIMESTAMP() + INTERVAL ${FUTURE_TOLERANCE_HOURS} HOUR
        AND session_start >= ? AND session_start < ?
    `,
    params: [curStart, curStart, endExclusive],
  };
}

// The rollup's sessions_started for the period and the one before it (null columns: not filled yet).
function buildSessionsStartedQuery({ prevStart, start, end }) {
  return {
    sql: `
      SELECT
        SUM(CASE WHEN summary_date >= ? THEN sessions_started END) AS cur_started,
        SUM(CASE WHEN summary_date < ? THEN sessions_started END) AS prev_started
      FROM intent_daily_summary
      WHERE summary_date >= ? AND summary_date <= ?
    `,
    params: [start, start, prevStart, end],
  };
}

// `totals`: the finished sessions of the period (cur_visitors_sessions, every row, bots included).
// `openRows`: result of buildOpenSessionsCountQuery, or null when the cursor table is unavailable.
// `liveCount`: open sessions classified at their current level; `bots`: finished bot sessions.
// Returns null when there is nothing to show (no rollup column and no open-session count).
function buildSessionsStarted(rollupRows, totals, liveCount = 0, openRows = null, bots = 0) {
  const row = rollupRows?.[0];
  const rollup = row && row.cur_started != null ? num(row.cur_started) : null;
  const openKnown = Array.isArray(openRows) && openRows.length > 0;
  if (rollup == null && !openKnown) return null;

  const closed = num(totals?.cur_visitors_sessions);
  const live = num(liveCount);
  const open = openKnown ? num(openRows[0].open_sessions) : null;
  // canonical total; when open sessions cannot be read, the rollup is the best figure, never below what is analysed
  const value = open != null ? closed + open : Math.max(rollup, closed + live);
  const waiting = open != null ? Math.max(0, open - live) : 0;
  const botSessions = num(bots);
  const analysed = Math.max(0, closed - botSessions);
  const previous = row && row.prev_started != null ? row.prev_started : null;
  return {
    id: "sessionsStarted",
    label: "Total Sessions",
    value,
    delta: previous == null ? null : pctChange(value, previous),
    closed,
    analysed,
    bots: botSessions,
    live,
    waiting,
    other: open != null ? 0 : Math.max(0, value - closed - live),
    // the rollup's own figure and how far it is behind the live tables (negative: ahead), for reconciliation
    rollup,
    rollupBehind: rollup == null ? null : value - rollup,
    // share of all sessions that already have an analysed (finished) row, and the share the levels cover
    closedPct: Math.min(100, safePct(closed, value)),
    coveredPct: Math.min(100, safePct(analysed + live, value)),
  };
}

function buildTrendQuery({ start, end }) {
  return {
    sql: `
      SELECT
        DATE_FORMAT(summary_date, '%Y-%m-%d') AS date,
        product_views,
        add_to_carts,
        checkout_starts
      FROM intent_daily_summary
      WHERE summary_date >= ? AND summary_date <= ?
      ORDER BY summary_date ASC
    `,
    params: [start, end],
  };
}

// Top products straight from the pipeline's daily rollup (product_behavior_daily): per-day
// views, add-to-carts and checkouts per product, with cart-list checkouts already attributed
// to each product. One indexed query, ordered and limited in SQL, so a sort on any column
// ranks every product (not only the most viewed ones). Refreshed by the pipeline every 15
// minutes.
function buildProductRollupQuery({ start, end, sortKey }) {
  const orderExpr = PRODUCT_SORT_SQL[sortKey] || PRODUCT_SORT_SQL.views;
  return {
    sql: `
      SELECT /*+ MAX_EXECUTION_TIME(${PRODUCT_QUERY_TIMEOUT_MS}) */
        product_id,
        MAX(product_title) AS title,
        SUM(product_views) AS views,
        SUM(add_to_cart_count) AS add_to_cart,
        SUM(checkout_started_count) AS checkouts
      FROM product_behavior_daily
      WHERE summary_date >= ? AND summary_date <= ?
      GROUP BY product_id
      ORDER BY ${orderExpr} DESC, views DESC
      LIMIT ${PRODUCT_RESULT_LIMIT}
    `,
    params: [start, end],
  };
}

function rollupProducts(rows) {
  return (rows || []).map((row) => {
    const id = String(row.product_id);
    const views = num(row.views);
    const checkouts = num(row.checkouts);
    return {
      id,
      name: row.title ? String(row.title) : `Product ${id}`,
      views,
      addToCart: num(row.add_to_cart),
      checkouts,
      cvr: safePct(checkouts, views),
    };
  });
}

// Fallback for brand databases without the rollup table: the raw-event scans.
function buildProductViewsQuery({ start, endExclusive }) {
  return {
    sql: `
      SELECT /*+ MAX_EXECUTION_TIME(${PRODUCT_QUERY_TIMEOUT_MS}) */
        product_id,
        MAX(product_title) AS title,
        SUM(event_name = 'product_viewed') AS views,
        SUM(event_name = 'product_added_to_cart') AS add_to_cart
      FROM behavioral_events
      WHERE event_name IN ('product_viewed', 'product_added_to_cart')
        AND occurred_at >= ? AND occurred_at < ?
        AND product_id IS NOT NULL
      GROUP BY product_id
      ORDER BY views DESC
      LIMIT ${PRODUCT_SCAN_LIMIT}
    `,
    params: [start, endExclusive],
  };
}

// checkout_started rows store product_id as a JSON-like list, e.g. "[123]".
function buildProductCheckoutsQuery({ start, endExclusive }) {
  return {
    sql: `
      SELECT /*+ MAX_EXECUTION_TIME(${PRODUCT_QUERY_TIMEOUT_MS}) */
        product_id,
        COUNT(*) AS checkouts
      FROM behavioral_events
      WHERE event_name = 'checkout_started'
        AND occurred_at >= ? AND occurred_at < ?
        AND product_id IS NOT NULL
      GROUP BY product_id
      LIMIT ${CHECKOUT_PRODUCT_SCAN_LIMIT}
    `,
    params: [start, endExclusive],
  };
}

// "Paths that start with X". The pipeline stores each path's first event in an indexed column (first_event,
// idx_first_event_date), so the filter can use an index instead of cutting every stored sequence apart. Rows written
// before that column was filled have first_event NULL and are matched by their sequence text, so the answer is the
// same while the column is still being filled. `useFirstEvent: false` is the original text-only filter (databases
// without the column).
function firstEventFilter(useFirstEvent, pathStart) {
  return useFirstEvent
    ? {
        sql: "AND (first_event = ? OR (first_event IS NULL AND SUBSTRING_INDEX(sequence, '>', 1) = ?))",
        params: [pathStart, pathStart],
      }
    : { sql: "AND SUBSTRING_INDEX(sequence, '>', 1) = ?", params: [pathStart] };
}

function buildPathsQuery({ start, end, pathStart, useFirstEvent = false }) {
  const filter = firstEventFilter(useFirstEvent, pathStart);
  return {
    sql: `
      SELECT
        sequence,
        SUM(session_count) AS sessions,
        SUM(unique_actor_count) AS users
      FROM behavioral_path_daily
      WHERE summary_date >= ? AND summary_date <= ?
        ${filter.sql}
      GROUP BY sequence_hash, sequence
      ORDER BY sessions DESC
      LIMIT ${PATH_ROW_LIMIT}
    `,
    params: [start, end, ...filter.params],
  };
}

// All sessions that start with the chosen event, used to report how much of
// them the (bounded) path query covers.
function buildPathsTotalQuery({ start, end, pathStart, useFirstEvent = false }) {
  const filter = firstEventFilter(useFirstEvent, pathStart);
  return {
    sql: `
      SELECT SUM(session_count) AS sessions
      FROM behavioral_path_daily
      WHERE summary_date >= ? AND summary_date <= ?
        ${filter.sql}
    `,
    params: [start, end, ...filter.params],
  };
}

function pathFirstEventEnabled(env = process.env) {
  return String(env.INTENT_PATH_FIRST_EVENT || "on").trim().toLowerCase() !== "off";
}

// A brand database without behavioral_path_daily.first_event is not asked for it again for this long.
const FIRST_EVENT_RECHECK_MS = 10 * 60 * 1000;

// Product ids inside checkout rows: "[123]", "[123, 456]" or "123".
function extractProductIds(raw) {
  return String(raw ?? "").match(/\d+/g) || [];
}

function mergeProducts(viewRows, checkoutRows, sortKey) {
  const byId = new Map();
  (viewRows || []).forEach((row) => {
    const id = String(row.product_id);
    byId.set(id, {
      id,
      name: row.title ? String(row.title) : `Product ${id}`,
      views: num(row.views),
      addToCart: num(row.add_to_cart),
      checkouts: 0,
    });
  });
  // A checkout with several products counts once for each of them.
  (checkoutRows || []).forEach((row) => {
    extractProductIds(row.product_id).forEach((id) => {
      const product = byId.get(id);
      if (product) product.checkouts += num(row.checkouts);
    });
  });
  return Array.from(byId.values())
    .map((product) => ({ ...product, cvr: safePct(product.checkouts, product.views) }))
    .sort((a, b) => b[sortKey] - a[sortKey] || b.views - a.views)
    .slice(0, PRODUCT_RESULT_LIMIT);
}

// Turns recorded event sequences ("a>b>c") into step-by-step nodes and links.
// A session whose sequence ends before the last step flows into "exit".
function buildPaths(rows, { topN = PATH_BRANCHES_PER_STEP, steps: stepCount = PATH_STEPS_DEFAULT } = {}) {
  const nodeIndex = new Map();
  const nodes = [];
  const linkMap = new Map();

  const ensureNode = (step, event) => {
    const key = `${step}:${event}`;
    if (!nodeIndex.has(key)) {
      nodeIndex.set(key, nodes.length);
      nodes.push({
        key,
        step,
        state: event,
        name: EVENT_LABELS[event] || event,
        value: 0,
      });
    }
    return nodeIndex.get(key);
  };

  (rows || []).forEach((row) => {
    const sessions = num(row.sessions);
    if (sessions <= 0) return;
    const events = String(row.sequence || "")
      .split(">")
      .map((event) => event.trim())
      .filter(Boolean);
    if (events.length === 0) return;

    const steps = [];
    for (let step = 0; step < stepCount; step += 1) {
      steps.push(step < events.length ? events[step] : "exit");
    }
    steps.forEach((event, step) => {
      nodes[ensureNode(step, event)].value += sessions;
      if (step === 0) return;
      const source = ensureNode(step - 1, steps[step - 1]);
      const target = ensureNode(step, event);
      const key = `${source}>${target}`;
      linkMap.set(key, (linkMap.get(key) || 0) + sessions);
    });
  });

  // Keep the top N nodes per step and the links between kept nodes.
  const kept = new Set();
  for (let step = 0; step < stepCount; step += 1) {
    nodes
      .map((node, idx) => ({ node, idx }))
      .filter(({ node }) => node.step === step)
      .sort((a, b) => b.node.value - a.node.value)
      .slice(0, topN)
      .forEach(({ idx }) => kept.add(idx));
  }

  const remap = new Map();
  const keptNodes = [];
  nodes.forEach((node, idx) => {
    if (!kept.has(idx)) return;
    remap.set(idx, keptNodes.length);
    keptNodes.push({ ...node });
  });

  const links = [];
  linkMap.forEach((value, key) => {
    const [source, target] = key.split(">").map(Number);
    if (remap.has(source) && remap.has(target)) {
      links.push({ source: remap.get(source), target: remap.get(target), value });
    }
  });

  const stepTotals = Array.from({ length: stepCount }, (_, step) =>
    keptNodes.filter((node) => node.step === step).reduce((sum, node) => sum + node.value, 0),
  );
  const decorated = keptNodes.map((node) => ({
    ...node,
    pct: safePct(node.value, stepTotals[node.step]),
  }));

  return {
    nodes: decorated,
    links,
    steps: stepTotals.map((total, step) => ({
      step: step + 1,
      title: step === 0 ? decorated.find((n) => n.step === 0)?.name || "" : "Next Action",
      users: total,
      sessions: total,
    })),
  };
}

// ---- Live paths (product / intent filtered) -----------------------------------------------------------------
// intent_sessions.event_sequence is { "<step>": { "<event_name>": "<event_id>" } }. Events come back in step
// order, with the id of each one, so a journey can start at one specific event (a product's PDP view).
function parseEventSequence(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const ordered = [];
  Object.keys(parsed).forEach((key) => {
    const step = Number.parseInt(key, 10);
    const sub = parsed[key];
    if (!Number.isFinite(step) || !sub || typeof sub !== "object") return;
    const name = Object.keys(sub)[0];
    if (!name || !String(name).trim()) return;
    ordered.push({ step, name: String(name).trim(), id: sub[name] == null ? "" : String(sub[name]) });
  });
  return ordered.sort((a, b) => a.step - b.step);
}

// The event names of one session's journey, consecutive duplicates collapsed and capped at the rollup's
// 15 steps. `fromEventId` starts the journey at that event (null when the session does not contain it).
function pathFromSequence(raw, { fromEventId = null, maxSteps = PATH_SEQUENCE_MAX_STEPS } = {}) {
  let events = parseEventSequence(raw);
  if (fromEventId !== null) {
    const at = events.findIndex((event) => event.id === String(fromEventId));
    if (at < 0) return null;
    events = events.slice(at);
  }
  const names = [];
  for (const event of events) {
    if (names[names.length - 1] === event.name) continue;
    names.push(event.name);
    if (names.length >= maxSteps) break;
  }
  return names;
}

// The intent level filter of a session query. The level is only ever bound as a parameter; the SQL
// pieces are constants. Same rules as the KPI cards and the overlap card.
function buildPathLevelFilter({ basis, intent }) {
  if (!INTENT_LEVELS.includes(intent)) return { sql: "", params: [] };
  if (basis === "score") {
    return { sql: "AND intent_status = 'scored' AND intent_bucket = ?", params: [intent] };
  }
  return {
    sql: `AND session_time_spent_ms IS NOT NULL AND ${BEHAVIOR_LEVEL_SQL} = ?`,
    params: [intent],
  };
}

// Product ids are numeric Shopify ids; anything else is rejected. The rollup normalises "123.0" to "123",
// so both spellings are matched.
function normalizePathProductId(raw) {
  const value = String(raw ?? "").trim().replace(/\.0$/, "");
  return /^\d{1,20}$/.test(value) ? value : null;
}

function clampPathSteps(raw) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return PATH_STEPS_DEFAULT;
  return Math.min(PATH_STEPS_MAX, Math.max(PATH_STEPS_MIN, value));
}

// First product_viewed event of a product per session, in the range.
function buildPathProductEventsQuery({ start, endExclusive, productId }) {
  return {
    sql: `
      SELECT /*+ MAX_EXECUTION_TIME(${CORE_QUERY_TIMEOUT_MS}) */
        event_id,
        session_id
      FROM behavioral_events
      WHERE event_name = 'product_viewed'
        AND product_id IN (?, ?)
        AND occurred_at >= ? AND occurred_at < ?
        AND session_id IS NOT NULL
      ORDER BY occurred_at, id
      LIMIT ${PATH_LIVE_EVENT_CAP}
    `,
    params: [productId, `${productId}.0`, start, endExclusive],
  };
}

function buildPathSessionsByIdQuery({ sessionIds, level }) {
  const marks = sessionIds.map(() => "?").join(", ");
  return {
    sql: `
      SELECT /*+ MAX_EXECUTION_TIME(${CORE_QUERY_TIMEOUT_MS}) */
        session_id,
        event_sequence
      FROM intent_sessions
      WHERE session_id IN (${marks})
        ${level.sql}
    `,
    params: [...sessionIds, ...level.params],
  };
}

// Sessions of the range, oldest first, one chunk at a time (keyset: the last row of the previous chunk).
function buildPathSessionScanQuery({ start, endExclusive, level, after }) {
  const keyset = after ? "AND (session_start > ? OR (session_start = ? AND id > ?))" : "";
  return {
    sql: `
      SELECT /*+ MAX_EXECUTION_TIME(${CORE_QUERY_TIMEOUT_MS}) */
        id,
        session_start,
        event_sequence
      FROM intent_sessions
      WHERE session_start >= ? AND session_start < ?
        ${level.sql}
        ${keyset}
      ORDER BY session_start, id
      LIMIT ${PATH_LIVE_CHUNK}
    `,
    params: [start, endExclusive, ...level.params, ...(after ? [after.start, after.start, after.id] : [])],
  };
}

// Top products as the inventory pipeline caches them (Redis `inventory_top_product_sales:<shop>`).
function parseTopProductsCache(raw, limit) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.products) ? parsed.products : [];
  const seen = new Set();
  const products = [];
  list.forEach((entry) => {
    const rawId = String(entry?.product_id ?? "").replace(/^gid:\/\/shopify\/Product\//, "");
    const id = normalizePathProductId(rawId);
    if (!id || seen.has(id)) return;
    seen.add(id);
    products.push({
      id,
      name: entry?.product_title ? String(entry.product_title) : `Product ${id}`,
      rank: num(entry?.rank) || products.length + 1,
    });
  });
  return products.sort((a, b) => a.rank - b.rank).slice(0, limit);
}

function emptyPaths() {
  return { nodes: [], links: [], steps: [], coverage: null };
}

// Share of the sessions starting with the chosen event that the bounded path
// query actually returned (the long tail of one-off sequences is cut off).
function buildPathCoverage(rows, totalRow) {
  const included = (rows || []).reduce((sum, row) => sum + num(row.sessions), 0);
  const total = Math.max(num(totalRow?.sessions), included);
  return { sessions: included, totalSessions: total, pct: total > 0 ? safePct(included, total) : 100 };
}

// `visitors` (optional, the Score view): exclusive visitor counts per level, one level per visitor (see
// buildScoreVisitorsQuery). Without it the level cards fall back to distinct visitors per bucket.
function buildKpis(totals, buckets, visitors = null) {
  const value = (key, period, unit) => num(totals?.[`${period}_${key}_${unit}`]);
  const bucketValue = (level, period, unit) => num(buckets?.[level]?.[`${period}_${unit}`]);

  return KPI_DEFS.map((def) => {
    const isLevel = INTENT_LEVELS.includes(def.source);
    const read = (period, unit) => {
      if (!isLevel) return value(def.source, period, unit);
      if (unit === "users" && visitors?.[def.source]) return num(visitors[def.source][`${period}_users`]);
      return bucketValue(def.source, period, unit);
    };
    const users = read("cur", "users");
    const sessions = read("cur", "sessions");
    return {
      id: def.id,
      label: def.label,
      tone: def.tone,
      value: users,
      sessions,
      delta: pctChange(users, read("prev", "users")),
      sessionsDelta: pctChange(sessions, read("prev", "sessions")),
    };
  });
}

function buildFunnel(totals) {
  const read = (key, unit) => num(totals?.[`cur_${key}_${unit}`]);
  const base = {
    users: read("productViews", "users"),
    sessions: read("productViews", "sessions"),
  };
  return [
    { id: "product_views", label: "Product Views", key: "productViews" },
    { id: "add_to_cart", label: "Add to Cart", key: "addToCart" },
    { id: "checkouts", label: "Checkouts Started", key: "checkouts" },
  ].map((step) => {
    const users = read(step.key, "users");
    const sessions = read(step.key, "sessions");
    return {
      id: step.id,
      label: step.label,
      users,
      sessions,
      // add-to-cart / checkout visitors are not guaranteed to be a subset of product-view
      // visitors, so cap at 100 rather than show an impossible share
      pct: Math.min(100, safePct(users, base.users)),
      sessionsPct: Math.min(100, safePct(sessions, base.sessions)),
    };
  });
}

// `visitors` (the Score view): one level per visitor, the bucket of their highest-scoring session. Then
// Low + Medium + High is the number of scored visitors, each counted once. Without it (older data) each
// bucket's distinct visitors are used, a visitor with sessions in two buckets is in both, and `visitorBasis`
// says so.
function buildDistribution(totals, buckets, visitors = null) {
  const exclusive = Boolean(visitors);
  const items = INTENT_LEVELS.map((level) => ({
    level,
    users: exclusive ? num(visitors[level]?.cur_users) : num(buckets?.[level]?.cur_users),
    sessions: num(buckets?.[level]?.cur_sessions),
  }));
  const userSum = items.reduce((sum, item) => sum + item.users, 0);
  const sessionSum = items.reduce((sum, item) => sum + item.sessions, 0);
  return {
    total: userSum,
    totalSessions: sessionSum,
    // "best_session": each visitor once, at their highest-scoring session; "per_bucket": see above
    visitorBasis: exclusive ? "best_session" : "per_bucket",
    uniqueScoredUsers: exclusive ? userSum : num(totals?.cur_scored_users),
    items: items.map((item) => ({
      ...item,
      pct: safePct(item.users, userSum),
      sessionsPct: safePct(item.sessions, sessionSum),
    })),
  };
}

function buildConversion(buckets) {
  return INTENT_LEVELS.map((level) => {
    const row = buckets?.[level] || {};
    const users = num(row.cur_users);
    const atc = num(row.cur_atc_users);
    const checkouts = num(row.cur_checkout_users);
    const sessions = num(row.cur_sessions);
    const sessionsAtc = num(row.cur_atc_sessions);
    const sessionsCheckouts = num(row.cur_checkout_sessions);
    return {
      level,
      users,
      atc,
      checkouts,
      rate: safePct(checkouts, users),
      sessions,
      sessionsAtc,
      sessionsCheckouts,
      sessionsRate: safePct(sessionsCheckouts, sessions),
    };
  });
}

// ---- User overlap by UTM source ------------------------------------------------
// Which traffic sources the same visitors arrive through. There are always three circles: Google, Meta and
// Others (every other source, including sessions without a UTM source). Each region is the set of those
// groups a visitor (actor_id) was seen in. Region values are sessions of those visitors, except the
// all-three region, which only counts sessions that reached checkout.
const OVERLAP_BASES = Object.freeze(["behavior", "score"]);
const OVERLAP_SOURCES = Object.freeze([
  { key: "google", label: "Google" },
  { key: "meta", label: "Meta" },
  { key: "others", label: "Others" },
]);
const OVERLAP_TOP_SOURCES = OVERLAP_SOURCES.length;

// Constant SQL, never request input. The same Meta / Google alias sets as adsPerformance.service.js;
// anything else (and no UTM source at all) is 'others'.
function sourceNormalizeSql(column) {
  return `CASE
        WHEN LOWER(TRIM(${column})) IN ('facebook', 'fb', 'instagram', 'ig', 'meta', 'an', 'messenger') THEN 'meta'
        WHEN LOWER(TRIM(${column})) IN ('google', 'youtube', 'gdn', 'adwords') THEN 'google'
        ELSE 'others'
      END`;
}
const SOURCE_NORMALIZE_SQL = sourceNormalizeSql("utm_source");

// INTENT_OVERLAP_SESSION_UTM=on reads each session's own first_utm_source (intent_sessions, written by the pipeline when
// the session closes, migrations/004_session_first_utm.sql) instead of joining behavioral_events. It is OFF until the
// column has been filled for the period being looked at (scripts/backfill_first_utm.py in intent-pipeline): a session
// the pipeline closed before the column existed has no value there and would count as "Others". Check with
// scripts/intent-queries-parity.cjs, then switch it on. A database without the column falls back to the join.
function overlapSessionUtmEnabled(env = process.env) {
  return String(env.INTENT_OVERLAP_SESSION_UTM || "off").trim().toLowerCase() === "on";
}

// One row per session of the range with its source group. `intent` is "all" (every session, like the KPI
// cards) or one level from the INTENT_LEVELS whitelist, applied on the chosen basis and bound as a parameter.
//
// intent_sessions has no UTM columns: utm_source lives on behavioral_events (migration 003, filled by
// pipeline/utm.py), whose session_id is the session's id. A session's source is the utm_source of its first
// event that has one (its landing source); a session whose events carry none is 'others'. Events are read
// for the range plus one day, because a session that starts near the end of the range keeps producing events.
function buildOverlapBase({ basis, intent, curStart, endExclusive, sessionUtm = false }) {
  const filtered = INTENT_LEVELS.includes(intent);
  let levelFilter = "";
  if (filtered) {
    levelFilter =
      basis === "score"
        ? "AND intent_status = 'scored' AND intent_bucket = ?"
        : `AND session_time_spent_ms IS NOT NULL AND ${BEHAVIOR_LEVEL_SQL} = ?`;
  }
  if (sessionUtm) {
    // the session's own first source: one table, no events join
    return {
      sql: `
      SELECT
        actor_id,
        ${sourceNormalizeSql("first_utm_source")} AS src,
        (checkout_started_count > 0) AS checked_out
      FROM intent_sessions
      WHERE session_start >= ? AND session_start < ?
        AND actor_id IS NOT NULL
        ${levelFilter}`,
      params: [curStart, endExclusive, ...(filtered ? [intent] : [])],
    };
  }
  const sql = `
      SELECT
        actor_id,
        ${SOURCE_NORMALIZE_SQL} AS src,
        (checkout_started_count > 0) AS checked_out
      FROM intent_sessions
      LEFT JOIN (
        SELECT
          session_id AS utm_session_id,
          SUBSTRING_INDEX(GROUP_CONCAT(utm_source ORDER BY occurred_at SEPARATOR '\\n'), '\\n', 1) AS utm_source
        FROM behavioral_events
        WHERE occurred_at >= ? AND occurred_at < ?
          AND session_id IS NOT NULL
          AND utm_source IS NOT NULL AND utm_source <> ''
        GROUP BY session_id
      ) first_touch ON first_touch.utm_session_id = intent_sessions.session_id
      WHERE session_start >= ? AND session_start < ?
        AND actor_id IS NOT NULL
        ${levelFilter}`;
  return {
    sql,
    params: [curStart, shiftDays(endExclusive, 1), curStart, endExclusive, ...(filtered ? [intent] : [])],
  };
}

function buildOverlapTopSourcesQuery(base) {
  return {
    sql: `
    SELECT /*+ MAX_EXECUTION_TIME(${CORE_QUERY_TIMEOUT_MS}) */
      src,
      COUNT(*) AS sessions,
      COUNT(DISTINCT actor_id) AS users
    FROM (${base.sql}) base
    GROUP BY src
    ORDER BY sessions DESC, src ASC
    LIMIT ${OVERLAP_TOP_SOURCES}
  `,
    params: base.params,
  };
}

// Sessions are grouped per visitor first (flags for which of the three source groups they appear in), then
// the visitors are grouped by flag combination: one row per Venn region. `sources` is padded to three
// entries with '' (a source group is never empty), so the SQL shape is always the same.
function buildOverlapRegionsQuery(base, sources) {
  const padded = Array.from({ length: OVERLAP_TOP_SOURCES }, (_, i) => sources[i] ?? "");
  return {
    sql: `
    SELECT /*+ MAX_EXECUTION_TIME(${CORE_QUERY_TIMEOUT_MS}) */
      g1, g2, g3,
      COUNT(*) AS users,
      SUM(sessions) AS sessions,
      SUM(checkout_sessions) AS checkout_sessions
    FROM (
      SELECT
        actor_id,
        MAX(src = ?) AS g1,
        MAX(src = ?) AS g2,
        MAX(src = ?) AS g3,
        SUM(src IN (?, ?, ?)) AS sessions,
        SUM(src IN (?, ?, ?) AND checked_out) AS checkout_sessions
      FROM (${base.sql}) base
      GROUP BY actor_id
    ) per_actor
    WHERE sessions > 0
    GROUP BY g1, g2, g3
  `,
    params: [...padded, ...padded, ...padded, ...base.params],
  };
}

// The overlap card in ONE execution of the session / UTM join. The two queries above each ran the whole base
// (the intent_sessions rows joined to the first-touch UTM of behavioral_events), once for the per-source totals
// and once for the Venn regions. The three groups are fixed constants, so one per-visitor pass gives both:
// each visitor's membership flags and per-group session counts, summed per flag combination. The per-source
// totals are then added up from those rows (mapOverlapSources). INTENT_OVERLAP_SINGLE_QUERY=off keeps the
// two-query path.
function overlapSingleQueryEnabled(env = process.env) {
  return String(env.INTENT_OVERLAP_SINGLE_QUERY || "on").trim().toLowerCase() !== "off";
}

function buildOverlapSingleQuery(base) {
  const flags = OVERLAP_SOURCES.map(({ key }, i) => `MAX(src = '${key}') AS g${i + 1}`);
  const counts = OVERLAP_SOURCES.map(({ key }, i) => `SUM(src = '${key}') AS c${i + 1}`);
  const sums = OVERLAP_SOURCES.map((_, i) => `SUM(c${i + 1}) AS c${i + 1}`);
  return {
    sql: `
    SELECT /*+ MAX_EXECUTION_TIME(${CORE_QUERY_TIMEOUT_MS}) */
      g1, g2, g3,
      COUNT(*) AS users,
      SUM(sessions) AS sessions,
      SUM(checkout_sessions) AS checkout_sessions,
      ${sums.join(",\n      ")}
    FROM (
      SELECT
        actor_id,
        ${flags.join(",\n        ")},
        ${counts.join(",\n        ")},
        COUNT(*) AS sessions,
        SUM(checked_out) AS checkout_sessions
      FROM (${base.sql}) base
      GROUP BY actor_id
    ) per_actor
    GROUP BY g1, g2, g3
  `,
    params: base.params,
  };
}

// The per-source totals of the old top-sources query, summed from the region rows: a source's sessions are the sum of
// its per-group counts over every region, and its users are the visitors of every region that includes it.
function mapOverlapSources(rows) {
  const totals = OVERLAP_SOURCES.map(() => ({ sessions: 0, users: 0 }));
  (rows || []).forEach((row) => {
    OVERLAP_SOURCES.forEach((_, i) => {
      totals[i].sessions += num(row[`c${i + 1}`]);
      if (num(row[`g${i + 1}`]) > 0) totals[i].users += num(row.users);
    });
  });
  return OVERLAP_SOURCES.map(({ key, label }, i) => ({ key, label, ...totals[i] }));
}

// Every non-empty combination of the drawn sources, so the response has a stable shape: regions with no
// visitors are returned as zeros rather than left out.
function buildOverlapRegions(sources, rows) {
  const flagKeys = ["g1", "g2", "g3"];
  const byCombo = new Map();
  (rows || []).forEach((row) => {
    const combo = flagKeys.map((key, i) => (num(row[key]) > 0 && sources[i] ? sources[i].key : null));
    const id = combo.filter(Boolean).join("+");
    if (!id) return;
    const previous = byCombo.get(id) || { users: 0, sessions: 0, checkoutSessions: 0 };
    byCombo.set(id, {
      users: previous.users + num(row.users),
      sessions: previous.sessions + num(row.sessions),
      checkoutSessions: previous.checkoutSessions + num(row.checkout_sessions),
    });
  });

  const regions = [];
  const count = sources.length;
  for (let mask = 1; mask < 1 << count; mask += 1) {
    const keys = sources.filter((_, i) => mask & (1 << i)).map((source) => source.key);
    const id = keys.join("+");
    const found = byCombo.get(id) || { users: 0, sessions: 0, checkoutSessions: 0 };
    const kind = keys.length === 1 ? "only" : keys.length === OVERLAP_TOP_SOURCES ? "all" : "overlap";
    regions.push({
      id,
      sources: keys,
      kind,
      users: found.users,
      sessions: found.sessions,
      checkoutSessions: found.checkoutSessions,
      // the all-three region only counts sessions that reached checkout
      value: kind === "all" ? found.checkoutSessions : found.sessions,
    });
  }
  return regions;
}

// ---- Intent report: the page's KPI cards, per day --------------------------------
// The figures of the KPI cards at the top of the page that the report table shows (unique visitors and the
// three intent cards, plus Total Sessions), for every day of a range. Each figure is computed exactly like
// its card: users are distinct actors, sessions are rows, and the intent cards follow the page's basis
// (score buckets, or the behaviour rules). The table shows the sessions of each.
const REPORT_KPI_IDS = Object.freeze(["visitors", "high", "medium", "low"]);

// One row per calendar day, from one scan of intent_sessions grouped per day and actor.
function buildReportQuery({ basis, start, endExclusive }) {
  const levelExpr =
    basis === "score"
      ? `CASE WHEN intent_status = 'scored' AND intent_bucket IN ('high', 'medium', 'low') THEN intent_bucket END`
      : `CASE WHEN session_time_spent_ms IS NULL THEN NULL ELSE ${BEHAVIOR_LEVEL_SQL} END`;
  // score: a visitor counts in every bucket they had a session in; behaviour: once, at their best level
  const levelUsers =
    basis === "score"
      ? { high: "h > 0", medium: "m > 0", low: "l > 0" }
      : { high: "h > 0", medium: "h = 0 AND m > 0", low: "h = 0 AND m = 0 AND l > 0" };

  const outer = ["COUNT(*) AS visitors_users", "COALESCE(SUM(sessions), 0) AS visitors_sessions"];
  [["high", "h"], ["medium", "m"], ["low", "l"]].forEach(([level, col]) => {
    outer.push(
      `COALESCE(SUM(${levelUsers[level]}), 0) AS ${level}_users`,
      `COALESCE(SUM(${col}), 0) AS ${level}_sessions`,
    );
  });

  const sql = `
    SELECT /*+ MAX_EXECUTION_TIME(${CORE_QUERY_TIMEOUT_MS}) */
      report_day,
      ${outer.join(",\n      ")}
    FROM (
      SELECT
        DATE_FORMAT(session_start, '%Y-%m-%d') AS report_day,
        actor_id,
        COUNT(*) AS sessions,
        COALESCE(SUM(lvl = 'high'), 0) AS h,
        COALESCE(SUM(lvl = 'medium'), 0) AS m,
        COALESCE(SUM(lvl = 'low'), 0) AS l
      FROM (
        SELECT
          session_start,
          actor_id,
          ${levelExpr} AS lvl
        FROM intent_sessions
        WHERE session_start >= ? AND session_start < ?
      ) s
      GROUP BY report_day, actor_id
    ) per_actor
    GROUP BY report_day
    ORDER BY report_day
  `;
  return { sql, params: [start, endExclusive] };
}

function buildReportStartedQuery({ start, end }) {
  return {
    sql: `
      SELECT
        DATE_FORMAT(summary_date, '%Y-%m-%d') AS report_day,
        sessions_started
      FROM intent_daily_summary
      WHERE summary_date >= ? AND summary_date <= ?
    `,
    params: [start, end],
  };
}

function readReportKpis(row) {
  const kpis = {};
  REPORT_KPI_IDS.forEach((id) => {
    kpis[id] = { users: num(row?.[`${id}_users`]), sessions: num(row?.[`${id}_sessions`]) };
  });
  return kpis;
}

function eachDate(start, end) {
  const dates = [];
  for (let date = start, guard = 0; date <= end && guard <= MAX_RANGE_DAYS; guard += 1) {
    dates.push(date);
    date = shiftDays(date, 1);
  }
  return dates;
}

// Every date of the range is returned (days without sessions as zeros), oldest first.
function buildReport({ start, end, dayRows, startedRows }) {
  const byDay = new Map((dayRows || []).map((row) => [row.report_day, row]));
  const started = startedRows
    ? new Map(startedRows.map((row) => [row.report_day, row.sessions_started]))
    : null;
  const startedFor = (date) =>
    started && started.get(date) != null ? num(started.get(date)) : null;

  const days = eachDate(start, end).map((date) => ({
    date,
    sessionsStarted: startedFor(date),
    kpis: readReportKpis(byDay.get(date)),
  }));
  return { days };
}

// Small in-process TTL cache (same approach as metricsCacheService's MEM_CACHE).
// The page re-requests the whole payload when the user flips sort / path
// controls, so the heavy SQL results are reused for a short time instead of
// scanning intent_sessions / behavioral_events again. Concurrent identical
// requests share one in-flight query.
const QUERY_CACHE_TTL_MS = 2 * 60 * 1000;
const QUERY_CACHE_MAX = 500;
// A range that has ended long enough ago cannot change any more (sessions close within about 1-2 hours), so its
// numbers are kept 10 minutes instead of 2. Today's range keeps the short lifetime.
const FINAL_RANGE_CACHE_TTL_MS = 10 * 60 * 1000;
const FINAL_RANGE_SETTLE_HOUR = 3;

// The cache lifetime for a query over a range ending on `end` (a "YYYY-MM-DD" store date), or undefined for
// the default. Final when the range ended before yesterday, or ended yesterday and it is already past 03:00.
function rangeCacheTtl(end, timezone = DEFAULT_TIMEZONE, now = new Date()) {
  if (!end) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const today = `${get("year")}-${get("month")}-${get("day")}`;
    const yesterday = shiftDays(today, -1);
    if (end < yesterday) return FINAL_RANGE_CACHE_TTL_MS;
    if (end === yesterday && Number(get("hour")) >= FINAL_RANGE_SETTLE_HOUR) return FINAL_RANGE_CACHE_TTL_MS;
  } catch {
    // unknown timezone: use the default lifetime
  }
  return undefined;
}

function createQueryCache({ ttlMs = QUERY_CACHE_TTL_MS, max = QUERY_CACHE_MAX, now = Date.now } = {}) {
  const entries = new Map();
  // `options.ttlMs` lets one call keep its result longer than the default (a range that has ended and
  // will not change); the check is made by the caller asking, so a short-lived request never sees a stale one.
  return async function cached(key, loader, options = {}) {
    const hit = entries.get(key);
    if (hit && now() - hit.at < (options.ttlMs ?? ttlMs)) return hit.promise;
    const promise = loader();
    entries.set(key, { at: now(), promise });
    if (entries.size > max) entries.delete(entries.keys().next().value);
    try {
      return await promise;
    } catch (err) {
      // never cache a failure
      if (entries.get(key)?.promise === promise) entries.delete(key);
      throw err;
    }
  };
}

function buildIntentFunnelService({ cache = createQueryCache() } = {}) {
  // The cache key includes the brand so results can never cross tenants.
  // The query itself runs through the per-brand limit (see shared/utils/brandLimiter.js); a cached answer
  // never waits for a slot.
  async function select(conn, { sql, params }, brandKey, options = {}) {
    const run = () =>
      runLimited(brandKey, () => conn.query(sql, { type: QueryTypes.SELECT, replacements: params }));
    if (!brandKey) return run();
    return cache(`${brandKey}|${sql}|${JSON.stringify(params)}`, run, { ttlMs: options.ttlMs });
  }

  // The path list and its total for one start event. Uses the indexed first_event column when the brand database has it
  // and falls back to the sequence text when it has not (the unknown-column error is the signal; the brand is then
  // not asked again for FIRST_EVENT_RECHECK_MS). Timeouts and missing tables are handled like any optional section.
  const firstEventMissingUntil = new Map();
  const sessionUtmMissingUntil = new Map(); // brand -> until when intent_sessions.first_utm_source is not asked for
  async function selectPaths(conn, { start, end, pathStart }, meta, brandKey, cacheOptions) {
    const skipNew = !pathFirstEventEnabled() || (brandKey && (firstEventMissingUntil.get(brandKey) || 0) > Date.now());
    if (!skipNew) {
      const [pathsRes, totalRes] = await Promise.all([
        selectOptional(conn, buildPathsQuery({ start, end, pathStart, useFirstEvent: true }), "paths", meta, brandKey, cacheOptions),
        selectOptional(conn, buildPathsTotalQuery({ start, end, pathStart, useFirstEvent: true }), "paths", meta, brandKey, cacheOptions),
      ]);
      const missing = meta.sections.paths?.reason === "schema_unsupported";
      if (!missing) return { pathsRes, totalRes };
      delete meta.sections.paths;
      if (brandKey) firstEventMissingUntil.set(brandKey, Date.now() + FIRST_EVENT_RECHECK_MS);
    }
    const [pathsRes, totalRes] = await Promise.all([
      selectOptional(conn, buildPathsQuery({ start, end, pathStart }), "paths", meta, brandKey, cacheOptions),
      selectOptional(conn, buildPathsTotalQuery({ start, end, pathStart }), "paths", meta, brandKey, cacheOptions),
    ]);
    return { pathsRes, totalRes };
  }

  // Optional sections degrade instead of failing the whole page.
  async function selectOptional(conn, query, label, meta, brandKey, options) {
    try {
      return { ok: true, rows: await select(conn, query, brandKey, options) };
    } catch (err) {
      if (isMissingTable(err) || isSchemaMismatch(err)) {
        meta.sections[label] = {
          available: false,
          reason: isMissingTable(err) ? "table_missing" : "schema_unsupported",
        };
        return { ok: false, rows: [] };
      }
      if (isQueryTimeout(err)) {
        logger.warn(`[intent-funnel] ${label} query timed out`);
        meta.sections[label] = { available: false, reason: "timeout" };
        return { ok: false, rows: [] };
      }
      throw err;
    }
  }

  async function getIntentFunnel(spec) {
    const { conn, start, end, brandKey } = spec;
    const timezone = normalizeTimezone(spec.timezone || DEFAULT_TIMEZONE);
    const sortKey = PRODUCT_SORTS[spec.sort] || PRODUCT_SORTS.views;
    const pathStart = PATH_STARTS.includes(spec.pathStart) ? spec.pathStart : PATH_STARTS[0];
    const topN = Math.min(
      PATH_TOP_MAX,
      Math.max(PATH_TOP_MIN, Number.parseInt(spec.pathTop, 10) || PATH_BRANCHES_PER_STEP),
    );
    const pathSteps = clampPathSteps(spec.pathSteps);
    const intent = INTENT_FILTERS.includes(spec.intent) ? spec.intent : "all";

    const length = daysInclusive(start, end);
    const endExclusive = shiftDays(end, 1);
    const prevStart = shiftDays(start, -length);
    const range = { start, end };
    const previousRange = { start: prevStart, end: shiftDays(start, -1) };

    const meta = {
      timezone,
      range,
      previousRange,
      available: true,
      sections: {},
      sources: {
        kpis: "intent_sessions",
        funnel: "intent_sessions",
        distribution: "intent_sessions",
        behavior: "intent_sessions",
        scoreVisitors: "intent_sessions",
        // finished rows + open sessions; the rollup only supplies the previous period
        sessionsStarted: "intent_sessions + intent_actor_cursors",
        conversion: "intent_sessions",
        trend: "intent_daily_summary",
        // refreshed by the pipeline every 15 minutes; raw behavioral_events only as a
        // fallback for databases without the rollup table
        topProducts: "product_behavior_daily",
        paths: "behavioral_path_daily",
      },
      // behavioral_path_daily has no intent bucket and cannot be joined to
      // intent_sessions, so path exploration is always for all users.
      intentFilterSupported: false,
    };

    const filters = { start, end, intent, sort: spec.sort || "views", pathStart, pathTop: topN, pathSteps };
    const base = { filters, meta };

    // Numbers for a range that has ended long ago cannot change, so they are cached longer (see rangeCacheTtl).
    const cacheOptions = { ttlMs: rangeCacheTtl(end, timezone) };

    // Everything starts together: the core scan (one combined query, below) and the optional sections run at
    // the same time instead of in two waves. They share the per-brand query limit, so this does not flood the pool.
    const useCombined = combinedScanEnabled();
    const combinedPromise = useCombined
      ? select(conn, buildCombinedScanQuery({ prevStart, curStart: start, endExclusive }), brandKey, cacheOptions).then(
          (rows) => ({ ok: true, rows }),
          (err) => ({ ok: false, err }),
        )
      : null;

    const optionalPromise = Promise.all([
      selectOptional(conn, buildTrendQuery({ start, end }), "trend", meta, brandKey, cacheOptions),
      selectOptional(conn, buildProductRollupQuery({ start, end, sortKey }), "topProducts", meta, brandKey, cacheOptions),
      // the path controls load their own data (getPaths); this keeps the page payload independent of them
      spec.skipPaths
        ? Promise.resolve({ pathsRes: { ok: true, rows: [] }, totalRes: { ok: true, rows: [] } })
        : selectPaths(conn, { start, end, pathStart }, meta, brandKey, cacheOptions),
      // optional: needs intent_daily_summary.sessions_started, added by the pipeline's rollup
      selectOptional(
        conn,
        buildSessionsStartedQuery({ prevStart, start, end }),
        "sessionsStarted",
        meta,
        brandKey,
        cacheOptions,
      ),
      // optional: the pipeline's open-session table; without it the levels cover closed sessions only
      selectOptional(conn, buildLiveSessionsQuery({ curStart: start, endExclusive }), "liveSessions", meta, brandKey),
      // optional: how many sessions are still open (the canonical Total Sessions = finished rows + these)
      selectOptional(
        conn,
        buildOpenSessionsCountQuery({ curStart: start, endExclusive }),
        "openSessions",
        meta,
        brandKey,
      ),
    ]);
    // a failure is reported where the result is awaited below; this only stops an early return from leaving it unhandled
    optionalPromise.catch(() => {});

    let core;
    let behaviorRes;
    let visitorsRes;
    const combinedRes = combinedPromise ? await combinedPromise : null;
    if (combinedRes?.ok) {
      const mapped = mapCombinedScan(combinedRes.rows?.[0]);
      core = [mapped.totalsRows, mapped.bucketRows];
      behaviorRes = { ok: true, rows: mapped.behaviorRows };
      visitorsRes = { ok: true, rows: mapped.visitorRows };
    } else {
      // Only an older brand database layout (or a missing table) falls back to the separate queries, which
      // answer it the way they always did. A timeout or any other error is a real error.
      if (combinedRes && !(isMissingTable(combinedRes.err) || isSchemaMismatch(combinedRes.err))) {
        throw combinedRes.err;
      }
      try {
        core = await Promise.all([
          select(conn, buildTotalsQuery({ prevStart, curStart: start, endExclusive }), brandKey, cacheOptions),
          select(conn, buildBucketQuery({ prevStart, curStart: start, endExclusive }), brandKey, cacheOptions),
        ]);
      } catch (err) {
        if (isMissingTable(err) || isSchemaMismatch(err)) {
          return {
            ...base,
            meta: {
              ...meta,
              available: false,
              reason: isMissingTable(err) ? "intent_tables_missing" : "intent_schema_unsupported",
            },
            kpis: [],
            funnel: [],
            trend: [],
            distribution: { total: 0, totalSessions: 0, uniqueScoredUsers: 0, items: [] },
            behavior: null,
            sessionsStarted: null,
            conversionRates: [],
            topProducts: [],
            paths: emptyPaths(),
          };
        }
        throw err;
      }
      [behaviorRes, visitorsRes] = await Promise.all([
        // optional: needs intent_exclusion_reason, which older brand databases may not have yet
        selectOptional(
          conn,
          buildBehaviorQuery({ prevStart, curStart: start, endExclusive }),
          "behavior",
          meta,
          brandKey,
          cacheOptions,
        ),
        // Score view visitors: one level per visitor, the bucket of their highest-scoring session
        selectOptional(
          conn,
          buildScoreVisitorsQuery({ prevStart, curStart: start, endExclusive }),
          "scoreVisitors",
          meta,
          brandKey,
          cacheOptions,
        ),
      ]);
    }

    const [trendRes, rollupRes, pathPair, startedRes, liveRes, openRes] = await optionalPromise;
    const pathsRes = pathPair.pathsRes;
    const pathsTotalRes = pathPair.totalRes;
    const scoreVisitors = visitorsRes.ok ? buildScoreVisitors(visitorsRes.rows) : null;

    // Live (not yet closed) sessions, at their current level. Their visitors' best closed level comes from a
    // second, uncached lookup for just those visitors.
    let live = null;
    if (liveRes.ok && behaviorRes.ok) {
      const sessions = classifyOpenSessions(liveRes.rows);
      const closedBest = new Map();
      const actorIds = [...new Set(sessions.map((s) => s.actorId))];
      if (actorIds.length) {
        const lookups = await Promise.all(
          buildClosedBestQueries({ actorIds, curStart: start, endExclusive }).map((query) =>
            selectOptional(conn, query, "liveSessions", meta, null),
          ),
        );
        lookups.forEach((res) =>
          (res.rows || []).forEach((r) => closedBest.set(String(r.actor_id), num(r.best_rank))),
        );
      }
      live = { sessions, closedBest, truncated: (liveRes.rows || []).length >= LIVE_ROW_LIMIT };
    }

    // Brand databases without the rollup table fall back to scanning the raw events.
    let topProducts = rollupRes.ok ? rollupProducts(rollupRes.rows) : [];
    if (!rollupRes.ok && meta.sections.topProducts?.reason === "table_missing") {
      delete meta.sections.topProducts;
      meta.sources.topProducts = "behavioral_events";
      const [viewsRes, checkoutsRes] = await Promise.all([
        selectOptional(conn, buildProductViewsQuery({ start, endExclusive }), "topProducts", meta, brandKey),
        selectOptional(conn, buildProductCheckoutsQuery({ start, endExclusive }), "topProducts", meta, brandKey),
      ]);
      topProducts =
        viewsRes.ok && checkoutsRes.ok ? mergeProducts(viewsRes.rows, checkoutsRes.rows, sortKey) : [];
    }

    const totals = core[0]?.[0] || {};
    const buckets = {};
    (core[1] || []).forEach((row) => {
      buckets[row.intent_bucket] = row;
    });

    const behavior = behaviorRes.ok ? buildBehavior(behaviorRes.rows, live) : null;
    const liveCount = live?.sessions?.length || 0;
    const botSessions = behavior?.distribution?.botsExcluded || 0;
    const sessionsStarted =
      startedRes.ok || openRes.ok
        ? buildSessionsStarted(
            startedRes.ok ? startedRes.rows : null,
            totals,
            liveCount,
            openRes.ok ? openRes.rows : null,
            botSessions,
          )
        : null;
    if (sessionsStarted && behavior) {
      // The intent distribution covers analysed + live; what is left of the total is bots (counted, not levelled)
      // and the waiting backlog. Zero means every session is accounted for.
      sessionsStarted.distributionGap =
        sessionsStarted.value -
        sessionsStarted.bots -
        sessionsStarted.waiting -
        sessionsStarted.other -
        behavior.distribution.totalSessions;
    }

    return {
      ...base,
      kpis: buildKpis(totals, buckets, scoreVisitors),
      funnel: buildFunnel(totals),
      trend: (trendRes.rows || []).map((row) => ({
        date: row.date,
        productViews: num(row.product_views),
        addToCart: num(row.add_to_carts),
        checkouts: num(row.checkout_starts),
      })),
      distribution: buildDistribution(totals, buckets, scoreVisitors),
      behavior,
      sessionsStarted,
      conversionRates: buildConversion(buckets),
      topProducts,
      paths: pathsRes.ok
        ? {
            ...buildPaths(pathsRes.rows, { topN, steps: pathSteps }),
            coverage: buildPathCoverage(pathsRes.rows, pathsTotalRes.rows?.[0]),
          }
        : emptyPaths(),
    };
  }

  // Source overlap card: a separate request from the main payload, so the page stays fast and the card can
  // refetch on its own. Brand databases without the UTM columns answer `available: false` instead of failing.
  async function getSourceOverlap(spec) {
    const { conn, start, end, brandKey } = spec;
    const basis = OVERLAP_BASES.includes(spec.basis) ? spec.basis : "behavior";
    const intent = INTENT_FILTERS.includes(spec.intent) ? spec.intent : "all";
    const filters = { start, end, intent, basis };
    const empty = { sources: [], regions: [] };

    const baseArgs = { basis, intent, curStart: start, endExclusive: shiftDays(end, 1) };
    const cacheOptions = { ttlMs: rangeCacheTtl(end) };

    // the session column first (when switched on and the brand has it); the events join otherwise
    if (overlapSessionUtmEnabled() && !(brandKey && (sessionUtmMissingUntil.get(brandKey) || 0) > Date.now())) {
      try {
        return await computeOverlap(buildOverlapBase({ ...baseArgs, sessionUtm: true }));
      } catch (err) {
        if (!isSchemaMismatch(err)) {
          if (isMissingTable(err)) return unavailableOverlap(err);
          throw err;
        }
        if (brandKey) sessionUtmMissingUntil.set(brandKey, Date.now() + FIRST_EVENT_RECHECK_MS);
      }
    }
    return computeOverlap(buildOverlapBase(baseArgs));

    async function computeOverlap(base) {
      try {
        return await overlapFromBase(base);
      } catch (err) {
        if (isMissingTable(err) || isSchemaMismatch(err)) {
          // the caller may still have the events join to fall back to
          if (base.sql.includes("first_utm_source")) throw err;
          return unavailableOverlap(err);
        }
        throw err;
      }
    }

    function unavailableOverlap(err) {
      return {
        filters,
        meta: {
          available: false,
          // an older brand database layout: no intent table, or no utm_source / intent column yet
          reason: isMissingTable(err) ? "intent_tables_missing" : "schema_unsupported",
        },
        ...empty,
      };
    }

    async function overlapFromBase(base) {
      if (overlapSingleQueryEnabled()) {
        const regionRows = await select(conn, buildOverlapSingleQuery(base), brandKey, cacheOptions);
        // no visitors at all in the range (the old top-sources query returned no rows)
        if (!regionRows?.some((row) => num(row.sessions) > 0)) {
          return { filters, meta: { available: true }, ...empty };
        }
        const sources = mapOverlapSources(regionRows);
        return {
          filters,
          meta: { available: true },
          sources,
          regions: buildOverlapRegions(sources, regionRows),
        };
      }
      const topRows = await select(conn, buildOverlapTopSourcesQuery(base), brandKey, cacheOptions);
      if (!topRows?.length) {
        return { filters, meta: { available: true }, ...empty };
      }
      // always the three fixed groups, in a fixed order; a group with no sessions is a zero
      const bySource = new Map(topRows.map((row) => [String(row.src), row]));
      const sources = OVERLAP_SOURCES.map(({ key, label }) => ({
        key,
        label,
        sessions: num(bySource.get(key)?.sessions),
        users: num(bySource.get(key)?.users),
      }));
      const regionRows = await select(
        conn,
        buildOverlapRegionsQuery(
          base,
          sources.map((source) => source.key),
        ),
        brandKey,
        cacheOptions,
      );
      return {
        filters,
        meta: { available: true },
        sources,
        regions: buildOverlapRegions(sources, regionRows),
      };
    }
  }

  // Intent report table: the KPI figures per day. Separate request from the page payload, so the card has
  // its own date range. Older brand databases answer `available: false`.
  async function getIntentReport(spec) {
    const { conn, start, end, brandKey } = spec;
    const basis = OVERLAP_BASES.includes(spec.basis) ? spec.basis : "behavior";
    const filters = { start, end, basis };
    const endExclusive = shiftDays(end, 1);
    const meta = { available: true, sections: {} };

    try {
      const [dayRows, startedRes] = await Promise.all([
        select(conn, buildReportQuery({ basis, start, endExclusive }), brandKey, { ttlMs: rangeCacheTtl(end) }),
        // optional: needs intent_daily_summary.sessions_started, added by the pipeline's rollup
        selectOptional(conn, buildReportStartedQuery({ start, end }), "sessionsStarted", meta, brandKey, {
          ttlMs: rangeCacheTtl(end),
        }),
      ]);
      return {
        filters,
        meta: { available: true, sections: meta.sections },
        ...buildReport({
          start,
          end,
          dayRows,
          startedRows: startedRes.ok ? startedRes.rows : null,
        }),
      };
    } catch (err) {
      if (isMissingTable(err) || isSchemaMismatch(err)) {
        return {
          filters,
          meta: {
            available: false,
            reason: isMissingTable(err) ? "intent_tables_missing" : "schema_unsupported",
          },
          days: [],
        };
      }
      throw err;
    }
  }

  // Funnel Exploration for a product and/or an intent level. Unlike the rollup-backed paths of
  // getIntentFunnel this reads sessions, so it is bounded (see PATH_LIVE_*) and says so in the answer.
  //  - product chosen: every session that viewed that product's PDP in the range; the journey starts at
  //    that PDP view and follows the events after it.
  //  - intent only: the sessions of the range in that intent level whose journey starts with `pathStart`.
  // The result has the same shape as `paths` of getIntentFunnel, so the same Sankey draws it.
  async function getPaths(spec) {
    const { conn, start, end, brandKey } = spec;
    const steps = clampPathSteps(spec.steps);
    const basis = OVERLAP_BASES.includes(spec.basis) ? spec.basis : "behavior";
    const intent = INTENT_FILTERS.includes(spec.intent) ? spec.intent : "all";
    const productId = normalizePathProductId(spec.productId);
    const pathStart = productId
      ? "product_viewed"
      : PATH_STARTS.includes(spec.pathStart)
        ? spec.pathStart
        : PATH_STARTS[0];
    const filters = { start, end, intent, basis, pathStart, steps, productId };
    const level = buildPathLevelFilter({ basis, intent });
    const endExclusive = shiftDays(end, 1);
    const run = ({ sql, params }) => conn.query(sql, { type: QueryTypes.SELECT, replacements: params });

    // No product and no intent level: the daily rollup answers (two cheap indexed queries), exactly the
    // numbers the page payload used to carry. Only a product or an intent level needs the live session read below.
    if (!productId && intent === "all") {
      const cacheOptions = { ttlMs: rangeCacheTtl(end) };
      const meta = { available: true, live: false, sections: {} };
      const { pathsRes, totalRes } = await selectPaths(conn, { start, end, pathStart }, meta, brandKey, cacheOptions);
      if (!pathsRes.ok) {
        return { filters, meta: { ...meta, available: false, reason: meta.sections.paths?.reason || "unavailable" }, paths: emptyPaths() };
      }
      return {
        filters,
        meta,
        paths: {
          ...buildPaths(pathsRes.rows, { topN: PATH_BRANCHES_PER_STEP, steps }),
          coverage: buildPathCoverage(pathsRes.rows, totalRes.rows?.[0]),
        },
      };
    }

    const compute = async () => {
      const counts = new Map();
      let used = 0;
      let scanned = 0;
      let capped = false;
      const add = (names) => {
        if (!names || names.length === 0) return;
        if (!productId && names[0] !== pathStart) return;
        const key = names.slice(0, steps).join(">");
        counts.set(key, (counts.get(key) || 0) + 1);
        used += 1;
      };

      if (productId) {
        const events = await run(buildPathProductEventsQuery({ start, endExclusive, productId }));
        capped = events.length >= PATH_LIVE_EVENT_CAP;
        // the first view of the product in each session is where its journey starts
        const firstView = new Map();
        events.forEach((row) => {
          const sessionId = String(row.session_id);
          if (!firstView.has(sessionId)) firstView.set(sessionId, String(row.event_id));
        });
        const sessionIds = [...firstView.keys()];
        for (let i = 0; i < sessionIds.length; i += PATH_LIVE_BATCH) {
          const batch = sessionIds.slice(i, i + PATH_LIVE_BATCH);
          const rows = await run(buildPathSessionsByIdQuery({ sessionIds: batch, level }));
          rows.forEach((row) => {
            scanned += 1;
            add(
              pathFromSequence(row.event_sequence, {
                fromEventId: firstView.get(String(row.session_id)),
                maxSteps: PATH_SEQUENCE_MAX_STEPS,
              }),
            );
          });
        }
      } else {
        let after = null;
        let lastChunkFull = false;
        while (scanned < PATH_LIVE_SESSION_CAP) {
          const rows = await run(buildPathSessionScanQuery({ start, endExclusive, level, after }));
          if (rows.length === 0) {
            lastChunkFull = false;
            break;
          }
          rows.forEach((row) => {
            scanned += 1;
            add(pathFromSequence(row.event_sequence, { maxSteps: PATH_SEQUENCE_MAX_STEPS }));
          });
          lastChunkFull = rows.length >= PATH_LIVE_CHUNK;
          if (!lastChunkFull) break;
          const last = rows[rows.length - 1];
          after = { start: last.session_start, id: last.id };
        }
        capped = scanned >= PATH_LIVE_SESSION_CAP && lastChunkFull;
      }

      const rows = [...counts.entries()].map(([sequence, sessions]) => ({ sequence, sessions }));
      return { rows, used, scanned, capped };
    };

    try {
      const out = brandKey
        ? await cache(`${brandKey}|paths|${JSON.stringify(filters)}`, compute)
        : await compute();
      return {
        filters,
        meta: { available: true, live: true, capped: out.capped, scannedSessions: out.scanned },
        paths: {
          ...buildPaths(out.rows, { topN: PATH_BRANCHES_PER_STEP, steps }),
          // a capped scan has no known total, so there is no coverage percentage to show
          coverage: out.capped
            ? { sessions: out.used, totalSessions: null, pct: null }
            : { sessions: out.used, totalSessions: out.used, pct: 100 },
          live: true,
          capped: out.capped,
        },
      };
    } catch (err) {
      if (isMissingTable(err) || isSchemaMismatch(err)) {
        return {
          filters,
          meta: {
            available: false,
            reason: isMissingTable(err) ? "intent_tables_missing" : "schema_unsupported",
          },
          paths: emptyPaths(),
        };
      }
      throw err;
    }
  }

  // The product dropdown of the Funnel Exploration: the store's top products as already cached in Redis
  // by the inventory pipeline. `readTopProductsCache(brandKey)` returns the raw cached JSON (or null); it is
  // injected by the controller so this service stays free of Redis. When Redis has nothing for the brand, the
  // top products of the rollup (most viewed in the range) are used instead.
  async function getPathProducts(spec, { readTopProductsCache } = {}) {
    const { conn, start, end, brandKey } = spec;
    const limit = PRODUCT_RESULT_LIMIT;

    let raw = null;
    try {
      raw = readTopProductsCache ? await readTopProductsCache(brandKey) : null;
    } catch (err) {
      logger.warn(`[intent-funnel] top products cache unavailable: ${err?.message}`);
    }
    const cached = parseTopProductsCache(raw, limit);
    if (cached.length > 0) {
      return { source: "redis", products: cached.map(({ id, name }) => ({ id, name })) };
    }

    const meta = { sections: {} };
    const res = await selectOptional(
      conn,
      buildProductRollupQuery({ start, end, sortKey: PRODUCT_SORTS.views }),
      "topProducts",
      meta,
      brandKey,
    );
    const fallback = res.ok ? rollupProducts(res.rows) : [];
    return { source: "rollup", products: fallback.map(({ id, name }) => ({ id, name })) };
  }

  return { getIntentFunnel, getSourceOverlap, getIntentReport, getPaths, getPathProducts };
}

module.exports = {
  buildIntentFunnelService,
  createQueryCache,
  INTENT_LEVELS,
  OVERLAP_BASES,
  INTENT_FILTERS,
  PRODUCT_SORTS,
  PATH_STARTS,
  PATH_TOP_MIN,
  PATH_TOP_MAX,
  PATH_STEPS_MIN,
  PATH_STEPS_MAX,
  PATH_STEPS_DEFAULT,
  MAX_RANGE_DAYS,
  isQueryTimeout,
  rangeCacheTtl,
  isMissingTable,
  isSchemaMismatch,
  normalizePathProductId,
  // exported for unit tests
  _internal: {
    buildTotalsQuery,
    buildBucketQuery,
    buildSessionsStartedQuery,
    buildSessionsStarted,
    buildOpenSessionsCountQuery,
    buildScoreVisitorsQuery,
    buildScoreVisitors,
    buildDistribution,
    buildKpis,
    buildLiveSessionsQuery,
    buildClosedBestQueries,
    buildBehaviorQuery,
    buildBehavior,
    BEHAVIOR_LEVEL_SQL,
    buildTrendQuery,
    buildProductRollupQuery,
    rollupProducts,
    buildProductViewsQuery,
    buildProductCheckoutsQuery,
    buildPathsQuery,
    buildPathsTotalQuery,
    buildCombinedScanQuery,
    mapCombinedScan,
    combinedScanEnabled,
    rangeCacheTtl,
    buildPaths,
    parseEventSequence,
    pathFromSequence,
    buildPathLevelFilter,
    buildPathProductEventsQuery,
    buildPathSessionsByIdQuery,
    buildPathSessionScanQuery,
    parseTopProductsCache,
    clampPathSteps,
    PATH_LIVE_SESSION_CAP,
    PATH_LIVE_EVENT_CAP,
    PATH_LIVE_CHUNK,
    mergeProducts,
    extractProductIds,
    safePct,
    pctChange,
    buildOverlapBase,
    buildOverlapTopSourcesQuery,
    buildOverlapSingleQuery,
    overlapSessionUtmEnabled,
    pathFirstEventEnabled,
    sourceNormalizeSql,
    mapOverlapSources,
    overlapSingleQueryEnabled,
    buildOverlapRegionsQuery,
    buildOverlapRegions,
    SOURCE_NORMALIZE_SQL,
    buildReportQuery,
    buildReport,
    eachDate,
  },
};
