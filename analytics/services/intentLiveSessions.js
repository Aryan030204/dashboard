// Live sessions for the Intent Funnel: the visitors whose latest session has not closed yet.
//
// The pipeline keeps one open-session record per visitor (intent_actor_cursors: session start, last event
// time and the event names so far). A session only becomes an intent_sessions row after 30 minutes of
// silence, so a 2-second bounce would be missing from the intent numbers for 30-55 minutes. Instead these
// open sessions are classified here with the same behaviour rules as the SQL over intent_sessions, at their
// current level, and merged into the counts. A session can only move up (low, medium, high) as it continues,
// and nothing is stored: the level is derived from the current events on every request.
//
// The event-name mapping below must stay equal to _SESSION_EVENT_NAME_COUNTERS in the pipeline's
// pipeline/intent_events.py, which builds the closed rows; the tests pin it.

// 31-minute idle rule plus one ingest cycle (about 25 minutes) before the pipeline's sweep closes a session.
const LIVE_WINDOW_MINUTES = 90;
const LIVE_ROW_LIMIT = 20000;
// No store clock is more than 14 hours ahead of UTC; a later event time is bad data and must not be "now".
const FUTURE_TOLERANCE_HOURS = 14;
const MIN_DURATION_MS = 5000;

const LEVEL_RANK = Object.freeze({ low: 1, medium: 2, high: 3 });
const RANK_LEVEL = Object.freeze({ 1: "low", 2: "medium", 3: "high" });

const EVENT_COUNTERS = Object.freeze({
  page_viewed: "pageViews",
  product_viewed: "productViews",
  click: "clicks",
  product_added_to_cart: "addToCarts",
  checkout_started: "checkouts",
  scroll_depth: "scrolls",
});

// events_seq is {"1": {event_name, ...}, "2": {...}}; the driver may hand it back parsed or as a string.
function parseSequence(value) {
  if (value == null) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  if (Buffer.isBuffer(value)) return parseSequence(value.toString("utf8"));
  return typeof value === "object" ? value : {};
}

function countEvents(sequence) {
  const counts = { pageViews: 0, productViews: 0, clicks: 0, addToCarts: 0, checkouts: 0, scrolls: 0 };
  Object.values(sequence).forEach((step) => {
    const key = EVENT_COUNTERS[String(step?.event_name || "").trim()];
    if (key) counts[key] += 1;
  });
  return counts;
}

// The same rule as BEHAVIOR_LEVEL_SQL in intentFunnelService.js (without the bot case).
function classifyLevel({ durationMs, clicks, scrolls, productViews, addToCarts, checkouts }) {
  if (durationMs < MIN_DURATION_MS || (clicks === 0 && scrolls === 0)) return "low";
  if (clicks > 0 && (productViews > 0 || addToCarts > 0 || checkouts > 0)) return "high";
  return "medium";
}

function toMs(value) {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// One cursor row -> { actorId, level }, or null when the row cannot be read.
function classifyOpenSession(row) {
  const start = toMs(row?.session_start);
  const last = toMs(row?.last_event_at);
  if (!row?.actor_id || start == null || last == null) return null;
  const counts = countEvents(parseSequence(row.events_seq));
  return {
    actorId: String(row.actor_id),
    level: classifyLevel({ durationMs: Math.max(0, last - start), ...counts }),
  };
}

function classifyOpenSessions(rows) {
  return (rows || []).map(classifyOpenSession).filter(Boolean);
}

// Adds live sessions to per-level counts shaped { high: { cur_users, cur_sessions, ... }, medium, low }.
// Sessions add one each. A visitor is counted once, at the better of their live level and the best level of
// their closed sessions in the period (`closedBest`: Map of actor id -> 1|2|3), moving between levels when
// the live one is higher. Returns new objects; the input is not changed.
function applyLive(byLevel, liveSessions, closedBest = new Map()) {
  const out = {};
  Object.keys(byLevel).forEach((level) => {
    out[level] = { ...byLevel[level] };
  });

  const bestLiveByActor = new Map();
  (liveSessions || []).forEach(({ actorId, level }) => {
    if (!out[level]) return;
    out[level].cur_sessions = (out[level].cur_sessions || 0) + 1;
    const rank = LEVEL_RANK[level];
    if (rank > (bestLiveByActor.get(actorId) || 0)) bestLiveByActor.set(actorId, rank);
  });

  bestLiveByActor.forEach((liveRank, actorId) => {
    const closedRank = closedBest.get(actorId) || 0;
    if (liveRank <= closedRank) return; // their closed sessions already reached this level
    if (closedRank) {
      const from = out[RANK_LEVEL[closedRank]];
      from.cur_users = Math.max(0, (from.cur_users || 0) - 1);
    }
    const to = out[RANK_LEVEL[liveRank]];
    to.cur_users = (to.cur_users || 0) + 1;
  });

  return out;
}

module.exports = {
  LIVE_WINDOW_MINUTES,
  LIVE_ROW_LIMIT,
  FUTURE_TOLERANCE_HOURS,
  MIN_DURATION_MS,
  EVENT_COUNTERS,
  LEVEL_RANK,
  parseSequence,
  countEvents,
  classifyLevel,
  classifyOpenSession,
  classifyOpenSessions,
  applyLive,
};
