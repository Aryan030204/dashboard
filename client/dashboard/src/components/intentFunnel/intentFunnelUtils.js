import dayjs from "dayjs";
import { alpha } from "@mui/material/styles";

export const INTENT_COLORS = {
  high: "#10b981",
  medium: "#3b82f6",
  low: "#8b5cf6",
  neutral: "#64748b",
};

export const STEP_COLORS = {
  productViews: "#3b82f6",
  addToCart: "#60a5fa",
  checkouts: "#8b5cf6",
};

export const INTENT_LABELS = {
  high: "High Intent",
  medium: "Medium Intent",
  low: "Low Intent",
};

export const TOP_PRODUCT_TABS = [
  { value: "views", label: "By Views" },
  { value: "addToCart", label: "By Add to Cart" },
  { value: "checkouts", label: "By Checkouts" },
];

// Start events that exist in the recorded path sequences (behavioral_path_daily).
export const PATH_START_OPTIONS = [
  { value: "page_viewed", label: "Page View" },
  { value: "product_viewed", label: "Product View" },
  { value: "click", label: "Click" },
  { value: "product_added_to_cart", label: "Add to Cart" },
];

export const PATH_TOP_OPTIONS = [3, 4, 5, 6, 8];

// Path data cannot be split by intent bucket yet, so only "all" is selectable.
export const INTENT_FILTER_OPTIONS = [
  { value: "all", label: "All Users", disabled: false },
  { value: "high", label: "High Intent", disabled: true },
  { value: "medium", label: "Medium Intent", disabled: true },
  { value: "low", label: "Low Intent", disabled: true },
];

const numberFormat = new Intl.NumberFormat("en-IN");

// Adds the chart axis label and optionally rolls daily rows up to weeks.
export function prepareTrend(rows = [], granularity = "daily") {
  if (granularity !== "weekly") {
    return rows.map((row) => ({ ...row, label: dayjs(row.date).format("MMM D") }));
  }
  const weeks = new Map();
  rows.forEach((row) => {
    const weekStart = dayjs(row.date).startOf("week");
    const key = weekStart.format("YYYY-MM-DD");
    const week = weeks.get(key) || {
      date: key,
      label: weekStart.format("MMM D"),
      productViews: 0,
      addToCart: 0,
      checkouts: 0,
    };
    week.productViews += row.productViews || 0;
    week.addToCart += row.addToCart || 0;
    week.checkouts += row.checkouts || 0;
    weeks.set(key, week);
  });
  return Array.from(weeks.values());
}

export function formatCount(value) {
  return numberFormat.format(Math.round(Number(value) || 0));
}

export function formatPct(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n.toFixed(digits)}%`;
}

export function formatMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n.toFixed(1)} min`;
}

export function toneBackground(tone, isDark) {
  const color = INTENT_COLORS[tone];
  if (!color || tone === "neutral") return "background.paper";
  return alpha(color, isDark ? 0.12 : 0.07);
}
