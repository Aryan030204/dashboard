const TotalConfig = require("../shared/db/models/TotalConfig.mongo");
const { resolveBrandRef } = require("../shared/db/models/Tenant.mongo");

const { COST_FIELDS, VALUE_TYPES } = TotalConfig;

// One document per brand in `total_config`: gst_pct + every cost line. The
// P&L worker reads the same document when it builds overall_pnl, so this
// service is only an editor - it never derives P&L figures itself.

const COST_LABELS = {
  cogs: "COGS (SKU level)",
  freight_inwards: "Freight Inwards",
  shipping: "Shipping / Logistics",
  rto: "RTO Cost",
  payment_gateway: "Payment Gateway / Commission",
  packaging: "Packaging",
  meta: "Meta Ads",
  google: "Google Ads",
  other_paid: "Other Paid Channels",
  influencers: "Influencers",
  content: "Content / Creative",
  sponsorships: "Sponsorships",
  other_brand: "Other Brand Marketing",
  salaries: "Salaries",
  rent: "Rent",
  technology: "Technology",
  agency_fees: "Agency Fees",
  other_overheads: "Other Overheads",
};

const DEFAULT_GST_PCT = 18;
const VALUE_TYPE_SET = new Set(VALUE_TYPES);

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function normalizeBrandKey(brandKey) {
  const key = String(brandKey || "").trim().toUpperCase();
  if (!key) throw badRequest("brand_key is required");
  return key;
}

function assertCostField(field) {
  if (!COST_FIELDS.includes(field)) {
    throw badRequest(`Unknown cost field: ${field}. Known: ${COST_FIELDS.join(", ")}`);
  }
}

// { value, value_type } -> validated cost line, or null to clear it.
function normalizeCostLine(field, raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "object") throw badRequest(`${field} must be an object { value, value_type } or null`);
  const valueType = String(raw.value_type ?? raw.valueType ?? "flat").trim();
  if (!VALUE_TYPE_SET.has(valueType)) {
    throw badRequest(`${field}.value_type must be one of ${VALUE_TYPES.join(", ")}`);
  }
  const value = Number(raw.value);
  if (!Number.isFinite(value) || value < 0) throw badRequest(`${field}.value must be a number >= 0`);
  if (valueType === "percentage" && value > 100) throw badRequest(`${field}.value cannot exceed 100%`);
  return { value_type: valueType, value };
}

function normalizeGstPct(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) throw badRequest("gst_pct must be between 0 and 100");
  return value;
}

function costLineToApi(line) {
  if (!line) return null;
  return { valueType: line.value_type, value: Number(line.value) };
}

// The shape the editor (and anything else) consumes. `exists` tells the UI
// whether the brand has a document yet; costs are always fully enumerated.
function toApiShape(brandKey, doc) {
  const costs = {};
  for (const field of COST_FIELDS) {
    costs[field] = costLineToApi(doc?.costs?.[field]);
  }
  return {
    brandId: brandKey,
    exists: Boolean(doc),
    gstPct: doc?.gst_pct ?? DEFAULT_GST_PCT,
    costs,
    labels: COST_LABELS,
    notes: doc?.notes ?? null,
    updatedByEmail: doc?.updated_by_email ?? null,
    updatedAt: doc?.updated_at ?? null,
  };
}

async function findDoc(brandKey) {
  return TotalConfig.findOne({ brand_id: brandKey }).lean();
}

async function getTotalConfig(brandKey) {
  const key = normalizeBrandKey(brandKey);
  return toApiShape(key, await findDoc(key));
}

// Applies a partial update to the brand's single document (creating it on
// first save). `$set` paths are per-field so two editors saving different
// lines don't clobber each other.
async function applyUpdate(brandKey, set, updatedByEmail) {
  const key = normalizeBrandKey(brandKey);
  const brandRef = await resolveBrandRef(key);
  const doc = await TotalConfig.findOneAndUpdate(
    { brand_id: key },
    {
      $set: { ...set, brand: brandRef, updated_by_email: updatedByEmail || null },
      $setOnInsert: { brand_id: key, created_by_email: updatedByEmail || null },
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  ).lean();
  return toApiShape(key, doc);
}

// Whole-document save: { gst_pct?, costs?: { <field>: {value, value_type} | null }, notes? }.
// Fields not mentioned are left as they are.
async function saveTotalConfig({ brandKey, gstPct, costs, notes, updatedByEmail }) {
  const set = {};
  const gst = normalizeGstPct(gstPct);
  if (gst !== null) set.gst_pct = gst;
  if (costs && typeof costs === "object") {
    for (const [field, raw] of Object.entries(costs)) {
      assertCostField(field);
      set[`costs.${field}`] = normalizeCostLine(field, raw);
    }
  }
  if (notes !== undefined) set.notes = notes ? String(notes).trim() : null;
  if (Object.keys(set).length === 0) throw badRequest("Nothing to save");
  return applyUpdate(brandKey, set, updatedByEmail);
}

async function upsertCostLine({ brandKey, field, value, valueType, updatedByEmail }) {
  assertCostField(field);
  const line = normalizeCostLine(field, { value, value_type: valueType });
  if (!line) throw badRequest(`${field} needs a value`);
  return applyUpdate(brandKey, { [`costs.${field}`]: line }, updatedByEmail);
}

async function clearCostLine({ brandKey, field, updatedByEmail }) {
  assertCostField(field);
  return applyUpdate(brandKey, { [`costs.${field}`]: null }, updatedByEmail);
}

module.exports = {
  COST_FIELDS,
  COST_LABELS,
  DEFAULT_GST_PCT,
  getTotalConfig,
  saveTotalConfig,
  upsertCostLine,
  clearCostLine,
  // exported for tests
  normalizeCostLine,
  normalizeGstPct,
  toApiShape,
};
