const { mongoose } = require("../mongo");

// Backs the Meta Ads card on the P&L page. One document per brand, in
// analytics-service's own arch-auth database, tied to the brand by `brand`
// (ObjectId of the tenants document) and `brand_id` (the same upper-cased key
// tenants.brand_id and total_config.brand_id use, e.g. "BBB"). Deliberately
// its own collection: the tenants document carries an unrelated access_token
// that must never be touched.
//
// The access token is kept encrypted with the shared PASSWORD_AES_KEY. The
// pipeline's P&L worker reads this document, pulls the brand's daily spend
// from the Marketing API, and writes the pnl_meta_ad_spend_rollup the P&L
// summary reads; it also sets `last_error` here when a pull fails.
const metaAdsCredentialSchema = new mongoose.Schema(
  {
    brand: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    brand_id: { type: String, required: true, unique: true },
    // Ad account id(s) (act_<id>) this token is used for. A brand can grant
    // more than one during "Continue with Meta" or the manual paste fallback
    // (checkbox picker) - same shape as GoogleAdsCredential.customer_ids.
    ad_account_ids: { type: [String], default: [] },
    // Deprecated: kept as ad_account_ids[0] so the pipeline's P&L worker
    // (workers/pnl_worker.py, still single-account) keeps working until it's
    // updated to sync every id in ad_account_ids.
    ad_account_id: { type: String, required: true }, // act_<id>
    access_token_encrypted: { type: String, required: true },
    // "system_user" tokens never go through the fb_exchange_token dance in
    // the service below - they're already long-lived (commonly "never
    // expires"). Two ways in: pasted directly (generated in Business
    // Settings), or via "Continue with Meta" scoped to a Facebook Login for
    // Business configuration (Meta App Dashboard > Facebook Login for
    // Business > Configurations, access token = System-business, expiration
    // = Never) - Meta hands back a non-expiring System-business token the
    // same way. "user" is the plain OAuth-dialog token (ads_read scope, no
    // configuration), which does go through the exchange for a ~60-day token.
    token_type: { type: String, enum: ["user", "system_user"], default: "user" },
    token_expires_at: { type: Date, default: null },
    last_verified_at: { type: Date, default: null },
    last_error: { type: String, default: null },
    updated_by_email: { type: String, default: null },
  },
  {
    collection: "meta_ads_credentials",
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

module.exports = mongoose.models.MetaAdsCredential
  || mongoose.model("MetaAdsCredential", metaAdsCredentialSchema);
