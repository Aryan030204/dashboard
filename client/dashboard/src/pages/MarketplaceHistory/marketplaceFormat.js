// Pure helpers of the Marketplace history page. No imports, so `node --test` can load this file.

export const DASH = "–";

export const COLORS = {
  AMAZON: "#f59e0b",
  FLIPKART: "#3b82f6",
  MYNTRA: "#a855f7",
  BLINKIT: "#d9a406",
  NYKAA: "#14b8a6",
  ZEPTO: "#ec4899",
};
export const colorOf = (code) => COLORS[code] || "#64748b";

export const RANGES = [
  { value: "1M", label: "1M", days: 30 },
  { value: "3M", label: "3M", days: 90 },
  { value: "6M", label: "6M", days: 180 },
  { value: "all", label: "All" },
];

const pad = (n) => String(n).padStart(2, "0");
export const isoDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// What to ask the API for. `custom` ({start, end}) wins over the preset.
export function rangeParams(preset, custom, today = new Date()) {
  if (custom?.start && custom?.end) return { start: custom.start, end: custom.end };
  const days = RANGES.find((r) => r.value === preset)?.days;
  if (!days) return { range: "all" };
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  return { start: isoDay(start), end: isoDay(today) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDay(day) {
  const [, month, date] = String(day || "").split("-").map(Number);
  return month ? `${date} ${MONTHS[month - 1]}` : DASH;
}

export const dayTime = (day) => Date.parse(`${day}T00:00:00Z`);
export const timeDay = (time) => new Date(time).toISOString().slice(0, 10);

const rupees = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
export const money = (value) => (value === null || value === undefined ? DASH : `₹${rupees.format(value)}`);

// "par" within 1%, "deep" 15% or more below us.
export function band(pct) {
  if (pct === null || pct === undefined) return "none";
  if (Math.abs(pct) <= 1) return "par";
  if (pct <= -15) return "deep";
  return pct < 0 ? "below" : "above";
}

export function gapText(gap, unit) {
  const state = band(gap?.pct);
  if (state === "none") return DASH;
  if (state === "par") return "at par";
  const arrow = gap.pct < 0 ? "▼" : "▲";
  return unit === "abs" ? `${arrow} ${money(Math.abs(gap.abs))}` : `${arrow} ${Math.round(Math.abs(gap.pct))}%`;
}

export function signed(value, unit) {
  if (value === null || value === undefined) return DASH;
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return unit === "abs" ? `${sign}${money(Math.abs(value))}` : `${sign}${Math.abs(value).toFixed(1)}%`;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const priced = (row, codes) => codes.map((code) => [code, row.cells[code]]).filter(([, cell]) => cell?.state === "ok");

// Lowest marketplace price of a row among the selected marketplaces, in stock only.
export function cheapest(row, codes) {
  const best = priced(row, codes).sort(([, a], [, b]) => a.price - b.price)[0];
  return best ? { code: best[0], price: best[1].price } : null;
}

export function kpis(rows, codes) {
  const listed = rows.filter((row) => codes.some((code) => row.live.includes(code)));
  const pairs = listed.reduce((sum, row) => sum + codes.filter((code) => row.live.includes(code)).length, 0);
  const possible = listed.length * codes.length;
  const gaps = listed.flatMap((row) => priced(row, codes).map(([code, cell]) => ({ code, pct: cell.gap?.pct, row })))
    .filter((g) => g.pct !== null && g.pct !== undefined);
  const byCode = codes
    .map((code) => ({ code, pct: median(gaps.filter((g) => g.code === code).map((g) => g.pct)) }))
    .filter((entry) => entry.pct !== null)
    .sort((a, b) => a.pct - b.pct);
  return {
    tracked: listed.length,
    withPrice: listed.filter((row) => codes.some((c) => ["ok", "oos"].includes(row.cells[c]?.state))).length,
    pairs,
    possible,
    coverage: possible ? Math.round((pairs / possible) * 100) : null,
    medianGap: median(gaps.map((g) => g.pct)),
    deepBelow: new Set(gaps.filter((g) => g.pct <= -15).map((g) => g.row.variantId)).size,
    cheapest: byCode[0] || null,
  };
}

// Chart rows from the overview series; a marketplace without a value on a day is left as a gap.
export function gapRows(series, codes, { basis, stat, unit }) {
  return series.map((point) => {
    const row = { time: dayTime(point.date) };
    for (const code of codes) row[code] = point[basis]?.[code]?.[stat]?.[unit] ?? null;
    return row;
  });
}

// The most recent value of each marketplace line, with how many products it covers.
export function latestPoints(series, codes, { basis, stat, unit }) {
  return codes.map((code) => {
    for (let i = series.length - 1; i >= 0; i -= 1) {
      const value = series[i][basis]?.[code];
      if (value?.n) return { code, value: value[stat][unit], n: value.n, date: series[i].date };
    }
    return { code, value: null, n: 0, date: null };
  });
}

export function latestSentence(points, names, unit) {
  const parts = points.filter((p) => p.value !== null).sort((a, b) => a.value - b.value).map((p) => {
    const name = names[p.code] || p.code;
    if (unit === "pct" ? Math.abs(p.value) <= 1 : p.value === 0) return `${name} at par`;
    const size = unit === "abs" ? money(Math.abs(p.value)) : `${Math.round(Math.abs(p.value))}%`;
    return `${name} ${size} ${p.value < 0 ? "below" : "above"}`;
  });
  return parts.length ? `Latest: ${parts.join(", ")}.` : "No prices in this range yet.";
}

export function stats(values) {
  const list = values.filter((v) => v !== null && v !== undefined);
  if (!list.length) return null;
  const mean = list.reduce((sum, v) => sum + v, 0) / list.length;
  const latest = list[list.length - 1];
  return {
    highest: Math.max(...list),
    lowest: Math.min(...list),
    average: mean,
    latest,
    versusAverage: mean ? ((latest - mean) / mean) * 100 : 0,
  };
}

// Runs of consecutive out-of-stock days of one marketplace, as [fromTime, toTime] with half a day of width.
export function outOfStockSpans(series, code) {
  const half = 12 * 60 * 60 * 1000;
  const spans = [];
  let open = null;
  for (const point of series) {
    const time = dayTime(point.date);
    if (point.marketplaces[code]?.oos) {
      if (!open) open = [time - half, time + half];
      else open[1] = time + half;
    } else if (open) {
      spans.push(open);
      open = null;
    }
  }
  if (open) spans.push(open);
  return spans;
}

// Spreadsheet programs run cells that start like a formula, so those are quoted as text.
function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text) && Number.isNaN(Number(text))) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows, marketplaces) {
  const header = ["Product", "Size", "Our price", "MRP", ...marketplaces.flatMap((m) => [`${m.name} price`, `${m.name} gap %`]),
    "Order rank"];
  const state = { unlisted: "not listed", unread: "not read", oos: "out of stock" };
  const lines = rows.map((row) => [
    row.product, row.size, row.ourPrice, row.mrp,
    ...marketplaces.flatMap((m) => {
      const cell = row.cells[m.code];
      return cell?.state === "ok" ? [cell.price, cell.gap?.pct] : [state[cell?.state] || "", ""];
    }),
    row.rank,
  ]);
  return [header, ...lines].map((line) => line.map(csvCell).join(",")).join("\n");
}
