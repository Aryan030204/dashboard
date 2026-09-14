const { QueryTypes } = require("sequelize");

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

const VALUE_TYPES = new Set(["flat", "percentage"]);
const MISSING_TABLE_CODES = new Set(["ER_NO_SUCH_TABLE", "ER_BAD_DB_ERROR"]);

function isMissingTableError(error) {
  const code = error?.code || error?.original?.code || error?.parent?.code;
  return MISSING_TABLE_CODES.has(code);
}

// Returns the active configs for a brand as of a given date, keyed by
// category. Where several rows overlap for the same category, the one with
// the latest effective_from wins (rows are ordered newest-first and only
// the first hit per category is kept).
//
// Tolerant of the table not existing yet (pre-migration brands) — callers
// get back an empty map rather than a 500, same pattern as
// pnlAdSpendRollup.service.js's { available: false } fallback.
async function getActiveConfigs(conn, { asOfDate }) {
  if (!conn || !asOfDate) return {};

  let rows;
  try {
    rows = await conn.query(
      `
        SELECT category, value_type, value
        FROM pnl_cost_configs
        WHERE is_active = 1
          AND effective_from <= ?
          AND (effective_to IS NULL OR effective_to >= ?)
        ORDER BY effective_from DESC
      `,
      {
        type: QueryTypes.SELECT,
        replacements: [asOfDate, asOfDate],
      },
    );
  } catch (error) {
    if (isMissingTableError(error)) return {};
    throw error;
  }

  const configByCategory = {};
  for (const row of rows) {
    if (configByCategory[row.category]) continue; // newest effective_from already kept
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

module.exports = {
  CATEGORY_FIELD_MAP,
  getActiveConfigs,
  applyCostConfigs,
};
