import dayjs from "dayjs";

// The P&L API returns the literal "-" for any figure it has no data for.
export const MISSING = "-";
// What the page shows in place of a missing figure.
export const DASH = "—";

export function isMissingValue(value) {
  return value === null || value === undefined || typeof value !== "number" || Number.isNaN(value);
}

const MINUS = "−";

// "-₹1,200" -> "−₹1,200" (a real minus sign lines up with digits).
function trueMinus(text) {
  return String(text).replace(/^-/, MINUS);
}

export function formatAmountOrMissing(formatAmount, value) {
  return isMissingValue(value) ? DASH : trueMinus(formatAmount(value));
}

// ₹12.3 L / ₹1.2 Cr / ₹12.3K, or the brand's own currency's compact form.
export function formatCompact(formatAmount, value) {
  if (isMissingValue(value)) return DASH;
  return trueMinus(formatAmount(value, { notation: "compact", maximumFractionDigits: 1 })).replace(
    /(\d)(L|Cr)$/,
    "$1 $2",
  );
}

export function formatPercent(value) {
  if (isMissingValue(value)) return DASH;
  const abs = Math.abs(value).toFixed(1);
  return `${value < 0 && abs !== "0.0" ? MINUS : ""}${abs}%`;
}

// "↑ 4.2%" / "↓ 1.3 pp" / "0.0%"; `unit` is "%" or " pp".
export function formatDelta(value, unit = "%") {
  if (isMissingValue(value)) return DASH;
  if (Math.abs(value) < 0.05) return `0.0${unit}`;
  return `${value > 0 ? "↑" : "↓"} ${Math.abs(value).toFixed(1)}${unit}`;
}

// Good / bad / flat for a change, where `higherIsBetter` is false for costs.
export function deltaTone(value, higherIsBetter = true) {
  if (isMissingValue(value) || Math.abs(value) < 0.05) return "var(--muted)";
  return value > 0 === higherIsBetter ? "var(--good)" : "var(--bad)";
}

// The currency symbol / code the brand's amounts are shown in ("₹", "AED").
export function currencyAffix(formatAmount) {
  return String(formatAmount(0)).replace(/[\d.,\s\u00a0]/g, "") || "₹";
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

// ---- KPIs --------------------------------------------------------------

// `field` is the series / line-item subtotal each KPI is charted from.
export const KPI_ORDER = ["netSales", "grossMarginPct", "cm1Pct", "cm2Pct", "cm3Pct", "ebitdaPct"];

export const KPI_DEFS = {
  netSales: { label: "Net Sales", type: "currency", field: "netSales" },
  grossMarginPct: { label: "Gross Margin %", type: "percent", field: "grossMargin" },
  cm1Pct: { label: "CM1 %", type: "percent", field: "cm1" },
  cm2Pct: { label: "CM2 %", type: "percent", field: "cm2" },
  cm3Pct: { label: "CM3 %", type: "percent", field: "cm3" },
  ebitdaPct: { label: "EBITDA %", type: "percent", field: "ebitda" },
};

// A series point's value for a KPI: the amount for Net Sales, otherwise the
// subtotal as a % of that point's Net Sales. null when it can't be computed.
export function kpiPointValue(point, metricId) {
  if (!point) return null;
  const def = KPI_DEFS[metricId];
  const net = point.netSales;
  if (def.type === "currency") return isMissingValue(net) ? null : net;
  const amount = point[def.field];
  if (isMissingValue(amount) || isMissingValue(net) || net === 0) return null;
  return (amount / net) * 100;
}

// ---- Statement ---------------------------------------------------------

export const SECTION_ORDER = ["revenue", "grossMargin", "cm1", "cm2", "cm3", "ebitda"];

export const SECTIONS = {
  revenue: { total: "netSales", formula: "Gross Sales − Discounts − Cancellations − GST" },
  grossMargin: { total: "grossMargin", formula: "Net Sales − COGS − Freight Inwards" },
  cm1: { total: "cm1", formula: "Gross Margin − Shipping − RTO − Payment Gateway − Packaging" },
  cm2: { total: "cm2", formula: "CM1 − Meta Ads − Google Ads − Other Paid Channels" },
  cm3: { total: "cm3", formula: "CM2 − Influencers − Content − Sponsorships − Other Brand Marketing" },
  ebitda: {
    total: "ebitda",
    formula: "CM3 − Salaries − Rent − Technology − Agency Fees − Other Overheads",
  },
};

// Line item key -> how the page labels and edits it.
//   kind "orders": synced from store orders, not editable here
//   kind "gst":    the brand's GST rate (total_config.gst_pct)
//   kind "cost":   a total_config cost line (`config` is its field)
//   kind "ads":    read from an ad-spend sync (`source` is the data source)
export const LINES = {
  grossSales: { label: "Gross Sales", kind: "orders" },
  discounts: { label: "Discounts", kind: "orders" },
  cancellations: { label: "Cancellations", kind: "orders" },
  gst: { label: "GST", kind: "gst" },
  netSales: { label: "Net Sales" },
  cogs: { label: "COGS", kind: "cost", config: "cogs" },
  freightInwards: { label: "Freight Inwards", kind: "cost", config: "freight_inwards" },
  grossMargin: { label: "Gross Margin" },
  shipping: { label: "Shipping / Logistics", kind: "cost", config: "shipping" },
  rto: { label: "RTO Cost", kind: "cost", config: "rto" },
  paymentGateway: { label: "Payment Gateway / Commission", kind: "cost", config: "payment_gateway" },
  packaging: { label: "Packaging", kind: "cost", config: "packaging" },
  cm1: { label: "CM1" },
  meta: { label: "Meta Ads", kind: "ads", source: "meta", sourceLabel: "Meta Ads" },
  google: { label: "Google Ads", kind: "ads", source: "google", sourceLabel: "Google Ads" },
  otherPaid: { label: "Other Paid Channels", kind: "cost", config: "other_paid" },
  cm2: { label: "CM2" },
  influencers: { label: "Influencers", kind: "cost", config: "influencers" },
  content: { label: "Content / Creative", kind: "cost", config: "content" },
  sponsorships: { label: "Sponsorships", kind: "cost", config: "sponsorships" },
  otherBrand: { label: "Other Brand Marketing", kind: "cost", config: "other_brand" },
  cm3: { label: "CM3" },
  salaries: { label: "Salaries", kind: "cost", config: "salaries" },
  rent: { label: "Rent", kind: "cost", config: "rent" },
  technology: { label: "Technology", kind: "cost", config: "technology" },
  agencyFees: { label: "Agency Fees", kind: "cost", config: "agency_fees" },
  otherOverheads: { label: "Other Overheads", kind: "cost", config: "other_overheads" },
  ebitda: { label: "EBITDA" },
};

export function lineLabel(row) {
  return LINES[row.key]?.label || String(row.label || row.key).replace(/^\(–\)\s*/, "");
}

// "Where net sales go": cost groups as shares of Net Sales. `id` is the
// statement section the group's lines sit in.
export const MIX_PARTS = [
  { id: "grossMargin", label: "Product cost", keys: ["cogs", "freightInwards"], color: "var(--s1)" },
  {
    id: "cm1",
    label: "Fulfilment",
    keys: ["shipping", "rto", "paymentGateway", "packaging"],
    color: "var(--s2)",
  },
  { id: "cm2", label: "Paid marketing", keys: ["meta", "google", "otherPaid"], color: "var(--s3)" },
  {
    id: "cm3",
    label: "Brand marketing",
    keys: ["influencers", "content", "sponsorships", "otherBrand"],
    color: "var(--s4)",
  },
  {
    id: "ebitda",
    label: "Overheads",
    keys: ["salaries", "rent", "technology", "agencyFees", "otherOverheads"],
    color: "var(--s5)",
  },
];

// ---- Dates -------------------------------------------------------------

export const ISO = "YYYY-MM-DD";

// The worker builds overall_pnl through yesterday, so presets end there.
export function rangeForPreset(preset) {
  const end = dayjs().subtract(1, "day");
  const iso = (d) => d.format(ISO);
  switch (preset) {
    case "last14":
      return { start: iso(end.subtract(13, "day")), end: iso(end) };
    case "last30":
      return { start: iso(end.subtract(29, "day")), end: iso(end) };
    case "mtd":
      return { start: iso(end.startOf("month")), end: iso(end) };
    case "months3":
      return { start: iso(end.startOf("month").subtract(2, "month")), end: iso(end) };
    case "months6":
      return { start: iso(end.startOf("month").subtract(5, "month")), end: iso(end) };
    case "months12":
      return { start: iso(end.startOf("month").subtract(11, "month")), end: iso(end) };
    case "last7":
    default:
      return { start: iso(end.subtract(6, "day")), end: iso(end) };
  }
}

export const PRESETS = {
  daily: [
    { id: "last7", label: "Last 7 days" },
    { id: "last14", label: "Last 14 days" },
    { id: "last30", label: "Last 30 days" },
    { id: "mtd", label: "Month to date" },
  ],
  monthly: [
    { id: "months3", label: "Last 3 months" },
    { id: "months6", label: "Last 6 months" },
    { id: "months12", label: "Last 12 months" },
  ],
};

export const DEFAULT_PRESET = { daily: "last7", monthly: "months6" };

export function formatRange(start, end) {
  const s = dayjs(start);
  const e = dayjs(end);
  if (!s.isValid() || !e.isValid()) return DASH;
  if (s.isSame(e, "day")) return s.format("ddd, DD MMM YYYY");
  if (s.isSame(e, "year")) return `${s.format("DD MMM")} – ${e.format("DD MMM YYYY")}`;
  return `${s.format("DD MMM YYYY")} – ${e.format("DD MMM YYYY")}`;
}

// Labels for one chart bucket ({ key, start, end }).
export function bucketLabels(bucket, granularity, count) {
  const d = dayjs(bucket.start);
  if (granularity === "monthly") {
    return {
      axis: count > 12 ? d.format("MMM YY") : d.format("MMM"),
      short: d.format("MMM YYYY"),
      full: d.format("MMMM YYYY"),
    };
  }
  return {
    axis: count <= 7 ? d.format("ddd DD") : d.format("DD"),
    short: d.format("DD MMM"),
    full: d.format("ddd, DD MMM YYYY"),
  };
}
