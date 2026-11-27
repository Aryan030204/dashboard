// Helpers for the Inventory Snapshot table. Months are "YYYY-MM" strings, dates "YYYY-MM-DD".
import { addMonths, monthLabel } from "./monthRange.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The month of yesterday and the one before it (the data ends yesterday).
export function defaultSnapshotMonths(today) {
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 7);
  return [addMonths(yesterday, -1), yesterday];
}

// Replaces one of the two months and keeps the pair in calendar order.
export function pickMonth(months, index, value) {
  const next = [...months];
  next[index] = value;
  return next.sort();
}

export const shortMonth = (month) => monthLabel(month).slice(0, 3);

export function dayParts(date) {
  const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return { weekday, label: `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}` };
}

// "Nov DRR", with the year added when both months have the same name.
export function drrHeaders(months) {
  const sameName = new Set(months.map((m) => shortMonth(m.month))).size < months.length;
  return months.map((m) => `${sameName ? monthLabel(m.month) : shortMonth(m.month)} DRR`);
}

export const formatDrr = (value) => (value == null ? "—" : Math.round(value).toLocaleString("en-IN"));
export const formatUnits = (value) => (value == null ? "—" : Number(value).toLocaleString("en-IN"));

// `sort.by` is "sku" or "drr0" / "drr1"; months without data go last whichever the direction.
export function filterAndSort(rows, search, sort) {
  const needle = String(search || "").trim().toLowerCase();
  const matching = needle
    ? rows.filter((row) => `${row.sku} ${row.title}`.toLowerCase().includes(needle))
    : [...rows];
  const sign = sort.dir === "asc" ? 1 : -1;
  const bySku = (a, b) => a.sku.localeCompare(b.sku);
  if (sort.by === "sku") return matching.sort((a, b) => sign * bySku(a, b));
  const index = sort.by === "drr0" ? 0 : 1;
  return matching.sort((a, b) => {
    const left = a.drr[index];
    const right = b.drr[index];
    if (left == null || right == null) return (left == null) - (right == null) || bySku(a, b);
    return sign * (left - right) || bySku(a, b);
  });
}

// Quoted when needed; text that a spreadsheet would read as a formula is prefixed with an apostrophe.
function csvCell(value) {
  let text = value == null ? "" : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildSnapshotCsv(data, rows) {
  const header = ["Sr No", "SKU", "Product", ...drrHeaders(data.months), ...data.days];
  const lines = rows.map((row, index) => [
    index + 1,
    row.sku,
    row.title,
    ...row.drr.map((value) => (value == null ? "" : Math.round(value))),
    ...row.units.map((value) => value ?? ""),
  ]);
  return [header, ...lines].map((line) => line.map(csvCell).join(",")).join("\n");
}
