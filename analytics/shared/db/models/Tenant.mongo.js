const { mongoose } = require("../mongo");

// Read-only handle on tenant-router's `tenants` collection (same arch-auth
// database) so per-brand documents in this service can hold a real ObjectId
// reference to their brand. tenant-router owns the schema and indexes —
// autoIndex is off so this model never touches them, and strict is off so
// the full document comes back if a caller ever needs more than _id.
const tenantSchema = new mongoose.Schema(
  {
    brand_id: { type: String, required: true },
  },
  { collection: "tenants", strict: false, autoIndex: false },
);

const Tenant = mongoose.models.Tenant || mongoose.model("Tenant", tenantSchema);

// Resolves a brand key ("BBB") to the tenants document's _id, or null if the
// brand isn't in the directory. Callers store both: the ObjectId as the
// reference, the key for readable queries.
async function resolveBrandRef(brandKey) {
  if (!brandKey) return null;
  const tenant = await Tenant.findOne({ brand_id: brandKey.toUpperCase() }, { _id: 1 }).lean();
  return tenant?._id || null;
}

module.exports = { Tenant, resolveBrandRef };
