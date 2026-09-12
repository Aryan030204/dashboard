export const KPI_ORDER = [
  "netSales",
  "grossMarginPct",
  "cm1Pct",
  "cm2Pct",
  "cm3Pct",
  "ebitdaPct",
];

export const KPI_DEFS = {
  netSales: { label: "Net Sales", type: "currency" },
  grossMarginPct: { label: "Gross Margin %", type: "percent" },
  cm1Pct: { label: "CM1 %", type: "percent" },
  cm2Pct: { label: "CM2 %", type: "percent" },
  cm3Pct: { label: "CM3 %", type: "percent" },
  ebitdaPct: { label: "EBITDA %", type: "percent" },
};

export function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(1)}%`;
}

export function formatSignedPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

export function formatSignedPoints(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}pp`;
}

export const SECTION_LABELS = {
  revenue: "Revenue",
  grossMargin: "Gross Margin",
  cm1: "CM1 — Contribution Margin 1",
  cm2: "CM2 — Contribution Margin 2",
  cm3: "CM3 — Contribution Margin 3",
  ebitda: "EBITDA",
};

export const SECTION_ORDER = ["revenue", "grossMargin", "cm1", "cm2", "cm3", "ebitda"];
