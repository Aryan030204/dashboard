const crypto = require("crypto");
const {
  AdsAlertRule,
  ALERT_METRICS,
  ALERT_OPERATORS,
  ALERT_CHANNELS,
  ALERT_SEVERITIES,
} = require("../shared/db/models/AdsAlertRule.mongo");
const { AdsAlertEvent } = require("../shared/db/models/AdsAlertEvent.mongo");

// Editor for the brand's campaign alert rules (one `ads_alert_rules`
// document per brand) and reader of the breaches the pipeline recorded
// (`ads_alert_events`). The nightly evaluation + push lives in the
// pipeline's workers/ads_performance.py; metricValue / evaluateRule below
// are its exact mirror so the Ads page can flag a campaign for the range on
// screen without waiting for the next run. Keep both sides in sync.

const MAX_RULES = 50;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function normalizeBrandKey(brandKey) {
  const key = String(brandKey || "").trim().toUpperCase();
  if (!key) throw badRequest("brand_key is required");
  return key;
}

function nonNegative(raw, field, fallback = 0) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw badRequest(`${field} must be a number >= 0`);
  return value;
}

function oneOf(raw, allowed, field, fallback) {
  const value = raw === undefined || raw === null || raw === "" ? fallback : String(raw).trim();
  if (!allowed.includes(value)) throw badRequest(`${field} must be one of ${allowed.join(", ")}`);
  return value;
}

function normalizeRule(raw, index) {
  if (!raw || typeof raw !== "object") throw badRequest(`rules[${index}] must be an object`);
  const metric = oneOf(raw.metric, ALERT_METRICS, `rules[${index}].metric`);
  const name = String(raw.name || "").trim().slice(0, 120);
  if (!name) throw badRequest(`rules[${index}].name is required`);
  if (raw.threshold === undefined || raw.threshold === null || raw.threshold === "") {
    throw badRequest(`rules[${index}].threshold is required`);
  }
  const lookback = Math.round(nonNegative(raw.lookback_days, `rules[${index}].lookback_days`, 3));
  if (lookback < 1 || lookback > 30) throw badRequest(`rules[${index}].lookback_days must be 1-30`);
  return {
    rule_id: String(raw.rule_id || "").trim() || crypto.randomUUID(),
    name,
    channel: oneOf(raw.channel, ALERT_CHANNELS, `rules[${index}].channel`, "all"),
    metric,
    operator: oneOf(raw.operator, ALERT_OPERATORS, `rules[${index}].operator`, "below"),
    threshold: nonNegative(raw.threshold, `rules[${index}].threshold`),
    min_spend: nonNegative(raw.min_spend, `rules[${index}].min_spend`),
    min_clicks: Math.round(nonNegative(raw.min_clicks, `rules[${index}].min_clicks`)),
    lookback_days: lookback,
    severity: oneOf(raw.severity, ALERT_SEVERITIES, `rules[${index}].severity`, "medium"),
    is_active: raw.is_active === undefined ? true : Boolean(raw.is_active),
  };
}

function serialize(doc) {
  return {
    rules: (doc?.rules || []).map((rule) => ({ ...(rule.toObject ? rule.toObject() : rule) })),
    updatedAt: doc?.updated_at || null,
    updatedBy: doc?.updated_by || null,
  };
}

async function getRules(brandKey) {
  const doc = await AdsAlertRule.findOne({ brand_id: normalizeBrandKey(brandKey) }).lean();
  return serialize(doc);
}

// Replaces the whole rule list (the page always edits the full set).
async function saveRules({ brandKey, rules, updatedByEmail }) {
  const key = normalizeBrandKey(brandKey);
  if (!Array.isArray(rules)) throw badRequest("rules must be an array");
  if (rules.length > MAX_RULES) throw badRequest(`At most ${MAX_RULES} rules per brand`);
  const normalized = rules.map(normalizeRule);
  const ids = new Set();
  for (const rule of normalized) {
    if (ids.has(rule.rule_id)) rule.rule_id = crypto.randomUUID();
    ids.add(rule.rule_id);
  }
  const doc = await AdsAlertRule.findOneAndUpdate(
    { brand_id: key },
    { $set: { rules: normalized, updated_by: updatedByEmail || null } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  ).lean();
  return serialize(doc);
}

async function listEvents({ brandKey, limit = 50 }) {
  const rows = await AdsAlertEvent.find({ brand_id: normalizeBrandKey(brandKey) })
    .sort({ created_at: -1 })
    .limit(Math.max(1, Math.min(200, Number(limit) || 50)))
    .lean();
  return rows.map(({ _id, __v, ...event }) => ({ id: String(_id), ...event }));
}

// --- Evaluation (mirror of workers/ads_performance.py) ----------------------

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function metricValue(metric, row) {
  const spend = num(row.spend);
  switch (metric) {
    case "roas":
      return spend > 0 ? num(row.platform_purchase_value) / spend : null;
    case "shopify_roas":
      return spend > 0 ? num(row.utm_sales) / spend : null;
    case "lpv_rate": {
      const linkClicks = num(row.link_clicks);
      return linkClicks > 0 ? (num(row.landing_page_views) / linkClicks) * 100 : null;
    }
    case "ctr": {
      const impressions = num(row.impressions);
      return impressions > 0 ? (num(row.clicks) / impressions) * 100 : null;
    }
    case "cpc": {
      const clicks = num(row.clicks);
      return clicks > 0 ? spend / clicks : null;
    }
    case "cpa": {
      const purchases = num(row.platform_purchases);
      return purchases > 0 ? spend / purchases : null;
    }
    default:
      return null;
  }
}

// The breaching metric value, or null when `row` (one campaign summed over
// a window) doesn't breach `rule`.
function evaluateRule(rule, row) {
  if (rule.is_active === false || !ALERT_METRICS.includes(rule.metric)) return null;
  const channel = rule.channel || "all";
  if (channel !== "all" && channel !== row.channel) return null;
  if (num(row.spend) < num(rule.min_spend)) return null;
  const clicks = rule.metric === "lpv_rate" ? row.link_clicks : row.clicks;
  if (num(clicks) < num(rule.min_clicks)) return null;
  const value = metricValue(rule.metric, row);
  if (value === null) return null;
  const threshold = num(rule.threshold);
  const breached = (rule.operator || "below") === "below" ? value < threshold : value > threshold;
  return breached ? value : null;
}

// [{ rule_id, name, severity, metric, operator, threshold, value }] for one
// campaign row against every rule.
function breachesFor(rules, row) {
  const out = [];
  for (const rule of rules || []) {
    const value = evaluateRule(rule, row);
    if (value === null) continue;
    out.push({
      rule_id: rule.rule_id,
      name: rule.name,
      severity: rule.severity || "medium",
      metric: rule.metric,
      operator: rule.operator || "below",
      threshold: num(rule.threshold),
      value: Math.round(value * 100) / 100,
    });
  }
  return out;
}

module.exports = {
  getRules,
  saveRules,
  listEvents,
  metricValue,
  evaluateRule,
  breachesFor,
  normalizeRule,
};
