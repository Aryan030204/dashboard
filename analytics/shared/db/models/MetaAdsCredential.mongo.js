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
    ad_account_id: { type: String, required: true }, // act_<id>
    access_token_encrypted: { type: String, required: true },
    // "system_user" tokens (generated in Business Settings) are never sent
    // through the fb_exchange_token dance below — they're already long-lived
    // (commonly "never expires"), and re-exchanging a non-OAuth token through
    // that endpoint is not something to gamble on. "user" is the OAuth-dialog
    // token, which does go through the exchange.
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
