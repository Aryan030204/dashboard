const { mongoose } = require("../mongo");

// Parks a brand's Meta System-business access token between the two steps of
// "Continue with Meta": exchanging the authorization code (which needs the
// app secret, so it happens server-side) and the brand picking which ad
// account to connect from the list the token can see. The token never
// round-trips through the browser — it's decrypted straight out of this
// document when the brand finishes the picker, then this document is
// deleted. Same shape and convention as GoogleOauthPending.mongo.js.
//
// `created_at` carries a 15-minute TTL index: a brand who starts the OAuth
// dialog and never comes back to finish picking an ad account doesn't leave
// a live access token parked here indefinitely.
const metaOauthPendingSchema = new mongoose.Schema(
  {
    brand: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    brand_id: { type: String, required: true, unique: true },
    access_token_encrypted: { type: String, required: true },
    updated_by_email: { type: String, default: null },
    created_at: { type: Date, default: Date.now, expires: 900 },
  },
  { collection: "meta_oauth_pending" },
);

module.exports = mongoose.models.MetaOauthPending
  || mongoose.model("MetaOauthPending", metaOauthPendingSchema);
