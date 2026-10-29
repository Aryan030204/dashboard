// Pure helpers for the "User Overlap by UTM Source" card (no React or MUI imports, so node can test them).

// The Intent dropdown: one value at a time. "all" applies no intent filter.
export const OVERLAP_INTENT_OPTIONS = [
  { value: "all", label: "All Intents" },
  { value: "high", label: "High Intent" },
  { value: "medium", label: "Medium Intent" },
  { value: "low", label: "Low Intent" },
];

export function isOverlapIntent(value) {
  return OVERLAP_INTENT_OPTIONS.some((option) => option.value === value);
}

// One colour per circle, in the order the API returns the sources (Google, Meta, Others).
export const SOURCE_COLORS = ["#3b82f6", "#8b5cf6", "#10b981"];

// Three equal circles in a triangle. `centroid` is where all three overlap.
const RADIUS = 92;
const CENTERS = [
  { x: 118, y: 112 },
  { x: 202, y: 112 },
  { x: 160, y: 184 },
];
const CENTROID = {
  x: CENTERS.reduce((sum, c) => sum + c.x, 0) / CENTERS.length,
  y: CENTERS.reduce((sum, c) => sum + c.y, 0) / CENTERS.length,
};

export const VENN_GEOMETRY = Object.freeze({
  width: 320,
  height: 296,
  radius: RADIUS,
  centers: CENTERS,
  centroid: CENTROID,
});

const numberFormat = new Intl.NumberFormat("en-IN");

export function formatValue(value) {
  return numberFormat.format(Math.round(Number(value) || 0));
}

// Which circles (indices into `sources`) a region belongs to.
export function regionIndices(region, sources) {
  const keys = region?.sources || [];
  return keys
    .map((key) => sources.findIndex((source) => source.key === key))
    .filter((index) => index >= 0);
}

export function getRegionLabel(region, sources) {
  const labelOf = (key) => sources.find((source) => source.key === key)?.label || key;
  const names = (region?.sources || []).map(labelOf);
  if (region?.kind === "only") return `${names[0]} only`;
  if (region?.kind === "all") return "All three sources";
  return names.join(" + ");
}

// What the number of a region means, so the centre (checked-out sessions only) is never mistaken for the others.
export function getRegionUnit(region) {
  return region?.kind === "all" ? "checked-out sessions" : "sessions";
}

export function getRegionCaption(region, sources) {
  const visitors = Number(region?.users) || 0;
  return `${getRegionLabel(region, sources)}: ${formatValue(region?.value)} ${getRegionUnit(region)} · ${formatValue(
    visitors,
  )} ${visitors === 1 ? "visitor" : "visitors"}`;
}

// Legend order: each source on its own, then the pairs, then all three.
export function orderRegions(regions, sources) {
  const rank = (region) => {
    const indices = regionIndices(region, sources);
    return [indices.length, ...indices];
  };
  return [...(regions || [])].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < Math.max(ra.length, rb.length); i += 1) {
      const diff = (ra[i] ?? -1) - (rb[i] ?? -1);
      if (diff !== 0) return diff;
    }
    return 0;
  });
}

// Where a region's number is drawn: inside the region, away from the circles that are not part of it.
export function getRegionAnchor(indices) {
  const points = indices.map((index) => CENTERS[index]).filter(Boolean);
  if (points.length === 0) return null;
  if (points.length === CENTERS.length) return { ...CENTROID };
  const mid = {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
  if (points.length === 1) {
    return { x: mid.x + (mid.x - CENTROID.x) * 0.62, y: mid.y + (mid.y - CENTROID.y) * 0.62 };
  }
  // a pair: push the midpoint away from the circle that is left out
  const leftOut = CENTERS.find((_, index) => !indices.includes(index));
  return { x: mid.x + (mid.x - leftOut.x) * 0.3, y: mid.y + (mid.y - leftOut.y) * 0.3 };
}

export function hasOverlapData(data) {
  return Boolean(data?.meta?.available) && (data?.sources || []).length > 0;
}
