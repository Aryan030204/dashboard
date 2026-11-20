const test = require("node:test");
const assert = require("node:assert/strict");

const { getConfig, parseClock, readWindowRules } = require("../src/config");

const GOOD = {
  NDD_SLA_REPORT_DATE_ANCHOR: "end",
  NDD_SLA_NDD_START_TIME: "12:00",
  NDD_SLA_OTHER_START_TIME: "15:00",
};

test("confirmed window rules are the defaults; blank variables count as unset (a copied, unfilled .env must not break start-up)", () => {
  const expected = { anchor: "end", nddStart: { hour: 12, minute: 0 }, otherStart: { hour: 15, minute: 0 }, lengthHours: 24 };
  assert.deepEqual(readWindowRules({}), expected);
  assert.deepEqual(readWindowRules({ NDD_SLA_REPORT_DATE_ANCHOR: "", NDD_SLA_NDD_START_TIME: "", NDD_SLA_OTHER_START_TIME: "" }), expected);
  assert.equal(getConfig({}).timezone, "Asia/Kolkata");
});

test("a valid configuration is parsed into plain numbers", () => {
  assert.deepEqual(readWindowRules(GOOD), {
    anchor: "end",
    nddStart: { hour: 12, minute: 0 },
    otherStart: { hour: 15, minute: 0 },
    lengthHours: 24,
  });
});

test("anchor must be end or start, case-insensitive", () => {
  assert.equal(readWindowRules({ ...GOOD, NDD_SLA_REPORT_DATE_ANCHOR: "START" }).anchor, "start");
  assert.throws(() => readWindowRules({ ...GOOD, NDD_SLA_REPORT_DATE_ANCHOR: "middle" }), /ANCHOR/);
});

test("clock values are validated", () => {
  assert.deepEqual(parseClock("9:05", "x"), { hour: 9, minute: 5 });
  assert.throws(() => parseClock("25:00", "x"), /HH:mm/);
  assert.throws(() => parseClock("12", "x"), /HH:mm/);
  assert.throws(() => readWindowRules({ ...GOOD, NDD_SLA_WINDOW_LENGTH_HOURS: "0" }), /LENGTH_HOURS/);
});

test("getConfig fills defaults for non-business knobs, including a safety ceiling on kept rows", () => {
  const cfg = getConfig(GOOD);
  assert.equal(cfg.brandKey, "AJMAL");
  assert.equal(cfg.columns.reference, "Reference Code");
  assert.equal(cfg.limits.dbBatchRows, 1000);
  assert.equal(cfg.limits.maxKeptRows, 250000); // a guard, not a benchmark; override with NDD_SLA_MAX_KEPT_ROWS
  assert.equal(getConfig({ ...GOOD, NDD_SLA_MAX_KEPT_ROWS: "1000" }).limits.maxKeptRows, 1000);
  assert.equal(cfg.limits.maxAttachmentBytes, 25 * 1024 * 1024);
});
