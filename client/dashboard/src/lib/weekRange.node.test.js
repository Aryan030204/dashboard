import test from "node:test";
import assert from "node:assert/strict";
import { completeWeeks, spanLabel, sumRowsByWeek, weekLabel } from "./weekRange.js";

const TODAY = "2026-11-26"; // a Thursday

test("a range needs a full Monday to Sunday inside it, not just 7 days", () => {
  assert.equal(completeWeeks("2026-11-20", "2026-11-26", TODAY).weeks.length, 0, "Friday to Thursday is 7 days, no week");
  assert.equal(completeWeeks("2026-11-09", "2026-11-14", TODAY).weeks.length, 0, "6 days");
  assert.deepEqual(completeWeeks("2026-11-09", "2026-11-15", TODAY).weeks, [{ start: "2026-11-09", end: "2026-11-15" }]);
});

test("leftover days are reported, and the running week is never counted", () => {
  const { weeks, excluded } = completeWeeks("2026-11-05", TODAY, TODAY);
  assert.deepEqual(weeks.map((w) => w.start), ["2026-11-09", "2026-11-16"]);
  assert.deepEqual(excluded, [
    { start: "2026-11-05", end: "2026-11-08", running: false },
    { start: "2026-11-23", end: "2026-11-26", running: true },
  ]);
  // Sunday itself is still running: that week is not complete yet.
  assert.equal(completeWeeks("2026-11-23", "2026-11-29", "2026-11-29").weeks.length, 0);
});

test("a six month range gives whole weeks only", () => {
  const { weeks, excluded } = completeWeeks("2026-06-01", TODAY, TODAY);
  assert.equal(weeks.length, 25);
  assert.deepEqual([weeks[0].start, weeks.at(-1).end], ["2026-06-01", "2026-11-22"]);
  assert.deepEqual(excluded, [{ start: "2026-11-23", end: TODAY, running: true }]);
});

test("rows are summed per week, newest first, with the number of days that had data", () => {
  const day = (date, sessions) => ({ date, sessions, orders: sessions / 100, discount_amount: 5 });
  const rows = [day("2026-11-09", 100), day("2026-11-15", 200), day("2026-11-16", 0), day("2026-11-17", 300), day("2026-11-23", 900)];
  const out = sumRowsByWeek(rows, completeWeeks("2026-11-09", TODAY, TODAY).weeks);
  assert.deepEqual(out, [
    { date: "2026-11-16", days_with_data: 1, sessions: 300, orders: 3, discount_amount: 10 },
    { date: "2026-11-09", days_with_data: 2, sessions: 300, orders: 3, discount_amount: 10 },
  ]);
});

test("performance is averaged over the days that have it, and stays empty without any", () => {
  const rows = [
    { date: "2026-11-09", performance: 40 }, { date: "2026-11-10", performance: null }, { date: "2026-11-11", performance: 60 },
    { date: "2026-11-16", performance: null },
  ];
  const out = sumRowsByWeek(rows, completeWeeks("2026-11-09", "2026-11-22", TODAY).weeks);
  assert.deepEqual(out.map((w) => w.performance), [null, 50]);
});

test("labels within a month, across months and across years", () => {
  assert.equal(weekLabel("2026-10-05"), "5 – 11 Oct 2026");
  assert.equal(weekLabel("2026-06-29"), "29 Jun – 5 Jul 2026");
  assert.equal(weekLabel("2026-12-28"), "28 Dec 2026 – 3 Jan 2027");
  assert.equal(spanLabel("2026-11-23", "2026-11-23"), "23 Nov 2026");
});
