#!/usr/bin/env node
/**
 * Rolls page views up into heatmap_page_daily, the table behind the Heatmaps pages list.
 *
 * Each row also holds the sessions that viewed the page at each Behaviour intent level (high / medium / low), taken
 * from the closed sessions in intent_sessions; a page's sessions still open, or bots, are left out of those counts.
 *
 * One row per day, page path and device (desktop / mobile / tablet) with page views and sessions, counted
 * from behavioral_events (event_name = 'page_viewed'). A live count over a week of raw events takes
 * longer than a minute; one day takes about ten seconds, so the dashboard reads this table instead.
 *
 * Usage:
 *   node scripts/heatmap-pages-rollup.cjs --brand BBB                           (yesterday, dry run)
 *   node scripts/heatmap-pages-rollup.cjs --brand BBB --from 2026-10-01 --to 2026-10-29
 *   node scripts/heatmap-pages-rollup.cjs --brand BBB --from 2026-10-01 --to 2026-10-29 --write
 *
 * It is a DRY RUN unless --write is passed: it reads, prints the top pages per day, and writes nothing
 * (it does not even create the table). With --write it creates heatmap_page_daily if it is missing and,
 * for each day, replaces that day's rows in one transaction, so re-running a day is safe.
 *
 *   --read-host <host>   read behavioral_events from another host (for example a read replica). Writes
 *                        always go to the brand's own host from BRANDS_CONFIG.
 *
 * Brand connection settings come from BRANDS_CONFIG in the environment (same JSON as the API uses).
 */

const path = require("path");
const {
  DEVICE_CASE_SQL,
  MAX_PATH_LENGTH,
  normalizePagePath,
} = require("../shared/utils/heatmap");

const MAX_DAYS = 400;
const INSERT_CHUNK = 500;
const READ_TIMEOUT_MS = 120000;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS heatmap_page_daily (
    summary_date DATE NOT NULL,
    page_path VARCHAR(${MAX_PATH_LENGTH}) NOT NULL,
    device_type VARCHAR(10) NOT NULL,
    page_views INT UNSIGNED NOT NULL DEFAULT 0,
    sessions INT UNSIGNED NOT NULL DEFAULT 0,
    high_sessions INT UNSIGNED NOT NULL DEFAULT 0,
    medium_sessions INT UNSIGNED NOT NULL DEFAULT 0,
    low_sessions INT UNSIGNED NOT NULL DEFAULT 0,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (summary_date, page_path, device_type),
    KEY idx_page_date (page_path, summary_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

// The URL without its query string or hash, then without scheme and host, lowercase, no trailing slash
// ("/" for the home page). Same rules as normalizePagePath; the job re-normalises the result in Node.
// No literal question mark may appear in this SQL: the driver would read it as a parameter slot, so the
// "?" that starts a query string is written as CHAR(63).
const URL_WITHOUT_QUERY_SQL = "SUBSTRING_INDEX(SUBSTRING_INDEX(url, CHAR(63), 1), '#', 1)";
const URL_PATH_SQL = `CASE
        WHEN ${URL_WITHOUT_QUERY_SQL} LIKE 'http://%' OR ${URL_WITHOUT_QUERY_SQL} LIKE 'https://%'
          THEN COALESCE(NULLIF(SUBSTRING(${URL_WITHOUT_QUERY_SQL}, LOCATE('/', ${URL_WITHOUT_QUERY_SQL}, 9)), ''), '/')
        ELSE ${URL_WITHOUT_QUERY_SQL}
      END`;
const PAGE_PATH_SQL = `LOWER(CASE
        WHEN TRIM(TRAILING '/' FROM ${URL_PATH_SQL}) = '' THEN '/'
        ELSE TRIM(TRAILING '/' FROM ${URL_PATH_SQL})
      END)`;

// Tables made before the intent columns existed get them added (the rollup is re-run to fill them).
const INTENT_COLUMNS = Object.freeze(["high_sessions", "medium_sessions", "low_sessions"]);
const ADD_INTENT_COLUMNS_SQL = `ALTER TABLE heatmap_page_daily
  ${INTENT_COLUMNS.map((name) => `ADD COLUMN ${name} INT UNSIGNED NOT NULL DEFAULT 0`).join(",\n  ")}`;

// The Behaviour intent level of a closed session: the same rule as BEHAVIOR_LEVEL_SQL in intentFunnelService
// (a parity test keeps them equal). Constant SQL, never request input.
const BEHAVIOR_MIN_DURATION_MS = 5000;
const BEHAVIOR_LEVEL_SQL = `CASE
        WHEN intent_exclusion_reason = 'bot' THEN 'bot'
        WHEN session_time_spent_ms < ${BEHAVIOR_MIN_DURATION_MS} OR (click_count = 0 AND scroll_count = 0) THEN 'low'
        WHEN click_count > 0 AND (add_to_cart_count > 0 OR checkout_started_count > 0) THEN 'high'
        ELSE 'medium'
      END`;

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function addDays(ymd, days) {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function datesBetween(from, to) {
  const dates = [];
  for (let day = from; day <= to && dates.length <= MAX_DAYS; day = addDays(day, 1)) dates.push(day);
  return dates;
}

// Today's date in the stores' timezone (all brand data is in IST).
function todayInIndia(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

function parseArgs(argv, now = new Date()) {
  const options = { brand: "", from: "", to: "", write: false, readHost: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === "--write") options.write = true;
    else if (arg === "--brand") options.brand = next().trim().toUpperCase();
    else if (arg === "--from") options.from = next().trim();
    else if (arg === "--to") options.to = next().trim();
    else if (arg === "--read-host") options.readHost = next().trim();
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.brand) throw new Error("--brand is required (for example --brand BBB)");

  // default: yesterday, the last complete day
  const yesterday = addDays(todayInIndia(now), -1);
  if (!options.from && !options.to) {
    options.from = yesterday;
    options.to = yesterday;
  }
  if (!options.from) options.from = options.to;
  if (!options.to) options.to = options.from;
  if (!isValidDate(options.from) || !isValidDate(options.to)) {
    throw new Error("--from and --to must be dates like 2026-10-29");
  }
  if (options.to < options.from) throw new Error("--to is before --from");
  if (datesBetween(options.from, options.to).length > MAX_DAYS) {
    throw new Error(`At most ${MAX_DAYS} days at a time`);
  }
  return options;
}

// One day of page views, grouped in the database so only a few thousand rows come back. The day is the
// stores' local date, which is how occurred_at is stored.
function buildDayQuery(day) {
  const next = addDays(day, 1);
  return {
    sql: `
      SELECT /*+ MAX_EXECUTION_TIME(${READ_TIMEOUT_MS}) */
        page_path,
        device_type,
        COUNT(*) AS page_views,
        COUNT(DISTINCT session_id) AS sessions
      FROM (
        SELECT
          ${PAGE_PATH_SQL} AS page_path,
          ${DEVICE_CASE_SQL} AS device_type,
          session_id
        FROM behavioral_events
        WHERE event_name = 'page_viewed'
          AND occurred_at >= ? AND occurred_at < ?
      ) views
      WHERE page_path <> '' AND CHAR_LENGTH(page_path) <= ${MAX_PATH_LENGTH}
      GROUP BY page_path, device_type
    `,
    params: [`${day} 00:00:00`, `${next} 00:00:00`],
  };
}

// The sessions that viewed each page on the day, one row per page, device and session. Joined to the intent
// levels in Node (below) rather than in the database: the join over raw events is far too slow.
function buildSessionPagesQuery(day) {
  const next = addDays(day, 1);
  return {
    sql: `
      SELECT /*+ MAX_EXECUTION_TIME(${READ_TIMEOUT_MS}) */
        page_path,
        device_type,
        session_id
      FROM (
        SELECT
          ${PAGE_PATH_SQL} AS page_path,
          ${DEVICE_CASE_SQL} AS device_type,
          session_id
        FROM behavioral_events
        WHERE event_name = 'page_viewed'
          AND occurred_at >= ? AND occurred_at < ?
          AND session_id IS NOT NULL
      ) views
      WHERE page_path <> '' AND CHAR_LENGTH(page_path) <= ${MAX_PATH_LENGTH}
      GROUP BY page_path, device_type, session_id
    `,
    params: [`${day} 00:00:00`, `${next} 00:00:00`],
  };
}

// The Behaviour level of every closed session that started around the day (a session can start the evening
// before). Sessions still open, without a time spent, are not in the answer and stay unclassified.
function buildSessionLevelsQuery(day) {
  return {
    sql: `
      SELECT /*+ MAX_EXECUTION_TIME(${READ_TIMEOUT_MS}) */
        session_id,
        ${BEHAVIOR_LEVEL_SQL} AS level
      FROM intent_sessions
      WHERE session_start >= ? AND session_start < ?
        AND session_time_spent_ms IS NOT NULL
    `,
    params: [`${addDays(day, -1)} 00:00:00`, `${addDays(day, 1)} 00:00:00`],
  };
}

// Sessions per page and device at each level: the key is "device|path", the value the counts. A session
// counts once per page whatever spelling of the path it used. Bots and sessions without a level are left out.
function mergeIntent(pageSessionRows, levelRows) {
  const levels = new Map();
  (levelRows || []).forEach((row) => levels.set(String(row.session_id), String(row.level)));
  const seen = new Map();
  (pageSessionRows || []).forEach((row) => {
    const level = levels.get(String(row.session_id));
    if (level !== "high" && level !== "medium" && level !== "low") return;
    const pagePath = normalizePagePath(row.page_path);
    if (!pagePath) return;
    const key = `${String(row.device_type)}|${pagePath}`;
    const entry = seen.get(key) || { high: new Set(), medium: new Set(), low: new Set() };
    entry[level].add(String(row.session_id));
    seen.set(key, entry);
  });
  const counts = new Map();
  seen.forEach((entry, key) => {
    counts.set(key, { high: entry.high.size, medium: entry.medium.size, low: entry.low.size });
  });
  return counts;
}

// Adds high / medium / low session counts to the merged page rows (zero when a page has none).
function attachIntent(merged, intentCounts) {
  return merged.map((row) => {
    const counts = intentCounts.get(`${row.device}|${row.pagePath}`) || {};
    return { ...row, high: counts.high || 0, medium: counts.medium || 0, low: counts.low || 0 };
  });
}

// Re-normalises the paths in Node (collapses duplicate slashes the SQL leaves alone) and merges rows that
// end up on the same page and device. Sessions of merged rows are summed, which is exact unless one session
// viewed two spellings of the same page.
function mergeRows(rows) {
  const merged = new Map();
  (rows || []).forEach((row) => {
    const pagePath = normalizePagePath(row.page_path);
    if (!pagePath) return;
    const device = String(row.device_type);
    const key = `${device}|${pagePath}`;
    const previous = merged.get(key) || { pagePath, device, views: 0, sessions: 0 };
    previous.views += Number(row.page_views) || 0;
    previous.sessions += Number(row.sessions) || 0;
    merged.set(key, previous);
  });
  return [...merged.values()].sort(
    (a, b) => b.views - a.views || a.pagePath.localeCompare(b.pagePath) || a.device.localeCompare(b.device),
  );
}

function toInsertValues(day, merged) {
  return merged.map((row) => [
    day,
    row.pagePath,
    row.device,
    row.views,
    row.sessions,
    row.high || 0,
    row.medium || 0,
    row.low || 0,
  ]);
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function loadBrand(brandKey) {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
  let brands;
  try {
    brands = JSON.parse(process.env.BRANDS_CONFIG || "[]");
  } catch {
    throw new Error("BRANDS_CONFIG is not valid JSON");
  }
  const brand = (Array.isArray(brands) ? brands : []).find(
    (item) => String(item.key || "").toUpperCase() === brandKey,
  );
  if (!brand) throw new Error(`Brand ${brandKey} is not in BRANDS_CONFIG`);
  return brand;
}

async function connect(brand, hostOverride) {
  const mysql = require("mysql2/promise");
  return mysql.createConnection({
    host: hostOverride || brand.dbHost,
    port: Number(brand.dbPort) || 3306,
    user: brand.dbUser,
    password: brand.dbPass,
    database: brand.dbName,
    connectTimeout: 15000,
  });
}

async function ensureIntentColumns(writeConn) {
  const [rows] = await writeConn.query("SHOW COLUMNS FROM heatmap_page_daily LIKE 'high_sessions'");
  if (rows.length === 0) {
    console.log("[heatmap-rollup] adding the intent columns to heatmap_page_daily");
    await writeConn.query(ADD_INTENT_COLUMNS_SQL);
  }
}

async function writeDay(writeConn, day, merged) {
  await writeConn.beginTransaction();
  try {
    await writeConn.query("DELETE FROM heatmap_page_daily WHERE summary_date = ?", [day]);
    for (const part of chunk(toInsertValues(day, merged), INSERT_CHUNK)) {
      await writeConn.query(
        "INSERT INTO heatmap_page_daily (summary_date, page_path, device_type, page_views, sessions, " +
          "high_sessions, medium_sessions, low_sessions) VALUES ?",
        [part],
      );
    }
    await writeConn.commit();
  } catch (error) {
    await writeConn.rollback();
    throw error;
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  const brand = loadBrand(options.brand);
  const days = datesBetween(options.from, options.to);
  const mode = options.write ? "WRITE" : "DRY RUN (nothing is written; pass --write to save)";
  console.log(`[heatmap-rollup] ${options.brand} ${options.from} -> ${options.to} (${days.length} day(s)) ${mode}`);

  const readConn = await connect(brand, options.readHost);
  const writeConn = options.write ? await connect(brand) : null;
  try {
    if (writeConn) {
      await writeConn.query(CREATE_TABLE_SQL);
      await ensureIntentColumns(writeConn);
    }
    for (const day of days) {
      const query = buildDayQuery(day);
      const [rows] = await readConn.query(query.sql, query.params);
      const pageSessions = buildSessionPagesQuery(day);
      const [pageSessionRows] = await readConn.query(pageSessions.sql, pageSessions.params);
      const sessionLevels = buildSessionLevelsQuery(day);
      const [levelRows] = await readConn.query(sessionLevels.sql, sessionLevels.params);
      const merged = attachIntent(mergeRows(rows), mergeIntent(pageSessionRows, levelRows));
      const views = merged.reduce((sum, row) => sum + row.views, 0);
      console.log(`[heatmap-rollup] ${day}: ${merged.length} page/device rows, ${views} page views`);
      if (!options.write) {
        merged.slice(0, 5).forEach((row) => {
          console.log(
            `    ${String(row.views).padStart(7)}  ${row.device.padEnd(7)} H${row.high} M${row.medium} L${row.low}  ${row.pagePath}`,
          );
        });
      } else {
        await writeDay(writeConn, day, merged);
      }
    }
  } finally {
    await readConn.end();
    if (writeConn) await writeConn.end();
  }
  console.log("[heatmap-rollup] done");
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error("[heatmap-rollup] failed:", error.message);
    process.exit(1);
  });
}

module.exports = {
  ADD_INTENT_COLUMNS_SQL,
  BEHAVIOR_LEVEL_SQL,
  CREATE_TABLE_SQL,
  PAGE_PATH_SQL,
  addDays,
  attachIntent,
  buildDayQuery,
  buildSessionLevelsQuery,
  buildSessionPagesQuery,
  mergeIntent,
  chunk,
  datesBetween,
  isValidDate,
  mergeRows,
  parseArgs,
  todayInIndia,
  toInsertValues,
};
