const { mongoose } = require("../mongo");

// Campaign alert breaches, written only by the pipeline's
// workers/ads_performance.py::evaluate_brand_alerts (one document per
// rule x campaign x window end, unique `event_key`, so a re-run never
// duplicates or re-notifies). The Ads page only reads them.
const adsAlertEventSchema = new mongoose.Schema(
  {
    event_key: { type: String, required: true, unique: true },
    brand_id: { type: String, required: true, index: true },
    rule_id: String,
    rule_name: String,
    severity: String,
    channel: String,
    campaign_id: String,
    campaign_name: String,
    metric: String,
    operator: String,
    threshold: Number,
    value: Number,
    spend: Number,
    lookback_days: Number,
    window_start: String,
    window_end: String,
    created_at: Date,
  },
  { collection: "ads_alert_events" },
);

adsAlertEventSchema.index({ brand_id: 1, created_at: -1 });

const AdsAlertEvent = mongoose.models.AdsAlertEvent || mongoose.model("AdsAlertEvent", adsAlertEventSchema);

module.exports = { AdsAlertEvent };
