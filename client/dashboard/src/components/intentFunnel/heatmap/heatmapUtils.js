// Pure helpers for the Heatmaps section (no React or MUI imports, so node can test them).

export const HEATMAP_DEVICE_OPTIONS = [
  { value: "all", label: "All devices" },
  { value: "desktop", label: "Desktop" },
  { value: "mobile", label: "Mobile" },
  { value: "tablet", label: "Tablet" },
];

const numberFormat = new Intl.NumberFormat("en-IN");

export function formatCount(value) {
  return numberFormat.format(Math.round(Number(value) || 0));
}

// "8.9%"; one decimal under 10, none above, so a row of shares stays easy to scan.
export function formatShare(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n >= 10 ? n.toFixed(0) : n.toFixed(1)}%`;
}

export function humanizeSlug(slug) {
  let text = String(slug ?? "");
  try {
    text = decodeURIComponent(text);
  } catch {
    // keep the raw slug when it is not valid percent-encoding
  }
  text = text.replace(/[-_+]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

// We do not store page titles, so a page is named from its path: "/products/build-your-own-box" reads
// "Build your own box". The path is always shown too, so nothing is hidden by the friendly name.
export function describePage(path) {
  const clean = String(path ?? "").trim() || "/";
  if (clean === "/") return { kind: "Home", label: "Home page", path: "/" };

  const segments = clean.split("/").filter(Boolean);
  const productAt = segments.indexOf("products");
  if (productAt !== -1 && segments[productAt + 1]) {
    return { kind: "Product", label: humanizeSlug(segments[productAt + 1]), path: clean };
  }
  if (segments[0] === "collections" && segments[1]) {
    return { kind: "Collection", label: humanizeSlug(segments[1]), path: clean };
  }
  if (segments[0] === "collections") return { kind: "Collection", label: "All collections", path: clean };
  const last = segments[segments.length - 1];
  return { kind: "Page", label: humanizeSlug(last) || clean, path: clean };
}

// What a clicked element is called in the ranked list. The tracker only stores a tag, an id, a name, a type,
// a value and a link, so many elements have little more than a tag; the best available label wins and the
// rest goes in the subtitle.
export function describeElement(element) {
  const tag = element?.tag ? String(element.tag).toLowerCase() : null;
  const label =
    element?.name ||
    element?.elementId ||
    (element?.href ? `Link to ${element.href}` : null) ||
    element?.value ||
    (tag ? `${tag} element` : "Unlabelled element");

  const subtitle = [
    tag,
    element?.type,
    element?.elementId && element.elementId !== label ? `#${element.elementId}` : null,
    element?.href && !String(label).includes(element.href) ? element.href : null,
  ].filter(Boolean);
  return { title: String(label), subtitle: subtitle.join(" · ") };
}

// Useful vs dead share of one element's clicks, as percentages that add up to 100 (or both 0).
export function clickSplit(element) {
  const useful = Number(element?.usefulClicks) || 0;
  const dead = Number(element?.deadClicks) || 0;
  const total = useful + dead;
  if (total <= 0) return { usefulPct: 0, deadPct: 0 };
  const usefulPct = (useful / total) * 100;
  return { usefulPct, deadPct: 100 - usefulPct };
}

export function pageShare(views, totalViews) {
  const total = Number(totalViews) || 0;
  if (total <= 0) return 0;
  return ((Number(views) || 0) / total) * 100;
}

// A page's intent compared with the whole site, from the sessions that viewed it at each Behaviour level.
// Each side is reduced to one number, the average level of its sessions (low 0, medium 1, high 2). A page
// is High when that average is clearly above the site's, Low when clearly below, Medium otherwise. Pages
// with too few classified sessions get no level, because a handful of sessions says nothing.
export const PAGE_INTENT_MIN_SESSIONS = 20;
export const PAGE_INTENT_MARGIN = 0.15;

function averageLevel(counts) {
  const high = Number(counts?.high) || 0;
  const medium = Number(counts?.medium) || 0;
  const low = Number(counts?.low) || 0;
  const total = high + medium + low;
  return { total, average: total > 0 ? (2 * high + medium) / total : 0 };
}

export function pageIntentLevel(pageIntent, siteIntent) {
  if (!pageIntent || !siteIntent) return null;
  const page = averageLevel(pageIntent);
  const site = averageLevel(siteIntent);
  if (page.total < PAGE_INTENT_MIN_SESSIONS || site.average <= 0) return null;
  const ratio = page.average / site.average;
  if (ratio >= 1 + PAGE_INTENT_MARGIN) return "high";
  if (ratio <= 1 - PAGE_INTENT_MARGIN) return "low";
  return "medium";
}
