import test from "node:test";
import assert from "node:assert/strict";
import {
  clampRange,
  daysInRange,
  defaultRange,
  formatBucketTitle,
  formatDuration,
  formatInstant,
  formatTick,
  hourlyAllowed,
  resolveGranularity,
  shiftDay,
  suggestGranularity,
} from "./oosTrend.js";

test("date arithmetic works on plain days, across months and years", () => {
  assert.equal(shiftDay("2026-11-01", -1), "2026-10-31");
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
  assert.equal(daysInRange("2026-11-01", "2026-11-04"), 4);
  assert.equal(daysInRange("2026-11-04", "2026-11-04"), 1);
});

test("the default range is the last 7 days ending today", () => {
  assert.deepEqual(defaultRange("2026-11-04"), { start: "2026-10-29", end: "2026-11-04" });
  assert.equal(daysInRange(...Object.values(defaultRange("2026-11-04"))), 7);
});

test("a range longer than 31 days keeps its start and stops at 31 days; a reversed pick is swapped", () => {
  assert.deepEqual(clampRange("2026-09-01", "2026-11-04"), { start: "2026-09-01", end: "2026-10-01" });
  assert.deepEqual(clampRange("2026-10-05", "2026-11-04"), { start: "2026-10-05", end: "2026-11-04" }); // exactly 31 days
  assert.deepEqual(clampRange("2026-11-04", "2026-11-01"), { start: "2026-11-01", end: "2026-11-04" });
});

test("hourly is only allowed up to 7 days, and falls back to daily beyond that", () => {
  assert.equal(hourlyAllowed("2026-10-29", "2026-11-04"), true);
  assert.equal(hourlyAllowed("2026-10-28", "2026-11-04"), false);
  assert.equal(resolveGranularity("hourly", "2026-10-28", "2026-11-04"), "daily");
  assert.equal(resolveGranularity("hourly", "2026-11-03", "2026-11-04"), "hourly");
  assert.equal(resolveGranularity("daily", "2026-11-03", "2026-11-04"), "daily");
  assert.equal(suggestGranularity("2026-11-04", "2026-11-04"), "hourly");
  assert.equal(suggestGranularity("2026-11-01", "2026-11-04"), "daily");
});

test("axis ticks and tooltip titles", () => {
  assert.equal(formatTick("2026-11-04", "daily"), "Nov 4");
  assert.equal(formatTick("2026-11-04 09:00", "hourly"), "09:00");
  assert.equal(formatTick("2026-11-04 00:00", "hourly"), "Nov 4 00:00");
  assert.equal(formatBucketTitle("2026-11-04", "daily"), "Nov 4, 2026");
  assert.equal(formatBucketTitle("2026-11-04 09:00", "hourly"), "Nov 4, 2026, 09:00");
  assert.equal(formatTick(undefined, "daily"), "");
});

test("durations read naturally", () => {
  assert.equal(formatDuration(759), "12h 39m");
  assert.equal(formatDuration(45), "45m");
  assert.equal(formatDuration(120), "2h");
  assert.equal(formatDuration(1500), "1d 1h");
  assert.equal(formatDuration(2880), "2d");
  assert.equal(formatDuration(null), "-");
  assert.equal(formatDuration(undefined), "-");
});

test("an instant is shown in the brand's timezone", () => {
  const text = formatInstant("2026-11-04T04:25:00.000Z", "Asia/Kolkata"); // 09:55 in India
  assert.match(text, /4 Nov/);
  assert.match(text, /9:55/);
  assert.equal(formatInstant(null, "Asia/Kolkata"), "-");
  assert.equal(formatInstant("not a date", "Asia/Kolkata"), "-");
});
