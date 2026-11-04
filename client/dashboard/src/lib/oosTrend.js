// Rules and formatting for the Inventory panel's out-of-stock trend. Pure functions so they can be tested
// without React. Dates are plain YYYY-MM-DD strings (the brand's calendar days).

export const MAX_RANGE_DAYS = 31;
export const MAX_HOURLY_RANGE_DAYS = 7;
export const DEFAULT_RANGE_DAYS = 7;

const DAY_MS = 24 * 3600 * 1000;
const pad2 = (n) => String(n).padStart(2, "0");

function toUtcMs(day) {
  const [y, m, d] = String(day).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function shiftDay(day, delta) {
  return fromUtcMs(toUtcMs(day) + delta * DAY_MS);
}

export function daysInRange(start, end) {
  return Math.round((toUtcMs(end) - toUtcMs(start)) / DAY_MS) + 1;
}

// The last `days` days ending today (today = the caller's calendar day, YYYY-MM-DD).
export function defaultRange(today, days = DEFAULT_RANGE_DAYS) {
  return { start: shiftDay(today, -(days - 1)), end: today };
}

// A range can be at most MAX_RANGE_DAYS long: a longer pick keeps its start and stops at the limit.
export function clampRange(start, end, maxDays = MAX_RANGE_DAYS) {
  let from = start;
  let to = end;
  if (to < from) [from, to] = [to, from];
  if (daysInRange(from, to) > maxDays) to = shiftDay(from, maxDays - 1);
  return { start: from, end: to };
}

export function hourlyAllowed(start, end) {
  return daysInRange(start, end) <= MAX_HOURLY_RANGE_DAYS;
}

// Keeps the chosen granularity if it is allowed for the range, otherwise falls back to daily.
export function resolveGranularity(preferred, start, end) {
  if (preferred === "hourly" && !hourlyAllowed(start, end)) return "daily";
  return preferred === "hourly" ? "hourly" : "daily";
}

// A sensible first choice for a range: hourly for one or two days, daily beyond that.
export function suggestGranularity(start, end) {
  return daysInRange(start, end) <= 2 ? "hourly" : "daily";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Axis tick for a bucket label ("2026-11-04" daily, "2026-11-04 09:00" hourly).
export function formatTick(label, granularity) {
  const [day, time] = String(label || "").split(" ");
  const [, m, d] = String(day).split("-").map(Number);
  if (!m || !d) return String(label || "");
  const dayText = `${MONTHS[m - 1]} ${d}`;
  if (granularity !== "hourly") return dayText;
  return time === "00:00" ? `${dayText} 00:00` : time;
}

export function formatBucketTitle(label, granularity) {
  const [day, time] = String(label || "").split(" ");
  const [y, m, d] = String(day).split("-").map(Number);
  if (!m || !d) return String(label || "");
  const dayText = `${MONTHS[m - 1]} ${d}, ${y}`;
  return granularity === "hourly" && time ? `${dayText}, ${time}` : dayText;
}

// 759 -> "12h 39m", 45 -> "45m", 1500 -> "1d 1h"
export function formatDuration(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes))) return "-";
  const total = Math.max(0, Math.round(Number(minutes)));
  if (total < 60) return `${total}m`;
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

// ---- product / variant filter ---------------------------------------------------------------------------------

export const FILTER_OPTION_LIMIT = 300;

export function selectionKey(productId, variantId = null) {
  return variantId ? `v:${productId}:${variantId}` : `p:${productId}`;
}

// Flat list for the filter, no group headers: a product row (its name, and how many variants or the SKU of its only
// variant), followed by one row per variant when it has more than one.
export function buildFilterOptions(products = []) {
  const options = [];
  for (const product of products) {
    const title = product.title || `Product ${product.product_id}`;
    const variants = product.variants || [];
    const many = variants.length > 1;
    options.push({
      key: selectionKey(product.product_id),
      kind: "product",
      productId: String(product.product_id),
      variantId: null,
      title,
      label: title,
      subtitle: many ? `${variants.length} variants` : (variants[0] && variants[0].sku) || "",
      count: product.stock_outs || 0,
      outNow: (product.out_now || 0) > 0,
    });
    if (many) {
      for (const variant of variants) {
        options.push({
          key: selectionKey(product.product_id, variant.variant_id),
          kind: "variant",
          productId: String(product.product_id),
          variantId: String(variant.variant_id),
          title,
          label: variant.sku || `Variant ${variant.variant_id}`,
          subtitle: "",
          count: variant.stock_outs || 0,
          outNow: !!variant.out_now,
        });
      }
    }
  }
  return options;
}

// What the filter box shows for a choice: the product name, or "name - SKU" for a single variant.
export function optionText(option) {
  if (!option) return "";
  return option.kind === "variant" ? `${option.title} - ${option.label}` : option.title;
}

// Case-insensitive "contains" over the product title, SKU and ids; capped so a huge list stays fast.
export function filterOptions(options, query, limit = FILTER_OPTION_LIMIT) {
  const needle = String(query || "").trim().toLowerCase();
  const matches = needle
    ? options.filter((o) => `${o.title} ${o.label} ${o.subtitle} ${o.productId} ${o.variantId || ""}`.toLowerCase().includes(needle))
    : options;
  return matches.slice(0, limit);
}

// The option that stands for the current selection, even when it is not in the loaded list (for example a
// product picked in the table that had no stock-out in this range).
export function optionForSelection(selection, options) {
  if (!selection || !selection.productId) return null;
  const key = selectionKey(selection.productId, selection.variantId || null);
  const found = options.find((o) => o.key === key);
  if (found) return found;
  const title = selection.title || `Product ${selection.productId}`;
  return {
    key,
    kind: selection.variantId ? "variant" : "product",
    productId: String(selection.productId),
    variantId: selection.variantId ? String(selection.variantId) : null,
    title,
    label: selection.variantId ? selection.variantLabel || `Variant ${selection.variantId}` : title,
    subtitle: "",
    count: 0,
    outNow: false,
  };
}

// An ISO instant shown in the brand's timezone, e.g. "4 Nov, 9:55 am".
export function formatInstant(isoString, timezone) {
  if (!isoString) return "-";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "-";
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: timezone || "Asia/Kolkata",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}
