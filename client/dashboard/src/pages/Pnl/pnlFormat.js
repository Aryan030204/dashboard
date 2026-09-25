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

// The P&L API returns the literal "-" for any figure it has no data for.
export const MISSING = "-";

export function isMissingValue(value) {
  return value === null || value === undefined || typeof value !== "number" || Number.isNaN(value);
}

export function formatPercent(value) {
  if (isMissingValue(value)) return MISSING;
  return `${value.toFixed(1)}%`;
}

export function formatSignedPercent(value) {
  if (isMissingValue(value)) return MISSING;
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

export function formatSignedPoints(value) {
  if (isMissingValue(value)) return MISSING;
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}pp`;
}

// Wraps the currency formatter so a missing amount renders as "-" instead of
// being coerced to ₹0.
export function formatAmountOrMissing(formatAmount, value) {
  return isMissingValue(value) ? MISSING : formatAmount(value);
}

// Connecting an ad account kicks the P&L worker off for the brand's last 30
// days (see analytics' pipelineClient). The rebuild runs well after the
// response comes back, so the figures on screen are still the pre-connect
// ones until it lands — say so instead of leaving the brand staring at a
// table that hasn't moved. `sync` is absent on older backends.
export function syncNotice(sync) {
  if (!sync?.syncing) return "";
  return "Spend sync in progress — reload the page in a few minutes to see the updated figures.";
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
