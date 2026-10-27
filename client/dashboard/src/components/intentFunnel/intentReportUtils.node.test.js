import test from "node:test";
import assert from "node:assert/strict";
import {
  REPORT_COLUMNS,
  buildPresets,
  buildReportCsv,
  cellDisplay,
  csvEscape,
  formatRangeLabel,
  rawValue,
  sortDaysDescending,
  validateRange,
} from "./intentReportUtils.js";

const kpi = (users, sessions = users) => ({ users, sessions });
const row = {
  sessionsStarted: 1000,
  kpis: {
    visitors: kpi(200, 260),
    high: kpi(20, 25),
    medium: kpi(80, 100),
    low: kpi(100, 135),
    productViews: kpi(100, 140),
    pageViews: kpi(180, 240),
    addToCart: kpi(25, 30),
    checkouts: kpi(5, 6),
  },
};

test("the columns are the KPI cards of the page, Total Sessions first", () => {
  assert.deepEqual(
    REPORT_COLUMNS.map((column) => column.label),
    [
      "Total Sessions",
      "Unique Visitors",
      "High Intent Users",
      "Medium Intent Users",
      "Low Intent Users",
      "Product Page Views",
      "Page Views",
      "Add to Cart",
      "Checkouts Started",
    ],
  );
});

test("rawValue reads visitors or sessions, and Total Sessions as it is", () => {
  assert.equal(rawValue(row, "visitors", "users"), 200);
  assert.equal(rawValue(row, "visitors", "sessions"), 260);
  assert.equal(rawValue(row, "sessionsStarted", "sessions"), 1000);
  assert.equal(rawValue({ kpis: {} }, "visitors", "users"), 0);
  assert.equal(rawValue({ sessionsStarted: null, kpis: {} }, "sessionsStarted", "users"), null);
});

test("count mode shows grouped numbers; a missing Total Sessions shows a dash", () => {
  assert.deepEqual(cellDisplay(row, "visitors", { mode: "count", unit: "users" }), { text: "200", csv: "200" });
  assert.equal(cellDisplay({ ...row, sessionsStarted: 123456 }, "sessionsStarted", {}).text, "1,23,456");
  assert.deepEqual(cellDisplay({ sessionsStarted: null, kpis: {} }, "sessionsStarted", {}), { text: "-", csv: "" });
});

test("percent mode: previous step follows the funnel, share is of unique visitors", () => {
  const prev = { mode: "percent", unit: "users", base: "prevStep" };
  assert.equal(cellDisplay(row, "productViews", prev).text, "50.0%"); // 100 / 200 visitors
  assert.equal(cellDisplay(row, "addToCart", prev).text, "25.0%"); // 25 / 100 product page views
  assert.equal(cellDisplay(row, "checkouts", prev).text, "20.0%"); // 5 / 25 add to cart
  const share = { mode: "percent", unit: "users", base: "share" };
  assert.equal(cellDisplay(row, "addToCart", share).text, "12.5%"); // 25 / 200
  assert.equal(cellDisplay(row, "checkouts", share).text, "2.5%"); // 5 / 200
  assert.equal(cellDisplay(row, "high", share).text, "10.0%"); // 20 / 200
});

test("percent mode keeps Total Sessions and Unique Visitors as counts", () => {
  const options = { mode: "percent", unit: "users", base: "prevStep" };
  assert.equal(cellDisplay(row, "visitors", options).text, "200");
  assert.equal(cellDisplay(row, "sessionsStarted", options).text, "1,000");
});

test("percent mode uses the chosen unit for both parts of the share", () => {
  const options = { mode: "percent", unit: "sessions", base: "share" };
  assert.equal(cellDisplay(row, "checkouts", options).text, "2.3%"); // 6 / 260
});

test("a share is capped at 100 and a zero denominator is a dash", () => {
  const odd = { kpis: { visitors: kpi(10), checkouts: kpi(40) } };
  assert.equal(cellDisplay(odd, "checkouts", { mode: "percent", base: "share" }).text, "100.0%");
  const empty = { kpis: { visitors: kpi(0), checkouts: kpi(3) } };
  assert.equal(cellDisplay(empty, "checkouts", { mode: "percent", base: "share" }).text, "-");
});

test("days are listed newest first without mutating the input", () => {
  const days = [{ date: "2026-10-10" }, { date: "2026-10-12" }, { date: "2026-10-11" }];
  assert.deepEqual(sortDaysDescending(days).map((d) => d.date), ["2026-10-12", "2026-10-11", "2026-10-10"]);
  assert.equal(days[0].date, "2026-10-10");
  assert.deepEqual(sortDaysDescending(null), []);
});

test("range labels read naturally", () => {
  assert.equal(formatRangeLabel("2026-10-20", "2026-10-26"), "Oct 20 - Oct 26, 2026");
  assert.equal(formatRangeLabel("2026-10-26", "2026-10-26"), "Oct 26, 2026");
  assert.equal(formatRangeLabel("2025-12-30", "2026-01-02"), "Dec 30, 2025 - Jan 2, 2026");
  assert.equal(formatRangeLabel("", ""), "Select dates");
});

test("validateRange rejects missing, reversed and over-long ranges", () => {
  assert.equal(validateRange("2026-10-20", "2026-10-26"), "");
  assert.equal(validateRange("2026-10-20", "2026-10-20"), "");
  assert.match(validateRange("", "2026-10-26"), /both dates/);
  assert.match(validateRange("2026-10-26", "2026-10-20"), /before/);
  assert.equal(validateRange("2025-10-26", "2026-10-26"), ""); // 366 days
  assert.match(validateRange("2025-10-25", "2026-10-26"), /at most 366/); // 367 days
});

test("presets end today, except 'Same as page' which keeps the page range", () => {
  const presets = buildPresets("2026-10-26", { start: "2026-10-20", end: "2026-10-22" });
  assert.deepEqual(presets[0], { id: "page", label: "Same as page", start: "2026-10-20", end: "2026-10-22" });
  const week = presets.find((preset) => preset.id === "7d");
  assert.deepEqual([week.start, week.end], ["2026-10-20", "2026-10-26"]);
  presets.forEach((preset) => assert.equal(validateRange(preset.start, preset.end), ""));
});

test("csvEscape quotes commas, quotes and line breaks", () => {
  assert.equal(csvEscape("plain"), "plain");
  assert.equal(csvEscape("a,b"), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape(null), "");
});

test("the CSV has a header, the range row and every day, in the displayed mode", () => {
  const csv = buildReportCsv(
    [
      { label: "Selected range", row },
      { label: "2026-10-26", row },
    ],
    { mode: "percent", unit: "users", base: "share" },
  );
  const lines = csv.split("\r\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], ["Date", ...REPORT_COLUMNS.map((c) => c.label)].join(","));
  // Total Sessions and Unique Visitors stay counts; the others are shares of visitors
  assert.equal(lines[2], "2026-10-26,1000,200,10.0%,40.0%,50.0%,50.0%,90.0%,12.5%,2.5%");
});
