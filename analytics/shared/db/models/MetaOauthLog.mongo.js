const { mongoose } = require("../mongo");

// Backs the "Connect with Meta" proof-of-concept (POST /pnl/meta-ads/oauth/log):
// proves the OAuth redirect round-trip works end to end before the token is
// wired into the real meta_ads_credentials table. One document per brand,
// tied to it by `brand` (ObjectId of the tenants document) and `brand_id`
// (the same key tenants.brand_id uses). Keys are snake_case to match the
// rest of the arch-auth database.
const metaOauthLogSchema = new mongoose.Schema(
  {
    brand: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    // One row per brand is enforced by the upsert in saveOauthLog, not by a
    // unique index — a unique index would refuse to build while legacy rows
    // without brand_id are still around (they all index as null).
    brand_id: { type: String, required: true, index: true },
    access_token: { type: String, required: true },
    expires_in: { type: String, default: null },
    updated_by_email: { type: String, default: null },
    captured_at: { type: Date, default: Date.now },
  },
  {
    collection: "meta_oauth_logs",
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

module.exports = mongoose.models.MetaOauthLog
  || mongoose.model("MetaOauthLog", metaOauthLogSchema);
