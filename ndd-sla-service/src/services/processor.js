// Pure processing core for the NDD / SLA report: no I/O, no database, no clock. Everything the worker does to the
// data lives here so the rules can be unit-tested with fixtures and later reused unchanged by a different driver.
//
// MEMORY MODEL (see the plan, sections E and H):
//   pass 1  filterOrders()      streams CSV rows one at a time; keeps ONLY rows that survive every rule, in a Map keyed
//                               by Reference Code (the set "F"). Nothing else is retained.
//   pass 2  createPickedIndex() receives EasyCom shipments one at a time and keeps a pickup time ONLY for codes in F,
//                               so memory is bounded by |F|, never by the size of the EasyCom response.
//   join    joinOrders()        yields output rows lazily (the caller batches them into INSERTs).
//   summary createSummaryAggregator() is an incremental map of (location, date, hour) -> counts.
//
// TIMES: all timestamps handled here are NAIVE WALL-CLOCK values in the report timezone, represented as
// "YYYY-MM-DD HH:mm:ss". The business windows (12 PM, 3 PM) are clock times, so no timezone conversion happens in this
// module; the caller must supply the CSV's Order Date in the same timezone as the windows (open question, see plan K2.2).
// Naive strings compare correctly with plain string comparison, which keeps the hot loop allocation-free.

const LOCATIONS = Object.freeze({
  AJMAL_SONS: "AJMAL_SONS",
  EMIZA_GGN: "EMIZA_GGN",
});

// Normalised (upper-case, single-spaced) source value -> stored enum value.
const LOCATION_BY_SOURCE = Object.freeze({
  "AJMAL & SONS": LOCATIONS.AJMAL_SONS,
  "EMIZA GURGAON": LOCATIONS.EMIZA_GGN,
});

// Compared after lower-casing and turning "_" / "-" into spaces, so "On Hold", "on_hold" and "ON-HOLD" all match.
const EXCLUDED_STATUSES = Object.freeze(new Set(["cancelled", "on hold", "returned"]));

const SLA = Object.freeze({ MET: "MET", BREACHED: "BREACHED" });

class ProcessingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProcessingError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Wall-clock helpers

const pad2 = (n) => String(n).padStart(2, "0");

function formatWall(ms) {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}

// Pure calendar arithmetic: a Date in UTC is used only as a calendar, never as an instant, so the host timezone and DST
// cannot influence the result.
function wallToMs(date, hour, minute, second = 0) {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour, minute, second);
}

function validDateParts(y, m, d, hh, mi, ss) {
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d; // rejects 31 Feb etc.
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;
// "A/B/YYYY h:mm[:ss] [AM|PM]" with "/" or "-" separators; whether A is the day or the month is decided in parseWallTime.
const SLASH_RE = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/;

// Accepts "YYYY-MM-DD HH:mm[:ss[.fff]]" (also with "T"), plus "DD-MM-YYYY" / "MM/DD/YYYY" style values, with optional
// AM/PM. For A/B/YYYY the order is worked out per value: A > 12 means day-first, B > 12 means month-first. When both
// are <= 12 it is ambiguous: "/" is read month-first (the EasyCom export, e.g. 11/18/2026 18:51) and "-" day-first.
// Returns null for anything else, deliberately including: date-only values (no time to put in a window), values with a
// timezone suffix (a wall-clock module must not guess an offset), and impossible dates. The caller counts these as
// invalid rows so they are visible instead of silently mis-bucketed.
function parseWallTime(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let y;
  let m;
  let d;
  let hh;
  let mi;
  let ss;
  let match = ISO_RE.exec(text);
  if (match) {
    [, y, m, d, hh, mi, ss] = match;
  } else if ((match = SLASH_RE.exec(text))) {
    let a;
    let b;
    let meridiem;
    [, a, b, y, hh, mi, ss, meridiem] = match;
    a = Number(a);
    b = Number(b);
    const slash = text.includes("/");
    const monthFirst = a > 12 ? false : b > 12 ? true : slash;
    [m, d] = monthFirst ? [a, b] : [b, a];
    if (meridiem) {
      hh = Number(hh);
      if (hh < 1 || hh > 12) return null;
      hh = (hh % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
    }
  } else {
    return null;
  }
  y = Number(y);
  m = Number(m);
  d = Number(d);
  hh = Number(hh);
  mi = Number(mi);
  ss = Number(ss || 0);
  if (!validDateParts(y, m, d, hh, mi, ss)) return null;
  const date = `${y}-${pad2(m)}-${pad2(d)}`;
  return { date, hour: hh, text: `${date} ${pad2(hh)}:${pad2(mi)}:${pad2(ss)}` };
}

// ---------------------------------------------------------------------------------------------------------------
// Windows

function windowFor(reportDate, start, lengthHours, anchor) {
  const clock = wallToMs(reportDate, start.hour, start.minute);
  const span = lengthHours * 3600 * 1000;
  // anchor "end":   the report date is the date the window ENDS on   -> [D - L h, D)  at the start time-of-day
  // anchor "start": the report date is the date the window STARTS on -> [D, D + L h)
  const startMs = anchor === "end" ? clock - span : clock;
  return { start: formatWall(startMs), end: formatWall(startMs + span) };
}

// rules = config.window ({ anchor, nddStart, otherStart, lengthHours }). Half-open [start, end): an order exactly at
// the end belongs to the NEXT report. These intervals are stored on the run row so every report records what it used.
function computeWindows(reportDate, rules) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(reportDate))) {
    throw new ProcessingError("INVALID_REPORT_DATE", `reportDate must be YYYY-MM-DD, got "${reportDate}"`);
  }
  return {
    ndd: windowFor(reportDate, rules.nddStart, rules.lengthHours, rules.anchor),
    other: windowFor(reportDate, rules.otherStart, rules.lengthHours, rules.anchor),
  };
}

function inWindow(wallText, window) {
  return wallText >= window.start && wallText < window.end;
}

// ---------------------------------------------------------------------------------------------------------------
// Row rules

// Exports often prefix IDs with ` or ' (Excel "keep as text") or wrap them in quotes/spaces; strip those so GoKwik and
// EasyCom codes compare equal.
function normalizeReference(value) {
  return String(value ?? "").replace(/^[\s`'��"=]+|[\s`'��"]+$/g, "");
}

const canonName = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

function normalizeLocation(value) {
  const key = String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  return LOCATION_BY_SOURCE[key] || null;
}

function isExcludedStatus(value) {
  const key = String(value ?? "").trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ").toLowerCase();
  return EXCLUDED_STATUSES.has(key);
}

// "Courier name containing NDD means NDD" (ElasticrunDirectNDD, BlitzNDD). Case-insensitive substring; whether a
// stricter rule is wanted is an open question (plan K2.5).
function isNdd(courier) {
  return /ndd/i.test(String(courier ?? ""));
}

// ---------------------------------------------------------------------------------------------------------------
// Pass 1

function emptyCounts() {
  return {
    rows_in: 0,
    rows_wrong_client: 0,
    rows_wrong_status: 0,
    rows_out_of_window: 0,
    rows_duplicate: 0,
    rows_invalid: 0,
    rows_kept: 0,
  };
}

// rows: any sync or async iterable of objects keyed by the CSV header names. columns: config.columns.
// Returns { kept: Map<referenceCode, compactRow>, counts }. Only surviving rows are retained, and only the fields the
// report needs (never the raw row), which is what keeps memory proportional to |F|.
// Duplicate Reference Codes: the first occurrence wins (the tie-break is an open question, plan K2.4).
async function filterOrders(rows, { windows, columns, maxKeptRows = null, marketplaceColumn = null, marketplaces = [] }) {
  const kept = new Map();
  const allowedChannels = new Set(marketplaces.map(canonName).filter(Boolean));
  const counts = emptyCounts();

  for await (const row of rows) {
    counts.rows_in += 1;

    const location = normalizeLocation(row[columns.clientLocation]);
    if (!location) {
      counts.rows_wrong_client += 1;
      continue;
    }
    // Sales channel (MP Name), only when the file has that column and a channel list is configured. A blank channel is kept.
    if (allowedChannels.size && marketplaceColumn && row[marketplaceColumn] !== undefined) {
      const channel = canonName(row[marketplaceColumn]);
      if (channel && !allowedChannels.has(channel)) {
        counts.rows_wrong_client += 1;
        continue;
      }
    }
    if (isExcludedStatus(row[columns.orderStatus])) {
      counts.rows_wrong_status += 1;
      continue;
    }

    const reference = normalizeReference(row[columns.reference]);
    const orderAt = parseWallTime(row[columns.orderDate]);
    if (!reference || !orderAt) {
      counts.rows_invalid += 1;
      continue;
    }

    const courier = String(row[columns.courier] ?? "").trim();
    const ndd = isNdd(courier);
    if (!inWindow(orderAt.text, ndd ? windows.ndd : windows.other)) {
      counts.rows_out_of_window += 1;
      continue;
    }

    if (kept.has(reference)) {
      counts.rows_duplicate += 1;
      continue;
    }
    if (maxKeptRows !== null && kept.size >= maxKeptRows) {
      throw new ProcessingError(
        "INPUT_TOO_LARGE",
        `More than ${maxKeptRows} qualifying orders (NDD_SLA_MAX_KEPT_ROWS); refusing to continue instead of exhausting memory`,
      );
    }

    kept.set(reference, {
      reference,
      location,
      orderAt: orderAt.text,
      orderDate: orderAt.date,
      orderHour: orderAt.hour,
      courier,
      isNdd: ndd,
    });
  }

  counts.rows_kept = kept.size;
  return { kept, counts };
}

// ---------------------------------------------------------------------------------------------------------------
// Pass 2

// A pickup time that Excel would show as 00-01-1900 (or any year <= 1900 placeholder) is "no pickup", never a real one.
// Anything non-empty that cannot be parsed is also treated as "no pickup" but reported via stats.invalid so a changed
// EasyCom format is noticed instead of silently turning every order into a breach.
function parsePickedAt(value) {
  const text = String(value ?? "").trim();
  if (!text) return { value: null, invalid: false };
  // Any value in the year 1900 is the Excel "no date" placeholder (00-01-1900, 01-01-1900, 1900-01-01 ...), even when
  // it is not a valid calendar date such as day 00.
  if (/(^|\D)1900(\D|$)/.test(text)) return { value: null, invalid: false };
  const parsed = parseWallTime(text);
  if (!parsed) return { value: null, invalid: true };
  return { value: parsed.text, invalid: false };
}

// Memory is bounded by |kept|: a shipment whose Reference Code is not in F is discarded on arrival.
// When one code appears several times, a real pickup beats "none", and between two real ones the earliest is kept
// (first pickup). Both rules are assumptions to confirm (plan K2.4).
function createPickedIndex(kept) {
  const picked = new Map(); // referenceCode -> wall text | null (null = shipment seen, no pickup yet)
  const stats = { shipments_seen: 0, shipments_matched: 0, shipments_invalid_picked_at: 0 };

  function offer(referenceCode, pickedAtRaw) {
    stats.shipments_seen += 1;
    const ref = normalizeReference(referenceCode);
    if (!ref || !kept.has(ref)) return false;
    stats.shipments_matched += 1;

    const { value, invalid } = parsePickedAt(pickedAtRaw);
    if (invalid) stats.shipments_invalid_picked_at += 1;

    if (!picked.has(ref)) {
      picked.set(ref, value);
    } else {
      const current = picked.get(ref);
      if (value && (!current || value < current)) picked.set(ref, value);
    }
    return true;
  }

  return { picked, stats, offer };
}

// ---------------------------------------------------------------------------------------------------------------
// Join + SLA + summary

function slaStatus(pickedAt) {
  return pickedAt ? SLA.MET : SLA.BREACHED; // business rule: no real pickup => breached
}

// Lazily yields one output row per kept order. `picked.has(ref)` false means EasyCom never returned that order at all;
// it is still a breach (no pickup) but is counted separately in stats.unmatched so a missing feed is distinguishable
// from a real breach.
function* joinOrders(kept, picked, stats = {}) {
  stats.unmatched = 0;
  for (const order of kept.values()) {
    const pickedAt = picked.get(order.reference) ?? null; // NULL, never the Excel 1900 placeholder
    if (!picked.has(order.reference)) stats.unmatched += 1;
    yield {
      reference: order.reference,
      location: order.location,
      orderAt: order.orderAt,
      orderDate: order.orderDate,
      orderHour: order.orderHour,
      courier: order.courier,
      isNdd: order.isNdd,
      pickedAt,
      sla: slaStatus(pickedAt),
    };
  }
}

// Incremental (location, orderDate, orderHour) -> counts. A report window spans two calendar dates, so orderDate is part
// of the key; at most locations x dates x 24 entries are ever held.
function createSummaryAggregator() {
  const buckets = new Map();
  let met = 0;
  let breached = 0;

  function add(row) {
    const key = `${row.location}|${row.orderDate}|${row.orderHour}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        location: row.location,
        orderDate: row.orderDate,
        orderHour: row.orderHour,
        met: 0,
        breached: 0,
        total: 0,
      };
      buckets.set(key, bucket);
    }
    if (row.sla === SLA.MET) {
      bucket.met += 1;
      met += 1;
    } else {
      bucket.breached += 1;
      breached += 1;
    }
    bucket.total += 1;
  }

  function rows() {
    return [...buckets.values()].sort(
      (a, b) =>
        a.location.localeCompare(b.location) || a.orderDate.localeCompare(b.orderDate) || a.orderHour - b.orderHour,
    );
  }

  return { add, rows, totals: () => ({ met, breached, total: met + breached }) };
}

// Percentages are derived (never stored) so there is one rounding place. Returns numbers with one decimal; 0/0 -> 0.
function percentages(met, breached) {
  const total = met + breached;
  if (!total) return { metPct: 0, breachedPct: 0 };
  const round1 = (n) => Math.round((n / total) * 1000) / 10;
  return { metPct: round1(met), breachedPct: round1(breached) };
}

module.exports = {
  LOCATIONS,
  SLA,
  ProcessingError,
  computeWindows,
  createPickedIndex,
  createSummaryAggregator,
  filterOrders,
  inWindow,
  isExcludedStatus,
  isNdd,
  joinOrders,
  normalizeLocation,
  normalizeReference,
  parsePickedAt,
  parseWallTime,
  percentages,
  slaStatus,
};
