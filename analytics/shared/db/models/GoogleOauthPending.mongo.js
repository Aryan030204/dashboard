const { mongoose } = require("../mongo");

// Parks a brand's Google Ads refresh token between the two steps of "Connect
// with Google": exchanging the authorization code (which needs the app's
// client secret, so it happens server-side) and the brand submitting which
// customer id to connect. The refresh token never round-trips through the
// browser - it's decrypted straight out of this document when the brand
// finishes the picker, then this document is deleted.
//
// `created_at` carries a 15-minute TTL index: a brand who starts the OAuth
// dialog and never comes back to finish picking a customer id doesn't leave
// a live refresh token parked here indefinitely.
const googleOauthPendingSchema = new mongoose.Schema(
  {
    brand: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    brand_id: { type: String, required: true, unique: true },
    refresh_token_encrypted: { type: String, required: true },
    updated_by_email: { type: String, default: null },
    created_at: { type: Date, default: Date.now, expires: 900 },
  },
  { collection: "google_oauth_pending" },
);

module.exports = mongoose.models.GoogleOauthPending
  || mongoose.model("GoogleOauthPending", googleOauthPendingSchema);
