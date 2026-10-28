import test from "node:test";
import assert from "node:assert/strict";
import {
  OVERLAP_INTENT_OPTIONS,
  VENN_GEOMETRY,
  formatValue,
  getRegionAnchor,
  getRegionCaption,
  getRegionLabel,
  hasOverlapData,
  isOverlapIntent,
  orderRegions,
  regionIndices,
} from "./intentSourceOverlapUtils.js";

const sources = [
  { key: "google", label: "Google" },
  { key: "meta", label: "Meta" },
  { key: "others", label: "Others" },
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
  assert.deepEqual(regionIndices(region(["meta", "others"]), sources), [1, 2]);
  assert.deepEqual(regionIndices(region(["meta", "unknown"]), sources), [1]);
});

test("orderRegions lists each source alone, then the pairs, then all three", () => {
  const shuffled = [
    region(["google", "meta", "others"]),
    region(["meta", "others"]),
    region(["others"]),
    region(["google", "others"]),
    region(["google"]),
    region(["google", "meta"]),
    region(["meta"]),
  ];
  assert.deepEqual(
    orderRegions(shuffled, sources).map((r) => r.id),
    ["google", "meta", "others", "google+meta", "google+others", "meta+others", "google+meta+others"],
  );
});

test("region labels read naturally and name the centre as all three sources", () => {
  assert.equal(getRegionLabel(region(["google"]), sources), "Google only");
  assert.equal(getRegionLabel(region(["google", "meta"]), sources), "Google + Meta");
  assert.equal(getRegionLabel(region(["google", "meta", "others"]), sources), "All three sources");
});

test("the caption says what the number counts, so the centre is not read as plain sessions", () => {
  assert.equal(
    getRegionCaption(region(["google", "meta"], { value: 1234, users: 10 }), sources),
    "Google + Meta: 1,234 sessions · 10 visitors",
  );
  assert.equal(
    getRegionCaption(region(["google", "meta", "others"], { value: 7, users: 1 }), sources),
    "All three sources: 7 checked-out sessions · 1 visitor",
  );
});

test("the intent dropdown offers all intents first, then one level at a time", () => {
  assert.deepEqual(
    OVERLAP_INTENT_OPTIONS.map((option) => option.label),
    ["All Intents", "High Intent", "Medium Intent", "Low Intent"],
  );
  assert.equal(isOverlapIntent("medium"), true);
  assert.equal(isOverlapIntent("all"), true);
  assert.equal(isOverlapIntent("high,low"), false);
  assert.equal(isOverlapIntent(undefined), false);
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
