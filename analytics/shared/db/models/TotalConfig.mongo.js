const { mongoose } = require("../mongo");

// Replaces the per-category `aggregate_configs` collection with ONE document
// per brand holding the whole P&L cost configuration: the GST rate plus
// every cost line, keyed by `brand_id` (the same key tenants.brand_id uses,
// e.g. "BBB"). Keys are snake_case to match the rest of the arch-auth
// database and the P&L worker's column names.
//
// Each cost line is either null (not configured -> the worker falls back to
// its defaults for that line) or { value_type, value } where:
//   value_type "percentage" -> `value` % of that day's Net Sales
//   value_type "flat"       -> `value` is a MONTHLY currency amount, prorated
//                              per calendar day by the worker
//
// Read by the P&L worker (pipeline repo) when it builds overall_pnl, and by
// the dashboard's "Brand Cost Configuration" editor. This model's list of
// cost lines is the contract both sides share.

const COST_FIELDS = [
  "cogs",
  "freight_inwards",
  "shipping",
  "rto",
  "payment_gateway",
  "packaging",
  "meta",
  "google",
  "other_paid",
  "influencers",
  "content",
  "sponsorships",
  "other_brand",
  "salaries",
  "rent",
  "technology",
  "agency_fees",
  "other_overheads",
];

const VALUE_TYPES = ["flat", "percentage"];

const costLineSchema = new mongoose.Schema(
  {
    value_type: { type: String, enum: VALUE_TYPES, required: true },
    value: { type: Number, required: true },
  },
  { _id: false },
);

const costsShape = Object.fromEntries(
  COST_FIELDS.map((field) => [field, { type: costLineSchema, default: null }]),
);

const totalConfigSchema = new mongoose.Schema(
  {
    brand: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    brand_id: { type: String, required: true, unique: true },
    gst_pct: { type: Number, default: 18, min: 0, max: 100 },
    costs: { type: new mongoose.Schema(costsShape, { _id: false }), default: () => ({}) },
    notes: { type: String, default: null },
    created_by_email: { type: String, default: null },
    updated_by_email: { type: String, default: null },
  },
  {
    collection: "total_config",
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    minimize: false,
  },
);

const TotalConfig = mongoose.models.TotalConfig || mongoose.model("TotalConfig", totalConfigSchema);

module.exports = TotalConfig;
module.exports.COST_FIELDS = COST_FIELDS;
module.exports.VALUE_TYPES = VALUE_TYPES;
