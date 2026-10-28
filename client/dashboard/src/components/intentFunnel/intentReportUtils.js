// Pure helpers for the "Intent Report" table (no React or MUI imports, so node can test them).
// One row per day with exactly six columns. Every figure is the session figure ("S") of the matching KPI
// card at the top of the Intent page, so the report never defines sessions, visitors or intent its own way.
import dayjs from "dayjs";

export const MAX_RANGE_DAYS = 366;

// Exactly these columns, in this order.
export const REPORT_COLUMNS = [
  { id: "date", label: "Date", align: "left" },
  { id: "sessionsStarted", label: "Total Sessions", align: "right" },
  { id: "visitors", label: "Unique Visitors", align: "right" },
  { id: "high", label: "High Intent Users", align: "right" },
  { id: "medium", label: "Medium Intent Users", align: "right" },
  { id: "low", label: "Low Intent Users", align: "right" },
];

const numberFormat = new Intl.NumberFormat("en-IN");

export function formatCount(value) {
  return numberFormat.format(Math.round(Number(value) || 0));
}

export function formatReportDate(date) {
  const parsed = dayjs(date);
  return parsed.isValid() ? parsed.format("D MMM YYYY") : "";
}

// The session figure of a column for one day. Total Sessions is sessions started (from the daily rollup)
// and is null until the pipeline has filled that day; the other columns are the KPI cards' sessions.
export function sessionValue(day, columnId) {
  if (columnId === "sessionsStarted") return day?.sessionsStarted ?? null;
  return Number(day?.kpis?.[columnId]?.sessions) || 0;
}

// What a cell shows. `csv` is the plain number (no digit grouping) so a spreadsheet can read it.
export function cellDisplay(day, columnId) {
  if (columnId === "date") {
    const label = formatReportDate(day?.date);
    return { text: label, csv: label };
  }
  const value = sessionValue(day, columnId);
  if (value === null) return { text: "-", csv: "" };
  return { text: formatCount(value), csv: String(Math.round(value)) };
}

export function sortDaysDescending(days) {
  return [...(days || [])].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
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

export function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Exactly the table: the six columns and a row per day (every day of the range, not only the current page).
export function buildReportCsv(days) {
  const lines = [
    REPORT_COLUMNS.map((column) => column.label),
    ...days.map((day) => REPORT_COLUMNS.map((column) => cellDisplay(day, column.id).csv)),
  ];
  return lines.map((line) => line.map(csvEscape).join(",")).join("\r\n");
}

export function buildReportFilename(brandKey, start, end) {
  return `intent-report_${brandKey}_${start}_to_${end}.csv`;
}
