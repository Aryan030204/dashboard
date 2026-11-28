// Run with: node --test src/pages/MarketplaceHistory/marketplaceFormat.node.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  band, cheapest, gapRows, gapText, kpis, latestPoints, latestSentence, outOfStockSpans, rangeParams, stats, toCsv,
} from "./marketplaceFormat.js";

const ok = (price, pct) => ({ state: "ok", price, gap: { pct, abs: price - 1000 } });
const row = (variantId, cells, live = Object.keys(cells)) => ({
  variantId, product: `P${variantId}`, size: "100ML", ourPrice: 1000, mrp: 1500, rank: variantId, live, cells,
});

test("range presets, custom dates and all", () => {
  const today = new Date(2026, 10, 28);
  assert.deepEqual(rangeParams("1M", null, today), { start: "2026-10-30", end: "2026-11-28" });
  assert.deepEqual(rangeParams("all", null, today), { range: "all" });
  assert.deepEqual(rangeParams("3M", { start: "2026-01-01", end: "2026-01-31" }, today), { start: "2026-01-01", end: "2026-01-31" });
});

test("bands and gap text", () => {
  assert.deepEqual([null, 0.9, -1, -6, -15, 3].map(band), ["none", "par", "par", "below", "deep", "above"]);
  assert.equal(gapText({ pct: -12.4, abs: -189 }, "pct"), "▼ 12%");
  assert.equal(gapText({ pct: 2, abs: 20 }, "abs"), "▲ ₹20");
  assert.equal(gapText({ pct: null, abs: null }, "pct"), "–");
});

test("kpis follow the selected marketplaces", () => {
  const rows = [
    row(1, { AMAZON: ok(1020, 2), MYNTRA: ok(800, -20) }),
    row(2, { AMAZON: { state: "unlisted" }, MYNTRA: ok(900, -10) }, ["MYNTRA"]),
    row(3, { AMAZON: { state: "oos" }, MYNTRA: { state: "unlisted" } }, ["AMAZON"]),
  ];
  const both = kpis(rows, ["AMAZON", "MYNTRA"]);
  assert.deepEqual(
    [both.tracked, both.pairs, both.possible, both.coverage, both.medianGap, both.deepBelow, both.cheapest],
    [3, 4, 6, 67, -10, 1, { code: "MYNTRA", pct: -15 }],
  );
  const amazon = kpis(rows, ["AMAZON"]);
  assert.deepEqual([amazon.tracked, amazon.deepBelow, amazon.medianGap], [2, 0, 2]);
  assert.deepEqual(cheapest(rows[0], ["AMAZON", "MYNTRA"]), { code: "MYNTRA", price: 800 });
  assert.equal(cheapest(rows[2], ["AMAZON"]), null);
});

test("chart rows keep gaps and the latest sentence skips empty days", () => {
  const value = (n, pct) => ({ n, median: { pct, abs: pct * 10 }, average: { pct, abs: pct * 10 } });
  const series = [
    { date: "2026-11-27", listed: { AMAZON: value(2, 1), MYNTRA: value(1, -10) } },
    { date: "2026-11-28", listed: { AMAZON: value(0, null), MYNTRA: value(3, -9) } },
  ];
  const options = { basis: "listed", stat: "median", unit: "pct" };
  assert.deepEqual(gapRows(series, ["AMAZON"], options).map((r) => r.AMAZON), [1, null]);
  const points = latestPoints(series, ["AMAZON", "MYNTRA"], options);
  assert.deepEqual(points.map((p) => [p.value, p.n, p.date]), [[1, 2, "2026-11-27"], [-9, 3, "2026-11-28"]]);
  assert.equal(latestSentence(points, { AMAZON: "Amazon", MYNTRA: "Myntra" }, "pct"), "Latest: Myntra 9% below, Amazon at par.");
});

test("stats and out-of-stock spans", () => {
  assert.deepEqual(stats([null, 100, 200]), { highest: 200, lowest: 100, average: 150, latest: 200, versusAverage: 33.33333333333333 });
  assert.equal(stats([null]), null);
  const day = (date, oos) => ({ date, marketplaces: { A: oos === null ? null : { oos } } });
  const spans = outOfStockSpans([day("2026-11-01", true), day("2026-11-02", true), day("2026-11-03", false), day("2026-11-04", true)], "A");
  assert.equal(spans.length, 2);
  assert.equal(spans[0][1] - spans[0][0], 2 * 24 * 60 * 60 * 1000);
});

test("csv cannot smuggle a formula, negative numbers stay numbers", () => {
  const rows = [{ ...row(1, { AMAZON: ok(800, -20) }), product: '=HYPERLINK("x","y")' }];
  const [header, line] = toCsv(rows, [{ code: "AMAZON", name: "Amazon" }]).split("\n");
  assert.equal(header, "Product,Size,Our price,MRP,Amazon price,Amazon gap %,Order rank");
  assert.ok(line.startsWith('"\'=HYPERLINK'));
  assert.ok(line.includes(",800,-20,1"));
});
