import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSnapshotCsv,
  dayParts,
  defaultSnapshotMonths,
  drrHeaders,
  filterAndSort,
  pickMonth,
} from "./inventorySnapshot.js";

const rows = [
  { key: "a", sku: "ALPHA", title: "Rose", drr: [1, 5], units: [5, null] },
  { key: "b", sku: "BETA", title: "Oud", drr: [9, null], units: [0, 2] },
  { key: "c", sku: "=GAMMA", title: 'Musk, "gold"', drr: [null, 7.5], units: [1, 3] },
];

test("default months follow yesterday, also on the 1st and in January", () => {
  assert.deepEqual(defaultSnapshotMonths("2026-11-27"), ["2026-10", "2026-11"]);
  assert.deepEqual(defaultSnapshotMonths("2026-12-01"), ["2026-10", "2026-11"]);
  assert.deepEqual(defaultSnapshotMonths("2027-01-10"), ["2026-12", "2027-01"]);
});

test("picking a month keeps the pair in calendar order", () => {
  assert.deepEqual(pickMonth(["2026-10", "2026-11"], 1, "2026-09"), ["2026-09", "2026-10"]);
});

test("headers add the year only when the month names clash", () => {
  assert.deepEqual(drrHeaders([{ month: "2026-09" }, { month: "2026-11" }]), ["Sep DRR", "Nov DRR"]);
  assert.deepEqual(drrHeaders([{ month: "2025-11" }, { month: "2026-11" }]), ["Nov 2025 DRR", "Nov 2026 DRR"]);
  assert.deepEqual(dayParts("2026-11-01"), { weekday: "Sun", label: "1 Nov" });
});

test("sorting keeps empty values last in both directions; search covers SKU and product", () => {
  const order = (sort, search) => filterAndSort(rows, search, sort).map((r) => r.key);
  assert.deepEqual(order({ by: "drr1", dir: "desc" }), ["c", "a", "b"]);
  assert.deepEqual(order({ by: "drr1", dir: "asc" }), ["a", "c", "b"]);
  assert.deepEqual(order({ by: "sku", dir: "asc" }, "ou"), ["b"]);
});

test("CSV has rounded DRR, empty cells for gaps and safe text", () => {
  const csv = buildSnapshotCsv(
    { months: [{ month: "2026-10" }, { month: "2026-11" }], days: ["2026-11-01", "2026-11-02"] },
    [rows[2], rows[0]],
  ).split("\n");
  assert.equal(csv[0], "Sr No,SKU,Product,Oct DRR,Nov DRR,2026-11-01,2026-11-02");
  assert.equal(csv[1], `1,'=GAMMA,"Musk, ""gold""",,8,1,3`);
  assert.equal(csv[2], "2,ALPHA,Rose,1,5,5,");
});
