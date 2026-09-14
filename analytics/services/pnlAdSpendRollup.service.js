const { QueryTypes } = require("sequelize");

const MISSING_TABLE_CODES = new Set(["ER_NO_SUCH_TABLE", "ER_BAD_DB_ERROR"]);

function isMissingTableError(error) {
  const code = error?.code || error?.original?.code || error?.parent?.code;
  return MISSING_TABLE_CODES.has(code);
}

// Reads Meta ad spend for a date range from pnl_meta_ad_spend_rollup — a
// table this service only ever SELECTs from. It's kept in sync by a
// separate pipeline (not part of this repo) on its own schedule, so no
// Graph API call happens on this request path anymore (see
// metaAdsCredentials.service.js for the still-live credential storage that
// pipeline reads from).
async function getAdSpend({ conn, start, end }) {
  if (!conn) {
    return { available: false, spend: null, error: "No database connection for this brand." };
  }

  let rows;
  try {
    rows = await conn.query(
      `
        SELECT COUNT(*) AS day_count, COALESCE(SUM(spend), 0) AS total_spend
        FROM pnl_meta_ad_spend_rollup
        WHERE date >= ? AND date <= ?
      `,
      {
        type: QueryTypes.SELECT,
        replacements: [start, end],
      },
    );
  } catch (error) {
    if (isMissingTableError(error)) {
      return { available: false, spend: null, error: "Meta ad spend rollup is not set up for this brand yet." };
    }
    throw error;
  }

  const row = rows?.[0];
  const dayCount = Number(row?.day_count || 0);
  if (dayCount === 0) {
    return { available: false, spend: null, error: "No synced Meta ad spend for this date range yet." };
  }

  return { available: true, spend: Number(row.total_spend || 0), error: null };
}

module.exports = {
  getAdSpend,
};
