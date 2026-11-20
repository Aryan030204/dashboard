const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeWindows,
  createPickedIndex,
  createSummaryAggregator,
  filterOrders,
  isExcludedStatus,
  isNdd,
  joinOrders,
  normalizeLocation,
  parsePickedAt,
  parseWallTime,
  percentages,
  ProcessingError,
} = require("../src/services/processor");

const COLUMNS = {
  reference: "Reference Code",
  clientLocation: "Client Location",
  orderStatus: "Order Status",
  courier: "Courier Name",
  orderDate: "Order Date",
};

const RULES_END = { anchor: "end", nddStart: { hour: 12, minute: 0 }, otherStart: { hour: 15, minute: 0 }, lengthHours: 24 };
const RULES_START = { ...RULES_END, anchor: "start" };

// Illustration only: report date 18 Nov, window ENDS on the report date.
const WINDOWS = computeWindows("2026-11-18", RULES_END);

function row(overrides = {}) {
  return {
    "Reference Code": "REF1",
    "Client Location": "AJMAL & SONS",
    "Order Status": "Confirmed",
    "Courier Name": "Delhivery",
    "Order Date": "2026-11-17 16:00:00",
    ...overrides,
  };
}

const run = (rows, extra = {}) => filterOrders(rows, { windows: WINDOWS, columns: COLUMNS, ...extra });

// ---------------------------------------------------------------------------------------------------------------
test("windows: anchor 'end' makes the report date the day the window ends", () => {
  assert.deepEqual(WINDOWS.ndd, { start: "2026-11-17 12:00:00", end: "2026-11-18 12:00:00" });
  assert.deepEqual(WINDOWS.other, { start: "2026-11-17 15:00:00", end: "2026-11-18 15:00:00" });
});

test("windows: anchor 'start' names the same interval by the day it starts on", () => {
  const w = computeWindows("2026-11-17", RULES_START);
  assert.deepEqual(w.ndd, WINDOWS.ndd);
  assert.deepEqual(w.other, WINDOWS.other);
});

test("windows: month and year boundaries use calendar arithmetic", () => {
  const w = computeWindows("2027-01-01", RULES_END);
  assert.deepEqual(w.ndd, { start: "2026-12-31 12:00:00", end: "2027-01-01 12:00:00" });
  const leap = computeWindows("2028-03-01", RULES_END);
  assert.equal(leap.other.start, "2028-02-29 15:00:00");
});

test("windows: rejects a malformed report date", () => {
  assert.throws(() => computeWindows("18-11-2026", RULES_END), (e) => e.code === "INVALID_REPORT_DATE");
});

// ---------------------------------------------------------------------------------------------------------------
test("NDD window boundaries: start inclusive, end exclusive (12:00)", async () => {
  const rows = [
    row({ "Reference Code": "A", "Courier Name": "BlitzNDD", "Order Date": "2026-11-17 11:59:59" }), // before start
    row({ "Reference Code": "B", "Courier Name": "BlitzNDD", "Order Date": "2026-11-17 12:00:00" }), // start: in
    row({ "Reference Code": "C", "Courier Name": "BlitzNDD", "Order Date": "2026-11-18 11:59:59" }), // last second: in
    row({ "Reference Code": "D", "Courier Name": "BlitzNDD", "Order Date": "2026-11-18 12:00:00" }), // end: out
  ];
  const { kept, counts } = await run(rows);
  assert.deepEqual([...kept.keys()], ["B", "C"]);
  assert.equal(counts.rows_out_of_window, 2);
});

test("non-NDD window boundaries: start inclusive, end exclusive (15:00)", async () => {
  const rows = [
    row({ "Reference Code": "A", "Order Date": "2026-11-17 14:59:59" }),
    row({ "Reference Code": "B", "Order Date": "2026-11-17 15:00:00" }),
    row({ "Reference Code": "C", "Order Date": "2026-11-18 14:59:59" }),
    row({ "Reference Code": "D", "Order Date": "2026-11-18 15:00:00" }),
  ];
  const { kept } = await run(rows);
  assert.deepEqual([...kept.keys()], ["B", "C"]);
});

test("the same timestamp can fall in the non-NDD window but outside the NDD one (13:00)", async () => {
  const rows = [
    row({ "Reference Code": "N", "Courier Name": "ElasticrunDirectNDD", "Order Date": "2026-11-18 13:00:00" }),
    row({ "Reference Code": "O", "Courier Name": "Delhivery", "Order Date": "2026-11-18 13:00:00" }),
  ];
  const { kept } = await run(rows);
  assert.deepEqual([...kept.keys()], ["O"]);
});

test("midnight boundary: 23:59:59 and 00:00:00 land on different order dates with the right hour", async () => {
  const rows = [
    row({ "Reference Code": "LATE", "Order Date": "2026-11-17 23:59:59" }),
    row({ "Reference Code": "EARLY", "Order Date": "2026-11-18 00:00:00" }),
  ];
  const { kept } = await run(rows);
  assert.equal(kept.get("LATE").orderDate, "2026-11-17");
  assert.equal(kept.get("LATE").orderHour, 23);
  assert.equal(kept.get("EARLY").orderDate, "2026-11-18");
  assert.equal(kept.get("EARLY").orderHour, 0);
});

// ---------------------------------------------------------------------------------------------------------------
test("client filter keeps only AJMAL & SONS and Emiza Gurgaon, tolerating case and spacing", async () => {
  const rows = [
    row({ "Reference Code": "1", "Client Location": "AJMAL & SONS" }),
    row({ "Reference Code": "2", "Client Location": "  ajmal  &  sons " }),
    row({ "Reference Code": "3", "Client Location": "Emiza Gurgaon" }),
    row({ "Reference Code": "4", "Client Location": "EMIZA   GURGAON" }),
    row({ "Reference Code": "5", "Client Location": "Emiza Bhiwandi" }),
    row({ "Reference Code": "6", "Client Location": "" }),
  ];
  const { kept, counts } = await run(rows);
  assert.deepEqual([...kept.keys()], ["1", "2", "3", "4"]);
  assert.equal(kept.get("1").location, "AJMAL_SONS");
  assert.equal(kept.get("3").location, "EMIZA_GGN");
  assert.equal(counts.rows_wrong_client, 2);
});

test("normalizeLocation returns null for anything else", () => {
  assert.equal(normalizeLocation("Other"), null);
  assert.equal(normalizeLocation(undefined), null);
});

test("status filter removes Cancelled, On Hold and Returned (any case/separator) and tolerates their absence", async () => {
  const rows = [
    row({ "Reference Code": "1", "Order Status": "Cancelled" }),
    row({ "Reference Code": "2", "Order Status": "ON HOLD" }),
    row({ "Reference Code": "3", "Order Status": "on_hold" }),
    row({ "Reference Code": "4", "Order Status": "Returned" }),
    row({ "Reference Code": "5", "Order Status": "Confirmed" }),
    row({ "Reference Code": "6", "Order Status": "" }),
  ];
  const { kept, counts } = await run(rows);
  assert.deepEqual([...kept.keys()], ["5", "6"]);
  assert.equal(counts.rows_wrong_status, 4);
  assert.equal(isExcludedStatus("Delivered"), false);
});

test("NDD detection: courier name containing NDD, any case", () => {
  assert.equal(isNdd("ElasticrunDirectNDD"), true);
  assert.equal(isNdd("BlitzNDD"), true);
  assert.equal(isNdd("blitzndd"), true);
  assert.equal(isNdd("Delhivery"), false);
  assert.equal(isNdd(""), false);
  assert.equal(isNdd(undefined), false);
});

// ---------------------------------------------------------------------------------------------------------------
test("deduplication: one row per Reference Code, first occurrence wins, counted", async () => {
  const rows = [
    row({ "Reference Code": "DUP", "Order Date": "2026-11-17 16:00:00", "Courier Name": "First" }),
    row({ "Reference Code": "DUP", "Order Date": "2026-11-17 17:00:00", "Courier Name": "Second" }),
    row({ "Reference Code": "DUP", "Order Date": "2026-11-17 18:00:00", "Courier Name": "Third" }),
    row({ "Reference Code": "OTHER" }),
  ];
  const { kept, counts } = await run(rows);
  assert.equal(kept.size, 2);
  assert.equal(kept.get("DUP").courier, "First");
  assert.equal(counts.rows_duplicate, 2);
  assert.equal(counts.rows_kept, 2);
  assert.equal(counts.rows_in, 4);
});

test("a duplicate that is filtered out earlier does not count as a duplicate", async () => {
  const rows = [row({ "Reference Code": "X" }), row({ "Reference Code": "X", "Order Status": "Cancelled" })];
  const { counts } = await run(rows);
  assert.equal(counts.rows_duplicate, 0);
  assert.equal(counts.rows_wrong_status, 1);
});

test("invalid rows are counted, not silently dropped or mis-bucketed", async () => {
  const rows = [
    row({ "Reference Code": "", }),
    row({ "Reference Code": "NODATE", "Order Date": "" }),
    row({ "Reference Code": "DATEONLY", "Order Date": "2026-11-17" }),
    row({ "Reference Code": "TZ", "Order Date": "2026-11-17T16:00:00+05:30" }),
    row({ "Reference Code": "BADDAY", "Order Date": "2026-02-31 10:00:00" }),
    row({ "Reference Code": "GOOD" }),
  ];
  const { kept, counts } = await run(rows);
  assert.deepEqual([...kept.keys()], ["GOOD"]);
  assert.equal(counts.rows_invalid, 5);
});

test("invalid dates on unrelated clients do not add noise to rows_invalid", async () => {
  const { counts } = await run([row({ "Client Location": "Someone Else", "Order Date": "garbage" })]);
  assert.equal(counts.rows_invalid, 0);
  assert.equal(counts.rows_wrong_client, 1);
});

test("maxKeptRows fails fast with INPUT_TOO_LARGE instead of growing without bound", async () => {
  const rows = [row({ "Reference Code": "1" }), row({ "Reference Code": "2" }), row({ "Reference Code": "3" })];
  await assert.rejects(run(rows, { maxKeptRows: 2 }), (e) => e instanceof ProcessingError && e.code === "INPUT_TOO_LARGE");
  const ok = await run(rows, { maxKeptRows: 3 });
  assert.equal(ok.kept.size, 3);
});

test("accepts an async iterable (the streaming CSV case) as well as an array", async () => {
  async function* stream() {
    yield row({ "Reference Code": "S1" });
    yield row({ "Reference Code": "S2" });
  }
  const { kept } = await run(stream());
  assert.deepEqual([...kept.keys()], ["S1", "S2"]);
});

// ---------------------------------------------------------------------------------------------------------------
test("parseWallTime accepts the supported formats and rejects the rest", () => {
  assert.equal(parseWallTime("2026-11-17 16:05:09").text, "2026-11-17 16:05:09");
  assert.equal(parseWallTime("2026-11-17T16:05").text, "2026-11-17 16:05:00");
  assert.equal(parseWallTime("2026-11-17 16:05:09.123").text, "2026-11-17 16:05:09");
  assert.equal(parseWallTime("17-11-2026 16:05").text, "2026-11-17 16:05:00");
  assert.equal(parseWallTime("17/11/2026 9:05:01").text, "2026-11-17 09:05:01");
  assert.equal(parseWallTime("2026-11-17"), null);
  assert.equal(parseWallTime("2026-11-17 24:00:00"), null);
  assert.equal(parseWallTime("2026-11-17 16:00:00Z"), null);
  assert.equal(parseWallTime(""), null);
  assert.equal(parseWallTime(null), null);
});

// ---------------------------------------------------------------------------------------------------------------
test("picked index keeps only Reference Codes that are in F (memory bounded by |F|)", async () => {
  const { kept } = await run([row({ "Reference Code": "IN" })]);
  const index = createPickedIndex(kept);
  assert.equal(index.offer("OUT-1", "2026-11-18 09:00:00"), false);
  assert.equal(index.offer("OUT-2", "2026-11-18 09:00:00"), false);
  assert.equal(index.offer("IN", "2026-11-18 09:00:00"), true);
  assert.equal(index.picked.size, 1);
  assert.deepEqual(index.stats, { shipments_seen: 3, shipments_matched: 1, shipments_invalid_picked_at: 0 });
});

test("no pickup: empty, null and the Excel 1900 placeholder are all NULL, never stored as a date", () => {
  assert.deepEqual(parsePickedAt(""), { value: null, invalid: false });
  assert.deepEqual(parsePickedAt(null), { value: null, invalid: false });
  assert.deepEqual(parsePickedAt("00-01-1900 00:00"), { value: null, invalid: false }); // the Excel placeholder itself
  assert.deepEqual(parsePickedAt("01-01-1900 00:00"), { value: null, invalid: false });
  assert.deepEqual(parsePickedAt("1900-01-01 00:00:00"), { value: null, invalid: false });
  assert.deepEqual(parsePickedAt("2026-11-18 09:30:00"), { value: "2026-11-18 09:30:00", invalid: false });
});

test("a real pickup beats none, and the earliest real pickup wins among duplicates", async () => {
  const { kept } = await run([row({ "Reference Code": "R" })]);
  const index = createPickedIndex(kept);
  index.offer("R", "");
  index.offer("R", "2026-11-18 10:00:00");
  index.offer("R", "2026-11-18 09:00:00");
  index.offer("R", "2026-11-18 11:00:00");
  index.offer("R", "");
  assert.equal(index.picked.get("R"), "2026-11-18 09:00:00");
});

test("an unparseable non-empty pickup is NULL but reported, so a format change is noticed", async () => {
  const { kept } = await run([row({ "Reference Code": "R" })]);
  const index = createPickedIndex(kept);
  index.offer("R", "yesterday-ish");
  assert.equal(index.picked.get("R"), null);
  assert.equal(index.stats.shipments_invalid_picked_at, 1);
});

// ---------------------------------------------------------------------------------------------------------------
test("join + SLA: no pickup => BREACHED (NULL), real pickup => MET, unmatched counted separately", async () => {
  const { kept } = await run([
    row({ "Reference Code": "MET" }),
    row({ "Reference Code": "NOPICK" }),
    row({ "Reference Code": "MISSING" }),
  ]);
  const index = createPickedIndex(kept);
  index.offer("MET", "2026-11-18 08:00:00");
  index.offer("NOPICK", "");
  // "MISSING" is never returned by EasyCom

  const stats = {};
  const out = [...joinOrders(kept, index.picked, stats)];
  const by = Object.fromEntries(out.map((r) => [r.reference, r]));

  assert.equal(by.MET.sla, "MET");
  assert.equal(by.MET.pickedAt, "2026-11-18 08:00:00");
  assert.equal(by.NOPICK.sla, "BREACHED");
  assert.equal(by.NOPICK.pickedAt, null);
  assert.equal(by.MISSING.sla, "BREACHED");
  assert.equal(by.MISSING.pickedAt, null);
  assert.equal(stats.unmatched, 1);
  assert.ok(out.every((r) => r.pickedAt === null || !String(r.pickedAt).includes("1900")));
});

test("hourly aggregation per location, order date and hour, with totals", () => {
  const agg = createSummaryAggregator();
  const mk = (location, orderDate, orderHour, sla) => ({ location, orderDate, orderHour, sla });
  agg.add(mk("AJMAL_SONS", "2026-11-17", 16, "MET"));
  agg.add(mk("AJMAL_SONS", "2026-11-17", 16, "BREACHED"));
  agg.add(mk("AJMAL_SONS", "2026-11-17", 16, "MET"));
  agg.add(mk("AJMAL_SONS", "2026-11-18", 0, "BREACHED"));
  agg.add(mk("EMIZA_GGN", "2026-11-17", 9, "MET"));

  assert.deepEqual(agg.rows(), [
    { location: "AJMAL_SONS", orderDate: "2026-11-17", orderHour: 16, met: 2, breached: 1, total: 3 },
    { location: "AJMAL_SONS", orderDate: "2026-11-18", orderHour: 0, met: 0, breached: 1, total: 1 },
    { location: "EMIZA_GGN", orderDate: "2026-11-17", orderHour: 9, met: 1, breached: 0, total: 1 },
  ]);
  assert.deepEqual(agg.totals(), { met: 3, breached: 2, total: 5 });
});

test("percentages are derived from counts; an empty bucket is 0/0 not NaN", () => {
  assert.deepEqual(percentages(2, 1), { metPct: 66.7, breachedPct: 33.3 });
  assert.deepEqual(percentages(0, 0), { metPct: 0, breachedPct: 0 });
  assert.deepEqual(percentages(5, 0), { metPct: 100, breachedPct: 0 });
});

test("end to end on a small fixture", async () => {
  const rows = [
    row({ "Reference Code": "1", "Order Date": "2026-11-17 16:10:00" }), // AJMAL, non-NDD, in window
    row({ "Reference Code": "2", "Client Location": "Emiza Gurgaon", "Courier Name": "BlitzNDD", "Order Date": "2026-11-18 11:00:00" }),
    row({ "Reference Code": "3", "Order Status": "Cancelled" }),
    row({ "Reference Code": "4", "Client Location": "Other Client" }),
    row({ "Reference Code": "1", "Order Date": "2026-11-17 17:00:00" }), // duplicate
    row({ "Reference Code": "5", "Order Date": "2026-11-18 16:00:00" }), // after the non-NDD window
  ];
  const { kept, counts } = await run(rows);
  assert.deepEqual(counts, {
    rows_in: 6,
    rows_wrong_client: 1,
    rows_wrong_status: 1,
    rows_out_of_window: 1,
    rows_duplicate: 1,
    rows_invalid: 0,
    rows_kept: 2,
  });

  const index = createPickedIndex(kept);
  index.offer("2", "2026-11-18 11:30:00");
  const agg = createSummaryAggregator();
  for (const out of joinOrders(kept, index.picked, {})) agg.add(out);
  assert.deepEqual(agg.totals(), { met: 1, breached: 1, total: 2 });
});

test("US-style slash dates, AM/PM and backtick-prefixed reference codes (real export formats)", () => {
  const P = require("../src/services/processor");
  assert.equal(P.parseWallTime("11/18/2026 18:51").text, "2026-11-18 18:51:00");
  assert.equal(P.parseWallTime("18/11/2026 18:51").text, "2026-11-18 18:51:00");
  assert.equal(P.parseWallTime("18-11-2026 18:51:05").text, "2026-11-18 18:51:05");
  assert.equal(P.parseWallTime("11/19/2026 5:17 PM").text, "2026-11-19 17:17:00");
  assert.equal(P.parseWallTime("11/19/2026 12:05 AM").text, "2026-11-19 00:05:00");
  assert.equal(P.parseWallTime("31/02/2026 10:00"), null);
  assert.equal(P.normalizeReference("`634774"), "634774");
  assert.equal(P.normalizeReference(" '634774 "), "634774");
});
