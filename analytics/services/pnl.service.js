const { QueryTypes } = require("sequelize");

// Every P&L figure comes from the per-brand `overall_pnl` table, which the
// pipeline's P&L worker rebuilds nightly (one row per date, costs already
// resolved from the brand's cost configs and the Meta ad-spend rollup). This
// service only sums those rows for the requested and previous ranges — it
// never derives or estimates a number itself. Anything the table can't back
// is returned as the literal string "-".
const PNL_TABLE = "overall_pnl";
const MISSING = "-";

const MISSING_TABLE_CODES = new Set(["ER_NO_SUCH_TABLE", "ER_BAD_DB_ERROR"]);

// overall_pnl column -> API field.
const COLUMN_FIELD_MAP = {
  gross_sales: "grossSales",
  discounts: "discounts",
  cancellations: "cancellations",
  gst: "gst",
  net_sales: "netSales",
  cogs: "cogs",
  freight_inwards: "freightInwards",
  gross_margin: "grossMargin",
  shipping: "shipping",
  rto: "rto",
  payment_gateway: "paymentGateway",
  packaging: "packaging",
  cm1: "cm1",
  meta: "meta",
  google: "google",
  other_paid: "otherPaid",
  cm2: "cm2",
  influencers: "influencers",
  content: "content",
  sponsorships: "sponsorships",
  other_brand: "otherBrand",
  cm3: "cm3",
  salaries: "salaries",
  rent: "rent",
  technology: "technology",
  agency_fees: "agencyFees",
  other_overheads: "otherOverheads",
  ebitda: "ebitda",
};

// Cost lines the worker writes as 0 when nothing was attributed for the day
// (no active cost config, no synced spend). A zero total over the range means
// "no value", not "cost of zero", so those surface as "-".
const COST_FIELDS = new Set([
  "cogs",
  "freightInwards",
  "shipping",
  "rto",
  "paymentGateway",
  "packaging",
  "meta",
  "google",
  "otherPaid",
  "influencers",
  "content",
  "sponsorships",
  "otherBrand",
  "salaries",
  "rent",
  "technology",
  "agencyFees",
  "otherOverheads",
]);

function isMissingTableError(error) {
  const code = error?.code || error?.original?.code || error?.parent?.code;
  return MISSING_TABLE_CODES.has(code);
}

function isMissing(value) {
  return value === MISSING || value === null || value === undefined || Number.isNaN(value);
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function parseDateUTC(str) {
  const [y, m, d] = String(str).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDateUTC(date) {
  return date.toISOString().slice(0, 10);
}

function addDaysUTC(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function daysBetweenInclusive(start, end) {
  const diff = parseDateUTC(end) - parseDateUTC(start);
  return Math.max(1, Math.round(diff / 86400000) + 1);
}

function computePreviousRange(start, end, granularity) {
  if (granularity === "monthly") {
    const s = parseDateUTC(start);
    const prevMonthStart = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() - 1, 1));
    const prevMonthEnd = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 0));
    return [formatDateUTC(prevMonthStart), formatDateUTC(prevMonthEnd)];
  }
  const lengthDays = daysBetweenInclusive(start, end);
  const prevEnd = addDaysUTC(parseDateUTC(start), -1);
  const prevStart = addDaysUTC(prevEnd, -(lengthDays - 1));
  return [formatDateUTC(prevStart), formatDateUTC(prevEnd)];
}

// Sums the brand's overall_pnl rows over [start, end]. Rows are keyed by
// brand_key (the upper-cased brand tag the P&L worker writes). Resolves to
// { dayCount: 0 } when the brand has no connection, no table yet, or no rows
// in the range.
async function fetchPnlTotals({ conn, brandKey, start, end }) {
  if (!conn || !brandKey) return { dayCount: 0, metaSyncedDays: 0, totals: {} };

  const sums = Object.keys(COLUMN_FIELD_MAP)
    .map((col) => `COALESCE(SUM(\`${col}\`), 0) AS \`${col}\``)
    .join(",\n          ");

  let rows;
  try {
    rows = await conn.query(
      `
        SELECT
          COUNT(*) AS day_count,
          COALESCE(SUM(meta_spend_synced), 0) AS meta_synced_days,
          ${sums}
        FROM \`${PNL_TABLE}\`
        WHERE \`brand_key\` = ? AND \`date\` >= ? AND \`date\` <= ?
      `,
      { type: QueryTypes.SELECT, replacements: [String(brandKey).toUpperCase(), start, end] },
    );
  } catch (error) {
    if (isMissingTableError(error)) return { dayCount: 0, metaSyncedDays: 0, totals: {} };
    throw error;
  }

  const row = rows?.[0] || {};
  const totals = {};
  for (const [col, field] of Object.entries(COLUMN_FIELD_MAP)) {
    totals[field] = round2(row[col] || 0);
  }
  return {
    dayCount: Number(row.day_count || 0),
    metaSyncedDays: Number(row.meta_synced_days || 0),
    totals,
  };
}

// Turns range totals into the per-line figures the response carries. With no
// rows every line is "-"; with rows, revenue lines and subtotals are the
// summed values and unattributed cost lines are "-".
function buildPeriod({ dayCount, totals }) {
  const period = {};
  for (const field of Object.values(COLUMN_FIELD_MAP)) {
    if (dayCount === 0) {
      period[field] = MISSING;
      continue;
    }
    const amount = totals[field];
    period[field] = COST_FIELDS.has(field) && amount === 0 ? MISSING : amount;
  }
  return period;
}

function negate(amount) {
  return isMissing(amount) ? MISSING : -amount;
}

function pctOfNetSales(amount, netSales) {
  if (isMissing(amount) || isMissing(netSales) || netSales === 0) return MISSING;
  return Math.round((amount / netSales) * 1000) / 10;
}

function changePct(current, previous) {
  if (isMissing(current) || isMissing(previous)) return MISSING;
  if (previous === 0) return current === 0 ? 0 : MISSING;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

function buildLineItems(curr, prev, { metaIsLive = false } = {}) {
  const rows = [];
  const push = (key, label, amount, previousAmount, opts = {}) => {
    rows.push({
      key,
      label,
      amount,
      pctOfNetSales: pctOfNetSales(amount, curr.netSales),
      previousAmount,
      changePct: changePct(amount, previousAmount),
      ...opts,
    });
  };
  const deduction = (key, label, section, opts = {}) =>
    push(key, label, negate(curr[key]), negate(prev[key]), { section, isDeduction: true, ...opts });
  const subtotal = (key, label, section) =>
    push(key, label, curr[key], prev[key], { section, isSubtotal: true });

  push("grossSales", "Gross Sales", curr.grossSales, prev.grossSales, { section: "revenue" });
  deduction("discounts", "(–) Discounts", "revenue");
  deduction("cancellations", "(–) Cancellations", "revenue");
  deduction("gst", "(–) GST", "revenue");
  subtotal("netSales", "Net Sales", "revenue");

  deduction("cogs", "(–) COGS", "grossMargin");
  deduction("freightInwards", "(–) Freight Inwards", "grossMargin");
  subtotal("grossMargin", "Gross Margin", "grossMargin");

  deduction("shipping", "(–) Shipping / Logistics", "cm1");
  deduction("rto", "(–) RTO Cost", "cm1");
  deduction("paymentGateway", "(–) Payment Gateway / Commission", "cm1");
  deduction("packaging", "(–) Packaging", "cm1");
  subtotal("cm1", "CM1", "cm1");

  deduction("meta", "(–) Meta", "cm2", { isSubItem: true, isLive: metaIsLive });
  deduction("google", "(–) Google", "cm2", { isSubItem: true });
  deduction("otherPaid", "(–) Other Paid Channels", "cm2", { isSubItem: true });
  subtotal("cm2", "CM2", "cm2");

  deduction("influencers", "(–) Influencers", "cm3", { isSubItem: true });
  deduction("content", "(–) Content / Creative", "cm3", { isSubItem: true });
  deduction("sponsorships", "(–) Sponsorships", "cm3", { isSubItem: true });
  deduction("otherBrand", "(–) Other Brand Marketing", "cm3", { isSubItem: true });
  subtotal("cm3", "CM3", "cm3");

  deduction("salaries", "(–) Salaries", "ebitda", { isSubItem: true });
  deduction("rent", "(–) Rent", "ebitda", { isSubItem: true });
  deduction("technology", "(–) Technology", "ebitda", { isSubItem: true });
  deduction("agencyFees", "(–) Agency Fees", "ebitda", { isSubItem: true });
  deduction("otherOverheads", "(–) Other Overheads", "ebitda", { isSubItem: true });
  subtotal("ebitda", "EBITDA", "ebitda");

  return rows;
}

function buildKpi(currentAmount, previousAmount) {
  return {
    value: isMissing(currentAmount) ? MISSING : currentAmount,
    previousValue: isMissing(previousAmount) ? MISSING : previousAmount,
    changePct: changePct(currentAmount, previousAmount),
  };
}

function buildMarginKpi(currentMargin, currentNetSales, previousMargin, previousNetSales) {
  const currentPct = pctOfNetSales(currentMargin, currentNetSales);
  const previousPct = pctOfNetSales(previousMargin, previousNetSales);
  return {
    value: currentPct,
    previousValue: previousPct,
    changePp:
      isMissing(currentPct) || isMissing(previousPct)
        ? MISSING
        : Math.round((currentPct - previousPct) * 10) / 10,
  };
}

function describeMetaAdSpend({ dayCount, metaSyncedDays }, curr) {
  if (!dayCount) {
    return { available: false, spend: null, error: "No P&L rows for this date range yet.", source: "none" };
  }
  if (!metaSyncedDays) {
    return {
      available: false,
      spend: null,
      error: "No synced Meta ad spend for this date range yet.",
      source: "none",
    };
  }
  return {
    available: true,
    spend: curr.meta,
    error: null,
    source: "rollup",
    syncedDays: metaSyncedDays,
    totalDays: dayCount,
  };
}

async function getSummary({ brandKey, start, end, granularity = "daily", channel = null, productId = null, conn = null }) {
  const [previousStart, previousEnd] = computePreviousRange(start, end, granularity);

  const [currTotals, prevTotals] = await Promise.all([
    fetchPnlTotals({ conn, brandKey, start, end }),
    fetchPnlTotals({ conn, brandKey, start: previousStart, end: previousEnd }),
  ]);

  const curr = buildPeriod(currTotals);
  const prev = buildPeriod(prevTotals);
  const metaAdSpend = describeMetaAdSpend(currTotals, curr);

  return {
    brandKey: brandKey || null,
    granularity,
    start,
    end,
    previousStart,
    previousEnd,
    channel,
    productId,
    kpis: {
      netSales: buildKpi(curr.netSales, prev.netSales),
      grossMarginPct: buildMarginKpi(curr.grossMargin, curr.netSales, prev.grossMargin, prev.netSales),
      cm1Pct: buildMarginKpi(curr.cm1, curr.netSales, prev.cm1, prev.netSales),
      cm2Pct: buildMarginKpi(curr.cm2, curr.netSales, prev.cm2, prev.netSales),
      cm3Pct: buildMarginKpi(curr.cm3, curr.netSales, prev.cm3, prev.netSales),
      ebitdaPct: buildMarginKpi(curr.ebitda, curr.netSales, prev.ebitda, prev.netSales),
    },
    lineItems: buildLineItems(curr, prev, { metaIsLive: metaAdSpend.available }),
    metaAdSpend,
    coverage: {
      days: currTotals.dayCount,
      expectedDays: daysBetweenInclusive(start, end),
      previousDays: prevTotals.dayCount,
    },
    filters: {
      channel: { available: false },
      product: { available: false },
    },
    source: PNL_TABLE,
  };
}

module.exports = {
  MISSING,
  getSummary,
  computePreviousRange,
  buildPeriod,
  buildLineItems,
  changePct,
  pctOfNetSales,
};
