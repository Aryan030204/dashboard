const AggregateConfig = require("../shared/db/models/AggregateConfig.mongo");
const { resolveBrandRef } = require("../shared/db/models/Tenant.mongo");

// P&L line-item keys (see pnl.service.js buildMockPnl) that can be overridden
// by a manually configured cost. Only categories that aren't derivable from
// order/ad-platform data live here — revenue fields, gst, and the ad-spend
// fields (meta/google/otherPaid) are excluded on purpose.
const CATEGORY_FIELD_MAP = {
  cogs: "cogs",
  packaging: "packaging",
  freight_inwards: "freightInwards",
  shipping: "shipping",
  rto: "rto",
  influencers: "influencers",
  content: "content",
  sponsorships: "sponsorships",
  other_brand: "otherBrand",
  salaries: "salaries",
  rent: "rent",
  technology: "technology",
  agency_fees: "agencyFees",
  other_overheads: "otherOverheads",
};

const CATEGORY_LABELS = {
  cogs: "COGS (SKU level)",
  packaging: "Packaging Cost",
  freight_inwards: "Freight Inwards",
  shipping: "Shipping",
  rto: "RTO",
  influencers: "Influencers",
  content: "Content",
  sponsorships: "Sponsorships",
  other_brand: "Other Brand Marketing",
  salaries: "Salaries",
  rent: "Rent",
  technology: "Technology",
  agency_fees: "Agency Fees",
  other_overheads: "Other Overheads",
};

const VALUE_TYPES = new Set(["flat", "percentage"]);

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// Active rows for a brand as of a date, newest effective_from first, so the
// first row seen per category is the winner when several overlap.
function findActiveRows(brandKey, asOfDate) {
  return AggregateConfig.find({
    brand_id: brandKey,
    is_active: true,
    effective_from: { $lte: asOfDate },
    $or: [{ effective_to: null }, { effective_to: { $gte: asOfDate } }],
  })
    .sort({ effective_from: -1 })
    .lean();
}

function toApiShape(row) {
  return {
    category: row.category,
    label: row.label,
    valueType: row.value_type,
    value: Number(row.value),
    frequency: row.frequency,
    effectiveFrom: row.effective_from,
    notes: row.notes || null,
    updatedByEmail: row.updated_by_email || null,
    updatedAt: row.updated_at,
  };
}

// Returns the active configs for a brand as of a given date, keyed by
// category and reduced to just what applyCostConfigs needs.
async function getActiveConfigs(brandKey, { asOfDate }) {
  if (!brandKey || !asOfDate) return {};

  const rows = await findActiveRows(brandKey, asOfDate);
  const configByCategory = {};
  for (const row of rows) {
    if (configByCategory[row.category]) continue;
    if (!VALUE_TYPES.has(row.value_type)) continue;
    configByCategory[row.category] = {
      valueType: row.value_type,
      value: Number(row.value),
    };
  }
  return configByCategory;
}

// Resolves one configured cost to a currency amount for the period: a
// "percentage" value is a percentage of Net Sales, a "flat" value is used
// as-is.
function resolveConfiguredAmount(config, netSales) {
  if (config.valueType === "percentage") {
    return Math.round((config.value / 100) * netSales);
  }
  return Math.round(config.value);
}

// Overrides the matching mocked line items with configured costs and
// re-derives every total that cascades from them, mirroring
// applyRealMetaSpend in pnl.service.js.
function applyCostConfigs(pnl, configsByCategory) {
  for (const [category, field] of Object.entries(CATEGORY_FIELD_MAP)) {
    const config = configsByCategory[category];
    if (!config) continue;
    pnl[field] = resolveConfiguredAmount(config, pnl.netSales);
  }

  pnl.grossMargin = pnl.netSales - pnl.cogs - pnl.freightInwards;
  pnl.cm1 = pnl.grossMargin - pnl.shipping - pnl.rto - pnl.paymentGateway - pnl.packaging;
  pnl.cm2 = pnl.cm1 - pnl.meta - pnl.google - pnl.otherPaid;
  pnl.cm3 = pnl.cm2 - pnl.influencers - pnl.content - pnl.sponsorships - pnl.otherBrand;
  pnl.ebitda = pnl.cm3 - pnl.salaries - pnl.rent - pnl.technology - pnl.agencyFees - pnl.otherOverheads;

  return pnl;
}

// Every category's currently-active row (as of today) in full, for the P&L
// page's config editor to prefill from.
async function listCurrentConfigs(brandKey) {
  if (!brandKey) return {};

  const rows = await findActiveRows(brandKey, todayIsoDate());
  const byCategory = {};
  for (const row of rows) {
    if (byCategory[row.category]) continue;
    byCategory[row.category] = toApiShape(row);
  }
  return byCategory;
}

// Creates a new active row for brand+category effective today and supersedes
// whatever was active before by flipping it to is_active: false — history is
// preserved, same as setting effective_to in the SQL table.
async function upsertConfig({ brandKey, category, value, valueType, frequency, notes, updatedByEmail }) {
  if (!brandKey) throw Object.assign(new Error("brand_key is required"), { status: 400 });
  if (!CATEGORY_FIELD_MAP[category]) {
    throw Object.assign(new Error(`Unknown cost category: ${category}`), { status: 400 });
  }
  if (!VALUE_TYPES.has(valueType)) {
    throw Object.assign(new Error("value_type must be 'flat' or 'percentage'"), { status: 400 });
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    throw Object.assign(new Error("value must be a number"), { status: 400 });
  }

  const brandRef = await resolveBrandRef(brandKey);

  await AggregateConfig.updateMany(
    { brand_id: brandKey, category, is_active: true },
    { $set: { is_active: false } },
  );

  const created = await AggregateConfig.create({
    brand: brandRef,
    brand_id: brandKey,
    category,
    label: CATEGORY_LABELS[category] || category,
    value_type: valueType,
    value: numericValue,
    frequency: frequency === "one_time" ? "one_time" : "recurring",
    effective_from: todayIsoDate(),
    effective_to: null,
    is_active: true,
    notes: notes || null,
    created_by_email: updatedByEmail || null,
    updated_by_email: updatedByEmail || null,
  });

  return toApiShape(created.toObject());
}

// Reverts a category to the mocked baseline by deactivating whatever is
// currently active for it — rows are kept, same reasoning as above.
async function clearConfig({ brandKey, category, updatedByEmail }) {
  if (!brandKey || !CATEGORY_FIELD_MAP[category]) {
    throw Object.assign(new Error("Unknown brand or cost category"), { status: 400 });
  }
  await AggregateConfig.updateMany(
    { brand_id: brandKey, category, is_active: true },
    { $set: { is_active: false, updated_by_email: updatedByEmail || null } },
  );
  return { cleared: true };
}

module.exports = {
  CATEGORY_FIELD_MAP,
  CATEGORY_LABELS,
  getActiveConfigs,
  applyCostConfigs,
  listCurrentConfigs,
  upsertConfig,
  clearConfig,
};
