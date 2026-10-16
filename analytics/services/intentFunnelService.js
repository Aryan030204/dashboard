const { QueryTypes } = require("sequelize");
const logger = require("../shared/utils/logger");
const {
  DEFAULT_TIMEZONE,
  daysInclusive,
  normalizeTimezone,
  shiftDays,
} = require("../shared/utils/date");

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
    SELECT
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
    SELECT
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

function buildKpis(totals, buckets) {
  const value = (key, period, unit) => num(totals?.[`${period}_${key}_${unit}`]);
  const bucketValue = (level, period, unit) => num(buckets?.[level]?.[`${period}_${unit}`]);

  return KPI_DEFS.map((def) => {
    const isLevel = INTENT_LEVELS.includes(def.source);
    const read = (period, unit) =>
      isLevel ? bucketValue(def.source, period, unit) : value(def.source, period, unit);
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
      pct: safePct(users, base.users),
      sessionsPct: safePct(sessions, base.sessions),
    };
  });
}

function buildDistribution(totals, buckets) {
  const items = INTENT_LEVELS.map((level) => ({
    level,
    users: num(buckets?.[level]?.cur_users),
    sessions: num(buckets?.[level]?.cur_sessions),
  }));
  const userSum = items.reduce((sum, item) => sum + item.users, 0);
  const sessionSum = items.reduce((sum, item) => sum + item.sessions, 0);
  return {
    // distinct scored visitors in the range
    total: num(totals?.cur_scored_users),
    totalSessions: num(totals?.cur_scored_sessions),
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
        conversion: "intent_sessions",
        trend: "intent_daily_summary",
        topProducts: "behavioral_events",
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
          distribution: { total: 0, totalSessions: 0, items: [] },
          conversionRates: [],
          topProducts: [],
          paths: emptyPaths(),
        };
      }
      throw err;
    }

    const [trendRes, viewsRes, checkoutsRes, pathsRes, pathsTotalRes] = await Promise.all([
      selectOptional(conn, buildTrendQuery({ start, end }), "trend", meta, brandKey),
      selectOptional(conn, buildProductViewsQuery({ start, endExclusive }), "topProducts", meta, brandKey),
      selectOptional(conn, buildProductCheckoutsQuery({ start, endExclusive }), "topProducts", meta, brandKey),
      selectOptional(conn, buildPathsQuery({ start, end, pathStart }), "paths", meta, brandKey),
      selectOptional(conn, buildPathsTotalQuery({ start, end, pathStart }), "paths", meta, brandKey),
    ]);

    const totals = core[0]?.[0] || {};
    const buckets = {};
    (core[1] || []).forEach((row) => {
      buckets[row.intent_bucket] = row;
    });

    return {
      ...base,
      kpis: buildKpis(totals, buckets),
      funnel: buildFunnel(totals),
      trend: (trendRes.rows || []).map((row) => ({
        date: row.date,
        productViews: num(row.product_views),
        addToCart: num(row.add_to_carts),
        checkouts: num(row.checkout_starts),
      })),
      distribution: buildDistribution(totals, buckets),
      conversionRates: buildConversion(buckets),
      topProducts:
        viewsRes.ok && checkoutsRes.ok
          ? mergeProducts(viewsRes.rows, checkoutsRes.rows, sortKey)
          : [],
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
  // exported for unit tests
  _internal: {
    buildTotalsQuery,
    buildBucketQuery,
    buildTrendQuery,
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
