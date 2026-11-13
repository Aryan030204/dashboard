const mongoose = require("mongoose");

// Collection: fireflies_connections. ONE common Fireflies account for the whole of Datum (V1), enforced by the
// unique connection_key. The API key is only ever stored encrypted (AES-256-CBC): ciphertext + its IV. The AES
// key lives in the server environment and is never written here. There is no plaintext key field.
const FirefliesConnectionSchema = new mongoose.Schema(
  {
    connection_key: { type: String, required: true, unique: true, default: "common" },
    account_email: { type: String, default: "" },
    encrypted_api_key: { type: String, required: true },
    encryption_iv: { type: String, required: true },
    encryption_algorithm: { type: String, required: true, enum: ["AES-256-CBC"], default: "AES-256-CBC" },
    status: { type: String, enum: ["ACTIVE", "DISABLED"], default: "ACTIVE" },
  },
  { collection: "fireflies_connections", timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

module.exports = mongoose.models.FirefliesConnection || mongoose.model("FirefliesConnection", FirefliesConnectionSchema);
