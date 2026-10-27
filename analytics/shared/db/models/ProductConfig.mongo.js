const { mongoose } = require("../mongo");

// Per-product P&L config: one document per brand in `product_config`, the
// product-level counterpart to total_config's brand-level aggregate (same
// brand/brand_id keying convention). `product_config` is keyed by product_id
// (Shopify product id as a string) rather than a fixed schema, since which
// products exist varies per brand and changes as the catalog does:
//   product_config: { "<product_id>": { cogs: Number }, ... }
// Filled in via the "Download Template" / upload flow on the brand's cost
// configuration page (product_id + title come from that brand's own
// product_landing_mapping table; cogs is a flat per-unit currency amount).
const productConfigSchema = new mongoose.Schema(
  {
    brand: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    brand_id: { type: String, required: true, unique: true },
    product_config: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    updated_by_email: { type: String, default: null },
  },
  {
    collection: "product_config",
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    minimize: false,
  },
);

module.exports = mongoose.models.ProductConfig || mongoose.model("ProductConfig", productConfigSchema);
