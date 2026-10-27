// Pure helpers for the "Intent Report" table (no React or MUI imports, so node can test them).
// The report shows the same KPIs as the cards at the top of the Intent page, per day and for a date range.
import dayjs from "dayjs";

export const MAX_RANGE_DAYS = 366;

export const REPORT_COLUMNS = [
  { id: "sessionsStarted", label: "Total Sessions" },
  { id: "visitors", label: "Unique Visitors" },
  { id: "high", label: "High Intent Users" },
  { id: "medium", label: "Medium Intent Users" },
  { id: "low", label: "Low Intent Users" },
  { id: "productViews", label: "Product Page Views" },
  { id: "pageViews", label: "Page Views" },
  { id: "addToCart", label: "Add to Cart" },
  { id: "checkouts", label: "Checkouts Started" },
];

// In % mode: which column a figure is a share of. "prevStep" follows the funnel (visitors -> product page
// views -> add to cart -> checkouts); "share" is always a share of unique visitors. Columns that are not
// listed (Total Sessions, Unique Visitors) stay plain counts.
const PERCENT_BASE = {
  prevStep: {
    high: "visitors",
    medium: "visitors",
    low: "visitors",
    productViews: "visitors",
    pageViews: "visitors",
    addToCart: "productViews",
    checkouts: "addToCart",
  },
  share: {
    high: "visitors",
    medium: "visitors",
    low: "visitors",
    productViews: "visitors",
    pageViews: "visitors",
    addToCart: "visitors",
    checkouts: "visitors",
  },
};

const numberFormat = new Intl.NumberFormat("en-IN");

export function formatCount(value) {
  return numberFormat.format(Math.round(Number(value) || 0));
}

// The count behind a cell: visitors ("users") or sessions. Total Sessions has no unit and may be missing.
export function rawValue(row, columnId, unit) {
  if (columnId === "sessionsStarted") return row?.sessionsStarted ?? null;
  const kpi = row?.kpis?.[columnId];
  if (!kpi) return 0;
  return unit === "sessions" ? Number(kpi.sessions) || 0 : Number(kpi.users) || 0;
}

// What a cell shows: `text` for the table, `csv` for the export. `mode` is "count" or "percent"; `base`
// is "prevStep" or "share". A share is capped at 100, like the funnel bars (add to cart and checkout
// visitors are not guaranteed to be a subset of the step before).
export function cellDisplay(row, columnId, { mode = "count", unit = "users", base = "prevStep" } = {}) {
  const value = rawValue(row, columnId, unit);
  if (value === null) return { text: "-", csv: "" };

  const baseColumn = mode === "percent" ? PERCENT_BASE[base]?.[columnId] : null;
  if (!baseColumn) return { text: formatCount(value), csv: String(Math.round(value)) };

  const denominator = rawValue(row, baseColumn, unit);
  if (!denominator || denominator <= 0) return { text: "-", csv: "" };
  const pct = Math.min(100, (value / denominator) * 100);
  return { text: `${pct.toFixed(1)}%`, csv: `${pct.toFixed(1)}%` };
}

export function sortDaysDescending(days) {
  return [...(days || [])].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export function formatRangeLabel(start, end) {
  const from = dayjs(start);
  const to = dayjs(end);
  if (!from.isValid() || !to.isValid()) return "Select dates";
  if (start === end) return to.format("MMM D, YYYY");
  const sameYear = from.year() === to.year();
  return `${from.format(sameYear ? "MMM D" : "MMM D, YYYY")} - ${to.format("MMM D, YYYY")}`;
}

// "" when the range can be requested, otherwise the reason it can't.
export function validateRange(start, end) {
  const from = dayjs(start);
  const to = dayjs(end);
  if (!start || !end || !from.isValid() || !to.isValid()) return "Choose both dates.";
  if (to.isBefore(from, "day")) return "The end date is before the start date.";
  if (to.diff(from, "day") + 1 > MAX_RANGE_DAYS) return `Choose at most ${MAX_RANGE_DAYS} days.`;
  return "";
}

export function buildPresets(todayIso, pageRange) {
  const today = dayjs(todayIso);
  const lastDays = (days) => ({
    start: today.subtract(days - 1, "day").format("YYYY-MM-DD"),
    end: today.format("YYYY-MM-DD"),
  });
  return [
    { id: "page", label: "Same as page", ...pageRange },
    { id: "7d", label: "Last 7 days", ...lastDays(7) },
    { id: "14d", label: "Last 14 days", ...lastDays(14) },
    { id: "30d", label: "Last 30 days", ...lastDays(30) },
    { id: "90d", label: "Last 90 days", ...lastDays(90) },
  ];
}

export function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// `rows` are { label, row } (the range row first, then the days). Exports exactly what the table shows,
// for every day, not only the current page.
export function buildReportCsv(rows, options) {
  const header = ["Date", ...REPORT_COLUMNS.map((column) => column.label)];
  const lines = [header, ...rows.map(({ label, row }) => [
    label,
    ...REPORT_COLUMNS.map((column) => cellDisplay(row, column.id, options).csv),
  ])];
  return lines.map((line) => line.map(csvEscape).join(",")).join("\r\n");
}
