const { mongoose } = require("../mongo");

// Backs the Google Ads card on the P&L page. One document per brand, in
// analytics-service's own arch-auth database, tied to the brand by `brand`
// (ObjectId of the tenants document) and `brand_id` (the same upper-cased key
// tenants.brand_id and total_config.brand_id use, e.g. "BBB"). Deliberately
// its own collection: the tenants document carries an unrelated access_token
// that must never be touched.
//
// The merchant pastes the token themselves (no OAuth dance here); it's kept
// encrypted with the shared PASSWORD_AES_KEY. This service never calls Google
// with it — the pipeline's Google Ads sync reads this document, pulls spend,
// and writes the daily rollup the P&L summary reads.
const googleAdsCredentialSchema = new mongoose.Schema(
  {
    brand: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    brand_id: { type: String, required: true, unique: true },
    // Google Ads customer id spend is pulled for. Digits only, no dashes.
    customer_id: { type: String, required: true },
    // Optional manager (MCC) customer id when the account is reached through
    // a manager account. Digits only.
    login_customer_id: { type: String, default: null },
    token_encrypted: { type: String, required: true },
    // Last few characters of the token, so the dashboard can show which token
    // is stored without ever sending the token back out.
    token_suffix: { type: String, default: null },
    updated_by_email: { type: String, default: null },
    captured_at: { type: Date, default: Date.now },
    // Set by whatever last tried to use the token (the pipeline sync), so the
    // dashboard can surface a broken token without holding the token itself.
    last_error: { type: String, default: null },
  },
  {
    collection: "google_ads_credentials",
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

module.exports = mongoose.models.GoogleAdsCredential
  || mongoose.model("GoogleAdsCredential", googleAdsCredentialSchema);
