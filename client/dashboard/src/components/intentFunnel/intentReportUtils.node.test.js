import test from "node:test";
import assert from "node:assert/strict";
import {
  REPORT_COLUMNS,
  buildReportCsv,
  buildReportFilename,
  cellDisplay,
  csvEscape,
  formatReportDate,
  sessionValue,
  sortDaysDescending,
  validateRange,
} from "./intentReportUtils.js";

const kpi = (users, sessions) => ({ users, sessions });
const day = {
  date: "2026-10-28",
  sessionsStarted: 15026,
  kpis: {
    visitors: kpi(13034, 15874),
    high: kpi(3965, 4700),
    medium: kpi(819, 1000),
    low: kpi(8251, 10174),
    // KPIs that are not report columns must never leak into the table
    productViews: kpi(8908, 9500),
    pageViews: kpi(13023, 14000),
    addToCart: kpi(1754, 1800),
    checkouts: kpi(1111, 1150),
  },
};

test("the report has exactly six columns in this order, and no other KPI", () => {
  assert.deepEqual(
    REPORT_COLUMNS.map((column) => column.label),
    ["Date", "Total Sessions", "Unique Visitors", "High Intent Users", "Medium Intent Users", "Low Intent Users"],
  );
  const labels = REPORT_COLUMNS.map((column) => column.label).join(" ");
  ["Product", "Page Views", "Add to Cart", "Checkouts", "Orders", "Conversion", "Prev Step"].forEach((word) =>
    assert.ok(!labels.includes(word), word),
  );
});

test("every figure is the session value of its KPI, never the visitor value", () => {
  assert.equal(sessionValue(day, "sessionsStarted"), 15026);
  assert.equal(sessionValue(day, "visitors"), 15874);
  assert.equal(sessionValue(day, "high"), 4700);
  assert.equal(sessionValue(day, "medium"), 1000);
  assert.equal(sessionValue(day, "low"), 10174);
});

test("a missing KPI is zero, but a Total Sessions the rollup has not filled is a dash", () => {
  assert.equal(sessionValue({ kpis: {} }, "visitors"), 0);
  assert.equal(sessionValue(undefined, "high"), 0);
  assert.equal(sessionValue({ sessionsStarted: null, kpis: {} }, "sessionsStarted"), null);
  assert.deepEqual(cellDisplay({ sessionsStarted: null, kpis: {} }, "sessionsStarted"), { text: "-", csv: "" });
  assert.deepEqual(cellDisplay({ sessionsStarted: 0, kpis: {} }, "sessionsStarted"), { text: "0", csv: "0" });
});

test("cells group digits the Indian way on screen and stay plain numbers in the CSV", () => {
  assert.deepEqual(cellDisplay(day, "visitors"), { text: "15,874", csv: "15874" });
  assert.deepEqual(cellDisplay({ kpis: { visitors: kpi(0, 1234567) } }, "visitors"), {
    text: "12,34,567",
    csv: "1234567",
  });
});

test("the date reads like '28 Oct 2026'", () => {
  assert.equal(formatReportDate("2026-10-28"), "28 Oct 2026");
  assert.equal(formatReportDate("2026-01-05"), "5 Jan 2026");
  assert.equal(formatReportDate("nope"), "");
  assert.deepEqual(cellDisplay(day, "date"), { text: "28 Oct 2026", csv: "28 Oct 2026" });
});

test("days are listed newest first without mutating the input", () => {
  const days = [{ date: "2026-10-10" }, { date: "2026-10-12" }, { date: "2026-10-11" }];
  assert.deepEqual(sortDaysDescending(days).map((d) => d.date), ["2026-10-12", "2026-10-11", "2026-10-10"]);
  assert.equal(days[0].date, "2026-10-10");
  assert.deepEqual(sortDaysDescending(null), []);
});

test("validateRange rejects missing, reversed and over-long ranges", () => {
  assert.equal(validateRange("2026-10-20", "2026-10-26"), "");
  assert.equal(validateRange("2026-10-20", "2026-10-20"), "");
  assert.match(validateRange("", "2026-10-26"), /both dates/);
  assert.match(validateRange("2026-10-26", "2026-10-20"), /before/);
  assert.equal(validateRange("2025-10-26", "2026-10-26"), ""); // 366 days
  assert.match(validateRange("2025-10-25", "2026-10-26"), /at most 366/); // 367 days
});

test("csvEscape quotes commas, quotes and line breaks", () => {
  assert.equal(csvEscape("plain"), "plain");
  assert.equal(csvEscape("a,b"), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape(null), "");
});

test("the CSV is the six columns and one row per day, in the order given", () => {
  const csv = buildReportCsv([day, { date: "2026-10-27", sessionsStarted: null, kpis: { visitors: kpi(1, 2) } }]);
  const lines = csv.split("\r\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "Date,Total Sessions,Unique Visitors,High Intent Users,Medium Intent Users,Low Intent Users");
  assert.equal(lines[1], "28 Oct 2026,15026,15874,4700,1000,10174");
  assert.equal(lines[2], "27 Oct 2026,,2,0,0,0");
  lines.forEach((line) => assert.equal(line.split(",").length, 6));
});

test("the file name carries the brand and the selected dates", () => {
  assert.equal(buildReportFilename("BBB", "2026-10-22", "2026-10-28"), "intent-report_BBB_2026-10-22_to_2026-10-28.csv");
});
