const { QueryTypes } = require("sequelize");
const logger = require("../shared/utils/logger");
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

const PATH_STEPS = 5;
const PATH_TOP_MIN = 3;
const PATH_TOP_MAX = 8;
const PATH_ROW_LIMIT = 500;
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

function buildPathsQuery({ start, end, pathStart }) {
  return {
    sql: `
      SELECT
        sequence,
        SUM(session_count) AS sessions,
        SUM(unique_actor_count) AS users
      FROM behavioral_path_daily
      WHERE summary_date >= ? AND summary_date <= ?
        AND SUBSTRING_INDEX(sequence, '>', 1) = ?
      GROUP BY sequence_hash, sequence
      ORDER BY sessions DESC
      LIMIT ${PATH_ROW_LIMIT}
    `,
    params: [start, end, pathStart],
  };
}

// All sessions that start with the chosen event, used to report how much of
// them the (bounded) path query covers.
function buildPathsTotalQuery({ start, end, pathStart }) {
  return {
    sql: `
      SELECT SUM(session_count) AS sessions
      FROM behavioral_path_daily
      WHERE summary_date >= ? AND summary_date <= ?
        AND SUBSTRING_INDEX(sequence, '>', 1) = ?
    `,
    params: [start, end, pathStart],
  };
}

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
function buildPaths(rows, { topN }) {
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
    for (let step = 0; step < PATH_STEPS; step += 1) {
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
  for (let step = 0; step < PATH_STEPS; step += 1) {
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

  const stepTotals = Array.from({ length: PATH_STEPS }, (_, step) =>
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

// Small in-process TTL cache (same approach as metricsCacheService's MEM_CACHE).
// The page re-requests the whole payload when the user flips sort / path
// controls, so the heavy SQL results are reused for a short time instead of
// scanning intent_sessions / behavioral_events again. Concurrent identical
// requests share one in-flight query.
const QUERY_CACHE_TTL_MS = 2 * 60 * 1000;
const QUERY_CACHE_MAX = 200;

function createQueryCache({ ttlMs = QUERY_CACHE_TTL_MS, max = QUERY_CACHE_MAX, now = Date.now } = {}) {
  const entries = new Map();
  return async function cached(key, loader) {
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.promise;
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
  async function select(conn, { sql, params }, brandKey) {
    const run = () => conn.query(sql, { type: QueryTypes.SELECT, replacements: params });
    if (!brandKey) return run();
    return cache(`${brandKey}|${sql}|${JSON.stringify(params)}`, run);
  }

  // Optional sections degrade instead of failing the whole page.
  async function selectOptional(conn, query, label, meta, brandKey) {
    try {
      return { ok: true, rows: await select(conn, query, brandKey) };
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
      Math.max(PATH_TOP_MIN, Number.parseInt(spec.pathTop, 10) || 5),
    );
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

    const filters = { start, end, intent, sort: spec.sort || "views", pathStart, pathTop: topN };
    const base = { filters, meta };

    const totalsQuery = buildTotalsQuery({ prevStart, curStart: start, endExclusive });
    const bucketQuery = buildBucketQuery({ prevStart, curStart: start, endExclusive });

    let core;
    try {
      core = await Promise.all([
        select(conn, totalsQuery, brandKey),
        select(conn, bucketQuery, brandKey),
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

    const [
      trendRes, rollupRes, pathsRes, pathsTotalRes, behaviorRes, startedRes, liveRes, openRes, visitorsRes,
    ] = await Promise.all([
      selectOptional(conn, buildTrendQuery({ start, end }), "trend", meta, brandKey),
      selectOptional(conn, buildProductRollupQuery({ start, end, sortKey }), "topProducts", meta, brandKey),
      selectOptional(conn, buildPathsQuery({ start, end, pathStart }), "paths", meta, brandKey),
      selectOptional(conn, buildPathsTotalQuery({ start, end, pathStart }), "paths", meta, brandKey),
      // optional: needs intent_exclusion_reason, which older brand databases may not have yet
      selectOptional(
        conn,
        buildBehaviorQuery({ prevStart, curStart: start, endExclusive }),
        "behavior",
        meta,
        brandKey,
      ),
      // optional: needs intent_daily_summary.sessions_started, added by the pipeline's rollup
      selectOptional(
        conn,
        buildSessionsStartedQuery({ prevStart, start, end }),
        "sessionsStarted",
        meta,
        brandKey,
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
      // Score view visitors: one level per visitor, the bucket of their highest-scoring session
      selectOptional(
        conn,
        buildScoreVisitorsQuery({ prevStart, curStart: start, endExclusive }),
        "scoreVisitors",
        meta,
        brandKey,
      ),
    ]);
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
            ...buildPaths(pathsRes.rows, { topN }),
            coverage: buildPathCoverage(pathsRes.rows, pathsTotalRes.rows?.[0]),
          }
        : emptyPaths(),
    };
  }

  return { getIntentFunnel };
}

module.exports = {
  buildIntentFunnelService,
  createQueryCache,
  INTENT_FILTERS,
  PRODUCT_SORTS,
  PATH_STARTS,
  PATH_TOP_MIN,
  PATH_TOP_MAX,
  MAX_RANGE_DAYS,
  isQueryTimeout,
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
    buildPaths,
    mergeProducts,
    extractProductIds,
    safePct,
    pctChange,
  },
};
