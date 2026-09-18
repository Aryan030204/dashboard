const { mongoose } = require("../mongo");

// Backs the "Connect with Google" flow on the P&L page. One document per
// brand, in analytics-service's own arch-auth database, tied to the brand by
// `brand` (ObjectId of the tenants document) and `brand_id` (the same key
// tenants.brand_id uses). Deliberately its own collection: the tenants
// document carries an unrelated access_token that must never be touched.
//
// The refresh token is the durable credential — Google access tokens last an
// hour, the refresh token lasts until the user revokes it — so both are kept
// (encrypted with the shared PASSWORD_AES_KEY) and the access token is
// re-minted from the refresh token whenever it's stale.
const customerSchema = new mongoose.Schema(
  {
    id: { type: String, required: true }, // digits only, no dashes
    name: { type: String, default: null },
    currency_code: { type: String, default: null },
    manager: { type: Boolean, default: false },
  },
  { _id: false },
);

const googleAdsOauthTokenSchema = new mongoose.Schema(
  {
    brand: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    brand_id: { type: String, required: true, index: true },
    refresh_token_encrypted: { type: String, required: true },
    access_token_encrypted: { type: String, default: null },
    access_token_expires_at: { type: Date, default: null },
    scope: { type: String, default: null },
    // The Google Ads customer id spend is pulled for. Null until the brand
    // picks one (or types one in) after connecting.
    customer_id: { type: String, default: null },
    // Every customer the connected Google user can access, as listed by
    // customers:listAccessibleCustomers at connect time (needs a developer token).
    accessible_customers: { type: [customerSchema], default: [] },
    updated_by_email: { type: String, default: null },
    captured_at: { type: Date, default: Date.now },
    last_error: { type: String, default: null },
  },
  {
    collection: "google_ads_oauth_tokens",
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

module.exports = mongoose.models.GoogleAdsOauthToken
  || mongoose.model("GoogleAdsOauthToken", googleAdsOauthTokenSchema);
