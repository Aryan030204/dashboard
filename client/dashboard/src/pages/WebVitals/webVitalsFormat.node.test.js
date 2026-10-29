import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPageRowsFromPagespeed, getPerformanceStatus } from "./webVitalsFormat.js";
import { pagespeedBrandName, fetchPagespeedResults } from "../../lib/pagespeed.js";

// What the external PageSpeed service returns for the latest run: one result per page.
const RESULTS = [
  { url: "https://shop.example/", page_name: "home", rank: 1, performance: 53, fcp: 3.03, lcp: 6.11, ttfb: 0.03, inp: 0, cls: 0.22 },
  { url: "https://shop.example/products/a", page_name: "a", rank: 2, performance: 65, fcp: 3.04, lcp: 5.54, ttfb: 0.02, inp: 0, cls: 0.17 },
  { url: "https://shop.example/products/b", page_name: "b", rank: 3, performance: 44, fcp: 5.07, lcp: 19.3, ttfb: 0.02, inp: 0, cls: 0 },
];

test("one row per URL, worst performance first, with the scale's status", () => {
  const rows = buildPageRowsFromPagespeed(RESULTS);

  assert.deepEqual(rows.map((r) => r.page_name), ["b", "home", "a"]);
  assert.equal(rows[0].performance_status, "poor"); // 44
  assert.equal(rows[1].performance_status, "needs_attention"); // 53
  assert.equal(rows[2].performance_status, "good"); // 65
});

test("lists exactly the pages the dashboard card is given", () => {
  const cardUrls = [...new Set(RESULTS.map((r) => r.url))].sort();
  const tableUrls = buildPageRowsFromPagespeed(RESULTS).map((r) => r.url).sort();
  assert.deepEqual(tableUrls, cardUrls);
});

test("repeated results of a URL are averaged, like the card does", () => {
  const rows = buildPageRowsFromPagespeed([
    { url: "u", page_name: "p", performance: 40, fcp: 2 },
    { url: "u", page_name: "", performance: 60, fcp: 4 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].performance, 50);
  assert.equal(rows[0].fcp, 3);
  assert.equal(rows[0].page_name, "p");
});

test("missing metrics stay null and bad input gives no rows", () => {
  const rows = buildPageRowsFromPagespeed([{ url: "u", performance: 70 }, { performance: 1 }, null]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lcp, null);
  assert.deepEqual(buildPageRowsFromPagespeed(undefined), []);
});

test("performance status uses the 4-tier scale", () => {
  assert.equal(getPerformanceStatus(60), "good");
  assert.equal(getPerformanceStatus(59), "needs_attention");
  assert.equal(getPerformanceStatus(47), "needs_attention");
  assert.equal(getPerformanceStatus(46), "poor");
  assert.equal(getPerformanceStatus(40), "poor");
  assert.equal(getPerformanceStatus(39), "critical");
  assert.equal(getPerformanceStatus(null), null);
});

test("both panels resolve the brand to the same PageSpeed name", () => {
  assert.equal(pagespeedBrandName("tmc"), "TMC");
  assert.equal(pagespeedBrandName(" bbb "), "BlaBliBluLife");
  assert.equal(pagespeedBrandName("PTS"), "SkincarePersonalTouch");
  assert.equal(pagespeedBrandName("xyz"), "XYZ");
  assert.equal(pagespeedBrandName(""), "");
});

test("the shared fetch is called once for identical arguments", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { json: async () => ({ results: RESULTS }) };
  };
  const [a, b] = await Promise.all([
    fetchPagespeedResults("TMC", "2026-10-29", "2026-10-29"),
    fetchPagespeedResults("TMC", "2026-10-29", "2026-10-29"),
  ]);
  assert.equal(calls, 1);
  assert.equal(a, b);
});
