import test from "node:test";
import assert from "node:assert/strict";
import {
  addMonths, daysInMonth, defaultMonthRange, isPartialMonth, monthLabel, monthOptions, monthRangeDates, withFrom, withTo,
} from "./monthRange.js";

const TODAY = "2026-11-26";

test("default is the current month and the five before it, across a year boundary too", () => {
  assert.deepEqual(defaultMonthRange(TODAY), { from: "2026-06", to: "2026-11" });
  assert.deepEqual(defaultMonthRange("2027-02-10"), { from: "2026-09", to: "2027-02" });
  assert.equal(addMonths("2026-12", 1), "2027-01");
});

test("changing either end keeps the range ordered and at most 6 months", () => {
  const range = { from: "2026-06", to: "2026-11" };
  assert.deepEqual(withFrom(range, "2026-01", TODAY), { from: "2026-01", to: "2026-06" });
  assert.deepEqual(withFrom(range, "2026-09", TODAY), { from: "2026-09", to: "2026-11" });
  assert.deepEqual(withTo(range, "2026-03"), { from: "2026-03", to: "2026-03" });
  assert.deepEqual(withTo({ from: "2026-01", to: "2026-03" }, "2026-10"), { from: "2026-05", to: "2026-10" });
  assert.deepEqual(withFrom({ from: "2026-01", to: "2026-02" }, "2026-05", TODAY), { from: "2026-05", to: "2026-05" });
});

test("request dates are whole months, and the current month stops at today", () => {
  assert.deepEqual(monthRangeDates({ from: "2026-06", to: "2026-11" }, TODAY), { start: "2026-06-01", end: TODAY });
  assert.deepEqual(monthRangeDates({ from: "2027-12", to: "2028-02" }, "2028-05-01"), { start: "2027-12-01", end: "2028-02-29" });
});

test("labels, options and the partial-month flag", () => {
  assert.equal(monthLabel("2026-11"), "Nov 2026");
  assert.equal(daysInMonth("2026-02"), 28);
  assert.deepEqual(monthOptions(TODAY, 3), ["2026-11", "2026-10", "2026-09"]);
  assert.equal(isPartialMonth("2026-06-01", 12, TODAY), true);
  assert.equal(isPartialMonth("2026-06-01", 30, TODAY), false);
  assert.equal(isPartialMonth("2026-11-01", 26, TODAY), false, "the current month is Live, not Partial");
});
