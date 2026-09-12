const GST_RATE = 18 / 118;

function seededRandom(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function next() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function jitter(rng, base, spread = 0.2) {
  return base * (1 + (rng() * 2 - 1) * spread);
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

function buildMockPnl({ brandKey, start, end, channel, productId }) {
  const seed = [brandKey || "BRAND", start, end, channel || "", productId || ""].join("|");
  const rng = seededRandom(seed);

  const days = daysBetweenInclusive(start, end);
  const dailyBaseline = jitter(rng, 180000, 0.15);
  const grossSales = Math.round(dailyBaseline * days);

  const discounts = Math.round(grossSales * jitter(rng, 0.07, 0.25));
  const cancellations = Math.round(grossSales * jitter(rng, 0.03, 0.3));
  const gst = Math.round((grossSales - discounts - cancellations) * GST_RATE);
  const netSales = grossSales - discounts - cancellations - gst;

  const cogs = Math.round(netSales * jitter(rng, 0.32, 0.15));
  const freightInwards = Math.round(netSales * jitter(rng, 0.02, 0.3));
  const grossMargin = netSales - cogs - freightInwards;

  const shipping = Math.round(netSales * jitter(rng, 0.06, 0.2));
  const rto = Math.round(netSales * jitter(rng, 0.03, 0.3));
  const paymentGateway = Math.round(netSales * jitter(rng, 0.02, 0.2));
  const packaging = Math.round(netSales * jitter(rng, 0.015, 0.25));
  const cm1 = grossMargin - shipping - rto - paymentGateway - packaging;

  const meta = Math.round(netSales * jitter(rng, 0.08, 0.25));
  const google = Math.round(netSales * jitter(rng, 0.05, 0.25));
  const otherPaid = Math.round(netSales * jitter(rng, 0.01, 0.4));
  const cm2 = cm1 - meta - google - otherPaid;

  const influencers = Math.round(netSales * jitter(rng, 0.02, 0.3));
  const content = Math.round(netSales * jitter(rng, 0.01, 0.3));
  const sponsorships = Math.round(netSales * jitter(rng, 0.005, 0.4));
  const otherBrand = Math.round(netSales * jitter(rng, 0.005, 0.4));
  const cm3 = cm2 - influencers - content - sponsorships - otherBrand;

  const salaries = Math.round(netSales * jitter(rng, 0.06, 0.15));
  const rent = Math.round(netSales * jitter(rng, 0.01, 0.2));
  const technology = Math.round(netSales * jitter(rng, 0.01, 0.3));
  const agencyFees = Math.round(netSales * jitter(rng, 0.01, 0.3));
  const otherOverheads = Math.round(netSales * jitter(rng, 0.01, 0.4));
  const ebitda = cm3 - salaries - rent - technology - agencyFees - otherOverheads;

  return {
    grossSales, discounts, cancellations, gst, netSales,
    cogs, freightInwards, grossMargin,
    shipping, rto, paymentGateway, packaging, cm1,
    meta, google, otherPaid, cm2,
    influencers, content, sponsorships, otherBrand, cm3,
    salaries, rent, technology, agencyFees, otherOverheads, ebitda,
  };
}

function pctOfNetSales(amount, netSales) {
  if (!netSales) return 0;
  return Math.round((amount / netSales) * 1000) / 10;
}

function changePct(current, previous) {
  if (!previous) return current ? 100 : 0;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

function buildLineItems(curr, prev) {
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

  push("grossSales", "Gross Sales", curr.grossSales, prev.grossSales, { section: "revenue" });
  push("discounts", "(–) Discounts", -curr.discounts, -prev.discounts, { section: "revenue", isDeduction: true });
  push("cancellations", "(–) Cancellations", -curr.cancellations, -prev.cancellations, { section: "revenue", isDeduction: true });
  push("gst", "(–) GST", -curr.gst, -prev.gst, { section: "revenue", isDeduction: true });
  push("netSales", "Net Sales", curr.netSales, prev.netSales, { section: "revenue", isSubtotal: true });

  push("cogs", "(–) COGS", -curr.cogs, -prev.cogs, { section: "grossMargin", isDeduction: true });
  push("freightInwards", "(–) Freight Inwards", -curr.freightInwards, -prev.freightInwards, { section: "grossMargin", isDeduction: true });
  push("grossMargin", "Gross Margin", curr.grossMargin, prev.grossMargin, { section: "grossMargin", isSubtotal: true });

  push("shipping", "(–) Shipping / Logistics", -curr.shipping, -prev.shipping, { section: "cm1", isDeduction: true });
  push("rto", "(–) RTO Cost", -curr.rto, -prev.rto, { section: "cm1", isDeduction: true });
  push("paymentGateway", "(–) Payment Gateway / Commission", -curr.paymentGateway, -prev.paymentGateway, { section: "cm1", isDeduction: true });
  push("packaging", "(–) Packaging", -curr.packaging, -prev.packaging, { section: "cm1", isDeduction: true });
  push("cm1", "CM1", curr.cm1, prev.cm1, { section: "cm1", isSubtotal: true });

  push("meta", "(–) Meta", -curr.meta, -prev.meta, { section: "cm2", isDeduction: true, isSubItem: true });
  push("google", "(–) Google", -curr.google, -prev.google, { section: "cm2", isDeduction: true, isSubItem: true });
  push("otherPaid", "(–) Other Paid Channels", -curr.otherPaid, -prev.otherPaid, { section: "cm2", isDeduction: true, isSubItem: true });
  push("cm2", "CM2", curr.cm2, prev.cm2, { section: "cm2", isSubtotal: true });

  push("influencers", "(–) Influencers", -curr.influencers, -prev.influencers, { section: "cm3", isDeduction: true, isSubItem: true });
  push("content", "(–) Content / Creative", -curr.content, -prev.content, { section: "cm3", isDeduction: true, isSubItem: true });
  push("sponsorships", "(–) Sponsorships", -curr.sponsorships, -prev.sponsorships, { section: "cm3", isDeduction: true, isSubItem: true });
  push("otherBrand", "(–) Other Brand Marketing", -curr.otherBrand, -prev.otherBrand, { section: "cm3", isDeduction: true, isSubItem: true });
  push("cm3", "CM3", curr.cm3, prev.cm3, { section: "cm3", isSubtotal: true });

  push("salaries", "(–) Salaries", -curr.salaries, -prev.salaries, { section: "ebitda", isDeduction: true, isSubItem: true });
  push("rent", "(–) Rent", -curr.rent, -prev.rent, { section: "ebitda", isDeduction: true, isSubItem: true });
  push("technology", "(–) Technology", -curr.technology, -prev.technology, { section: "ebitda", isDeduction: true, isSubItem: true });
  push("agencyFees", "(–) Agency Fees", -curr.agencyFees, -prev.agencyFees, { section: "ebitda", isDeduction: true, isSubItem: true });
  push("otherOverheads", "(–) Other Overheads", -curr.otherOverheads, -prev.otherOverheads, { section: "ebitda", isDeduction: true, isSubItem: true });
  push("ebitda", "EBITDA", curr.ebitda, prev.ebitda, { section: "ebitda", isSubtotal: true });

  return rows;
}

function buildKpi(currentAmount, previousAmount) {
  return {
    value: currentAmount,
    previousValue: previousAmount,
    changePct: changePct(currentAmount, previousAmount),
  };
}

function buildMarginKpi(currentMargin, currentNetSales, previousMargin, previousNetSales) {
  const currentPct = pctOfNetSales(currentMargin, currentNetSales);
  const previousPct = pctOfNetSales(previousMargin, previousNetSales);
  return {
    value: currentPct,
    previousValue: previousPct,
    changePp: Math.round((currentPct - previousPct) * 10) / 10,
  };
}

// Mock data source — replace with a query against the P&L rollup table once
// it exists. The seeded RNG keeps values stable across reloads for the same
// brand/date-range/filter combination so the UI feels like it's backed by
// real data until then.
function getSummary({ brandKey, start, end, granularity = "daily", channel = null, productId = null }) {
  const [previousStart, previousEnd] = computePreviousRange(start, end, granularity);

  const curr = buildMockPnl({ brandKey, start, end, channel, productId });
  const prev = buildMockPnl({ brandKey, start: previousStart, end: previousEnd, channel, productId });

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
    lineItems: buildLineItems(curr, prev),
    filters: {
      channel: {
        available: false,
        message: "Channel-level P&L breakdown is to be implemented — showing brand-level totals.",
      },
      product: {
        available: false,
        message: "Product-level P&L breakdown is to be implemented — showing brand-level totals.",
      },
    },
    source: "mock",
  };
}

module.exports = {
  getSummary,
};
