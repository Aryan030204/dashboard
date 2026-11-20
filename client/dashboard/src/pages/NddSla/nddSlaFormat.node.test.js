import test from "node:test";
import assert from "node:assert/strict";
import {
  DASH,
  exportFilename,
  formatCount,
  formatHour,
  formatPct,
  formatReportDate,
  formatWall,
  isFailedStatus,
  locationLabel,
  pickDefaultDate,
  runOptionLabel,
  saveBlob,
  statusInfo,
  processingSteps,
  formatElapsed,
  isInFlight,
  isWaiting,
  isLive,
} from "./nddSlaFormat.js";

test("counts and percentages are only formatted, and missing values show a dash", () => {
  assert.equal(formatCount(1063), "1,063");
  assert.equal(formatCount(null), DASH);
  assert.equal(formatCount(undefined), DASH);
  assert.equal(formatPct(33.333), "33.3%");
  assert.equal(formatPct(0), "0.0%");
  assert.equal(formatPct(NaN), DASH);
});

test("location codes map to the business names", () => {
  assert.equal(locationLabel("AJMAL_SONS"), "AJMAL & SONS");
  assert.equal(locationLabel("EMIZA_GGN"), "Emiza Gurgaon");
  assert.equal(locationLabel("OTHER"), "OTHER");
});

test("wall-clock strings and hours read in 12-hour form without timezone shifts", () => {
  assert.equal(formatWall("2026-11-18 12:00:00"), "18 Nov, 12:00 PM");
  assert.equal(formatWall("2026-11-19 00:05:00"), "19 Nov, 12:05 AM");
  assert.equal(formatWall("2026-11-19 15:00:00"), "19 Nov, 3:00 PM");
  assert.equal(formatWall("garbage"), "garbage");
  assert.equal(formatHour(0), "12 AM – 1 AM");
  assert.equal(formatHour(11), "11 AM – 12 PM");
  assert.equal(formatHour(23), "11 PM – 12 AM");
  assert.equal(formatReportDate("2026-11-19"), "19 Nov 2026");
});

test("statuses: completed is success, failures are errors, in-flight states are info", () => {
  assert.equal(statusInfo("COMPLETED").tone, "success");
  for (const s of ["GOKWIK_TIMEOUT", "EASYCOM_FAILED", "PROCESSING_FAILED"]) assert.equal(isFailedStatus(s), true, s);
  for (const s of ["SCHEDULED", "WAITING_FOR_GOKWIK", "PROCESSING"]) assert.equal(isFailedStatus(s), false, s);
  assert.equal(statusInfo("SOMETHING_NEW").label, "SOMETHING_NEW");
});

test("report selector: newest ready report is the default, otherwise the newest run; labels carry the status", () => {
  const runs = [
    { reportDate: "2026-11-20", ready: false, status: "WAITING_FOR_GOKWIK" },
    { reportDate: "2026-11-19", ready: true, status: "COMPLETED" },
    { reportDate: "2026-11-18", ready: true, status: "COMPLETED" },
  ];
  assert.equal(pickDefaultDate(runs), "2026-11-19");
  assert.equal(pickDefaultDate([runs[0]]), "2026-11-20");
  assert.equal(pickDefaultDate([]), "");
  assert.equal(runOptionLabel({ ...runs[1], reportSeq: 1, source: null }), "#1 · Automated", "a finished report shows no status");
  assert.equal(runOptionLabel({ ...runs[0], reportSeq: 1 }), "#1 · Automated · Waiting for GoKwik report");
  assert.equal(runOptionLabel({ reportSeq: 2, ready: true, status: "SCHEDULED", source: { mode: "MANUAL", filename: "gokwik OG.csv" } }), "#2 · gokwik OG.csv · Scheduled", "a re-run in progress is visible");
  assert.equal(runOptionLabel({ reportSeq: 3, ready: false, status: "PROCESSING", paused: true, source: { mode: "MANUAL", filename: "a.csv" } }), "#3 · a.csv · Paused");
  assert.equal(isLive({ status: "PROCESSING" }), true);
  assert.equal(isLive({ status: "CANCELLED" }), false);
});

test("export filename and saving a blob", () => {
  assert.equal(exportFilename("orders", "2026-11-19"), "ndd-sla-orders-2026-11-19.csv");
  assert.equal(exportFilename("summary", "2026-11-19", 3), "ndd-sla-summary-2026-11-19-r3.csv");
  const calls = [];
  const link = { click: () => calls.push("click") };
  const doc = { createElement: () => link, body: { appendChild: () => calls.push("append"), removeChild: () => calls.push("remove") } };
  const urlApi = { createObjectURL: () => "blob:x", revokeObjectURL: (u) => calls.push(`revoke ${u}`) };
  saveBlob({}, "f.csv", doc, urlApi);
  assert.equal(link.download, "f.csv");
  assert.equal(link.href, "blob:x");
  assert.deepEqual(calls, ["append", "click", "remove", "revoke blob:x"]);
});

const states = (run) => processingSteps(run).steps.map((s) => s.state);

test("progress: each status maps to the right step, percentage and message", () => {
  const manual = { source: { mode: "MANUAL" }, counts: { rowsIn: 1179, kept: 1063 }, progress: { easycomFetched: 1134 } };
  assert.deepEqual(states({ ...manual, status: "GOKWIK_RECEIVED" }), ["done", "active", "pending", "pending"]);
  assert.deepEqual(states({ ...manual, status: "EASYCOM_FETCHING" }), ["done", "done", "active", "pending"]);
  assert.deepEqual(states({ ...manual, status: "PROCESSING" }), ["done", "done", "done", "active"]);
  assert.deepEqual(states({ ...manual, status: "COMPLETED" }), ["done", "done", "done", "done"]);
  assert.equal(processingSteps({ ...manual, status: "COMPLETED" }).percent, 100);
  const mid = processingSteps({ ...manual, status: "EASYCOM_FETCHING" });
  assert.equal(mid.percent, 63);
  assert.equal(mid.indeterminate, true);
  assert.match(mid.detail, /1,179 rows read, 1,063 orders kept/);
  assert.match(processingSteps({ ...manual, status: "PROCESSING" }).detail, /1,134 shipments checked. Saving 1,063 orders/);
  assert.equal(processingSteps({ ...manual, status: "GOKWIK_RECEIVED" }).steps[0].label, "Files received");
});

test("progress: waiting for the GoKwik email is indeterminate at 0% and says so", () => {
  const p = processingSteps({ status: "WAITING_FOR_GOKWIK", source: null });
  assert.deepEqual([p.percent, p.indeterminate, p.steps[0].label, p.steps[0].state], [0, true, "Waiting for the GoKwik report", "active"]);
  assert.match(p.detail, /Waiting for the GoKwik email/);
  assert.equal(isWaiting("SCHEDULED"), true);
  assert.equal(isInFlight("WAITING_FOR_GOKWIK"), false);
  assert.equal(isInFlight("PROCESSING"), true);
});

test("progress: a failure marks the step that failed, freezes the bar there, and is not 'running'", () => {
  const file = processingSteps({ status: "PROCESSING_FAILED", error: { code: "CSV_MISSING_COLUMNS" }, source: { mode: "MANUAL" } });
  assert.deepEqual(file.steps.map((s) => s.state), ["done", "error", "pending", "pending"]);
  assert.deepEqual([file.percent, file.indeterminate], [25, false]);
  const easy = processingSteps({ status: "EASYCOM_FAILED", error: { code: "EASYCOM_UNAVAILABLE" } });
  assert.deepEqual(easy.steps.map((s) => s.state), ["done", "done", "error", "pending"]);
  const save = processingSteps({ status: "PROCESSING_FAILED", error: { code: "UNEXPECTED_ERROR" } });
  assert.equal(save.steps[3].state, "error");
  assert.equal(processingSteps({ status: "GOKWIK_TIMEOUT" }).steps[0].state, "error");
});

test("elapsed time reads m:ss", () => {
  assert.equal(formatElapsed(5), "0:05");
  assert.equal(formatElapsed(75), "1:15");
  assert.equal(formatElapsed(-3), "0:00");
});

test("progress: paused and cancelled are not failures, and say what happened", () => {
  const paused = processingSteps({ status: "EASYCOM_FETCHING", paused: true, source: { mode: "MANUAL" } });
  assert.deepEqual([paused.headline, paused.indeterminate, paused.paused], ["Paused", false, true]);
  assert.equal(isFailedStatus("CANCELLED"), false);
  const cancelled = processingSteps({ status: "CANCELLED", error: { code: "CANCELLED" } });
  assert.deepEqual([cancelled.percent, cancelled.cancelled, cancelled.steps.every((st) => st.state === "pending")], [0, true, true]);
  assert.match(processingSteps({ status: "CANCELLED", error: { code: "PAUSE_TIMEOUT" } }).detail, /paused too long/);
  assert.equal(processingSteps({ status: "PROCESSING", cancelRequested: true }).headline, "Cancelling…");
});
