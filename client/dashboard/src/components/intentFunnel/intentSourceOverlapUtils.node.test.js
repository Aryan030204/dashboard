import test from "node:test";
import assert from "node:assert/strict";
import {
  VENN_GEOMETRY,
  describeLevels,
  formatValue,
  getRegionAnchor,
  getRegionCaption,
  getRegionLabel,
  hasOverlapData,
  orderRegions,
  regionIndices,
  sanitizeLevels,
} from "./intentSourceOverlapUtils.js";

const sources = [
  { key: "google", label: "Google" },
  { key: "meta", label: "Meta" },
  { key: "direct", label: "Direct" },
];

const region = (keys, extra = {}) => ({
  id: keys.join("+"),
  sources: keys,
  kind: keys.length === 1 ? "only" : keys.length === 3 ? "all" : "overlap",
  users: 0,
  sessions: 0,
  checkoutSessions: 0,
  value: 0,
  ...extra,
});

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test("every region's anchor sits inside its circles and outside the others", () => {
  const { centers, radius } = VENN_GEOMETRY;
  for (let mask = 1; mask < 8; mask += 1) {
    const indices = [0, 1, 2].filter((i) => mask & (1 << i));
    const anchor = getRegionAnchor(indices);
    centers.forEach((center, index) => {
      const inside = distance(anchor, center) < radius;
      assert.equal(inside, indices.includes(index), `mask ${mask}, circle ${index}`);
    });
  }
});

test("getRegionAnchor returns null for no circles", () => {
  assert.equal(getRegionAnchor([]), null);
});

test("regionIndices maps source keys to circle indices and drops unknown keys", () => {
  assert.deepEqual(regionIndices(region(["meta", "direct"]), sources), [1, 2]);
  assert.deepEqual(regionIndices(region(["meta", "unknown"]), sources), [1]);
});

test("orderRegions lists each source alone, then the pairs, then all three", () => {
  const shuffled = [
    region(["google", "meta", "direct"]),
    region(["meta", "direct"]),
    region(["direct"]),
    region(["google", "direct"]),
    region(["google"]),
    region(["google", "meta"]),
    region(["meta"]),
  ];
  assert.deepEqual(
    orderRegions(shuffled, sources).map((r) => r.id),
    ["google", "meta", "direct", "google+meta", "google+direct", "meta+direct", "google+meta+direct"],
  );
});

test("region labels read naturally and name the centre as all three sources", () => {
  assert.equal(getRegionLabel(region(["google"]), sources), "Google only");
  assert.equal(getRegionLabel(region(["google", "meta"]), sources), "Google + Meta");
  assert.equal(getRegionLabel(region(["google", "meta", "direct"]), sources), "All three sources");
});

test("the caption says what the number counts, so the centre is not read as plain sessions", () => {
  assert.equal(
    getRegionCaption(region(["google", "meta"], { value: 1234, users: 10 }), sources),
    "Google + Meta: 1,234 sessions · 10 visitors",
  );
  assert.equal(
    getRegionCaption(region(["google", "meta", "direct"], { value: 7, users: 1 }), sources),
    "All three sources: 7 checked-out sessions · 1 visitor",
  );
});

test("intent levels are kept in a fixed order and never end up empty", () => {
  assert.deepEqual(sanitizeLevels(["low", "high"]), ["high", "low"]);
  assert.deepEqual(sanitizeLevels([]), ["high", "medium", "low"]);
  assert.deepEqual(sanitizeLevels(["nope"]), ["high", "medium", "low"]);
  assert.equal(describeLevels(["high", "medium", "low"]), "All intents");
  assert.equal(describeLevels(["low", "high"]), "High Intent, Low Intent");
});

test("formatValue groups digits the Indian way and tolerates bad input", () => {
  assert.equal(formatValue(1234567), "12,34,567");
  assert.equal(formatValue(null), "0");
  assert.equal(formatValue("abc"), "0");
});

test("hasOverlapData needs an available payload with at least one source", () => {
  assert.equal(hasOverlapData(null), false);
  assert.equal(hasOverlapData({ meta: { available: false }, sources }), false);
  assert.equal(hasOverlapData({ meta: { available: true }, sources: [] }), false);
  assert.equal(hasOverlapData({ meta: { available: true }, sources }), true);
});
