const { mongoose } = require("../mongo");

// Mongo replacement for the tenant-DB `pnl_cost_configs` table (see
// analytics/scripts/migrations/003-create-pnl-cost-configs.sql) — moved here
// because analytics-service's tenant DB connections are read replicas, so
// that table could never be written to from here. One document per
// configured cost; every brand's rows live in this one collection, each
// tied to its brand by `brand` (ObjectId of the tenants document) and
// `brand_id` (the same key tenants.brand_id uses, for readable queries).
// Keys are snake_case to match both the SQL columns and the rest of the
// arch-auth database.
//
// Backs the "Brand Cost Configuration" section of the P&L page. `value` is
// a flat currency amount or a percentage of Net Sales for the period, per
// `value_type` — pnlCostConfig.service.js is the only place that interprets
// it.
//
// Only one row is "active" per brand+category at a time for a given date:
// when several overlap, pnlCostConfig.service.js takes the one with the
// latest effective_from. Superseding a value flips the old row's is_active
// (or sets effective_to) rather than deleting it, so past periods keep
// their history.
const aggregateConfigSchema = new mongoose.Schema(
  {
    brand: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    brand_id: { type: String, required: true, index: true },
    // Free-text key, not an enum — must match a key in
    // pnlCostConfig.service.js's CATEGORY_FIELD_MAP; unrecognized
    // categories are ignored by the summary endpoint.
    category: { type: String, required: true },
    label: { type: String, required: true },
    value_type: { type: String, enum: ["flat", "percentage"], default: "flat" },
    value: { type: Number, required: true },
    frequency: { type: String, enum: ["recurring", "one_time"], default: "recurring" },
    // "YYYY-MM-DD" strings, not Dates, so they compare against asOfDate the
    // same way the SQL DATE columns did.
    effective_from: { type: String, required: true },
    effective_to: { type: String, default: null },
    is_active: { type: Boolean, default: true },
    notes: { type: String, default: null },
    created_by_email: { type: String, default: null },
    updated_by_email: { type: String, default: null },
  },
  {
    collection: "aggregate_configs",
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

aggregateConfigSchema.index(
  { brand_id: 1, category: 1, is_active: 1, effective_from: -1 },
  { name: "idx_aggregate_configs_brand_category_lookup" },
);

module.exports = mongoose.models.AggregateConfig
  || mongoose.model("AggregateConfig", aggregateConfigSchema);
