const { mongoose } = require("../mongo");

// One document per brand (arch-auth `ads_alert_rules`, keyed by the
// upper-cased brand_id like total_config) holding every campaign alert rule
// the Ads page configures. Read nightly by the pipeline's
// workers/ads_performance.py::evaluate_brand_alerts, which checks each
// campaign's last `lookback_days` against the rule and records breaches in
// `ads_alert_events` (see AdsAlertEvent.mongo.js). Field names are the
// cross-repo contract - keep them in sync with that worker.
//
//   metric   roas          platform purchase value / spend
//            shopify_roas  UTM-attributed Shopify sales / spend
//            lpv_rate      landing page views / link clicks * 100 (Meta only)
//            ctr           clicks / impressions * 100
//            cpc           spend / clicks
//            cpa           spend / platform purchases
//   operator below | above
//   min_spend / min_clicks  volume gates over the window (min_clicks is
//            link clicks for lpv_rate, clicks otherwise)

const ALERT_METRICS = ["roas", "shopify_roas", "lpv_rate", "ctr", "cpc", "cpa"];
const ALERT_OPERATORS = ["below", "above"];
const ALERT_CHANNELS = ["all", "meta", "google"];
const ALERT_SEVERITIES = ["low", "medium", "high"];

const ruleSchema = new mongoose.Schema(
  {
    rule_id: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    channel: { type: String, enum: ALERT_CHANNELS, default: "all" },
    metric: { type: String, enum: ALERT_METRICS, required: true },
    operator: { type: String, enum: ALERT_OPERATORS, default: "below" },
    threshold: { type: Number, required: true, min: 0 },
    min_spend: { type: Number, default: 0, min: 0 },
    min_clicks: { type: Number, default: 0, min: 0 },
    lookback_days: { type: Number, default: 3, min: 1, max: 30 },
    severity: { type: String, enum: ALERT_SEVERITIES, default: "medium" },
    is_active: { type: Boolean, default: true },
  },
  { _id: false },
);

const adsAlertRuleSchema = new mongoose.Schema(
  {
    brand_id: { type: String, required: true, unique: true, uppercase: true, trim: true },
    rules: { type: [ruleSchema], default: [] },
    updated_by: { type: String, default: null },
  },
  { collection: "ads_alert_rules", timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

const AdsAlertRule = mongoose.models.AdsAlertRule || mongoose.model("AdsAlertRule", adsAlertRuleSchema);

module.exports = {
  AdsAlertRule,
  ALERT_METRICS,
  ALERT_OPERATORS,
  ALERT_CHANNELS,
  ALERT_SEVERITIES,
};
