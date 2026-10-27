export const MISSING = "-";

export const CHANNEL_LABELS = { all: "All channels", meta: "Meta", google: "Google" };

// Categorical slots 1-2 (validated light + dark): channel identity everywhere
// on the page, so Meta is always blue and Google always orange.
export const CHANNEL_COLORS = {
  light: { meta: "#2a78d6", google: "#eb6834" },
  dark: { meta: "#3987e5", google: "#d95926" },
};

export function isMissing(value) {
  return value === null || value === undefined || Number.isNaN(value);
}

export function formatRoas(value) {
  return isMissing(value) ? MISSING : `${Number(value).toFixed(2)}x`;
}

export function formatPct(value, digits = 1) {
  return isMissing(value) ? MISSING : `${Number(value).toFixed(digits)}%`;
}

export function formatCount(value) {
  return isMissing(value) ? MISSING : Math.round(Number(value)).toLocaleString("en-IN");
}

export function formatSeconds(value) {
  return isMissing(value) ? MISSING : `${Number(value).toFixed(2)}s`;
}

export function formatSignedPct(value) {
  if (isMissing(value)) return null;
  const n = Number(value);
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

// Alert rule vocabulary - mirrors analytics/shared/db/models/AdsAlertRule.mongo.js.
export const ALERT_METRICS = [
  { id: "roas", label: "ROAS (platform)", unit: "x", hint: "Purchase value Meta/Google report ÷ spend" },
  { id: "shopify_roas", label: "ROAS (Shopify UTM)", unit: "x", hint: "UTM-attributed Shopify sales ÷ spend" },
  { id: "lpv_rate", label: "LC → LPV rate", unit: "%", hint: "Landing page views ÷ link clicks (Meta only)" },
  { id: "ctr", label: "CTR", unit: "%", hint: "Clicks ÷ impressions" },
  { id: "cpc", label: "CPC", unit: "currency", hint: "Spend ÷ clicks" },
  { id: "cpa", label: "CPA", unit: "currency", hint: "Spend ÷ platform purchases" },
];

export const ALERT_METRIC_BY_ID = Object.fromEntries(ALERT_METRICS.map((m) => [m.id, m]));

export function formatMetric(metricId, value, formatAmount) {
  const unit = ALERT_METRIC_BY_ID[metricId]?.unit;
  if (unit === "x") return formatRoas(value);
  if (unit === "%") return formatPct(value);
  if (unit === "currency") return isMissing(value) ? MISSING : formatAmount(value);
  return isMissing(value) ? MISSING : String(value);
}

// One-click starting points covering the Datum asks: campaign RoAS, LC->LPV
// (site speed) and Google campaign performance.
export const RULE_PRESETS = [
  {
    name: "Meta campaign ROAS below 1.5x",
    channel: "meta",
    metric: "roas",
    operator: "below",
    threshold: 1.5,
    min_spend: 5000,
    min_clicks: 0,
    lookback_days: 3,
    severity: "high",
  },
  {
    name: "Google campaign ROAS below 2x",
    channel: "google",
    metric: "roas",
    operator: "below",
    threshold: 2,
    min_spend: 5000,
    min_clicks: 0,
    lookback_days: 3,
    severity: "high",
  },
  {
    name: "LC → LPV below 60% (slow landing page?)",
    channel: "meta",
    metric: "lpv_rate",
    operator: "below",
    threshold: 60,
    min_spend: 0,
    min_clicks: 300,
    lookback_days: 1,
    severity: "medium",
  },
  {
    name: "Google CPC above ₹30",
    channel: "google",
    metric: "cpc",
    operator: "above",
    threshold: 30,
    min_spend: 2000,
    min_clicks: 0,
    lookback_days: 3,
    severity: "low",
  },
];
