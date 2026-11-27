const { QueryTypes } = require("sequelize");
const { normalizeTimezone, getTodayInTimezone, shiftDays } = require("../shared/utils/date");
const { loadVariantNames } = require("./inventoryOosService");

// "Inventory Snapshot" table of the Inventory panel: per SKU, the daily run rate (DRR) of two months and the units
// sold on each day of the later one.
//
// Source: `daily_inventory_summary` in the brand database (one row per date and variant), written by the inventory
// pipeline. SKU and product title come from the inventory cache; the table only has ids. Today is still running, so
// the data always ends yesterday (in the brand's timezone).

const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const monthStart = (month) => `${month}-01`;
const monthEnd = (month) => {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
};

function bad(message) {
  return { ok: false, status: 400, body: { error: message } };
}

// `months=YYYY-MM,YYYY-MM`. Without it: the month of yesterday and the one before it, so the later month always has
// a finished day (on the 1st, "this month" has none yet).
function normalizeSnapshotRequest(query = {}, { timezone, now = new Date() } = {}) {
  const zone = normalizeTimezone(timezone);
  const today = getTodayInTimezone(zone, now);
  const raw = String(query.months || "").trim();

  let months;
  if (!raw) {
    const latest = shiftDays(today, -1).slice(0, 7);
    months = [shiftDays(monthStart(latest), -1).slice(0, 7), latest];
  } else {
    months = raw.split(",").map((value) => value.trim());
    if (months.length !== 2 || !months.every((value) => ISO_MONTH.test(value))) {
      return bad("months must be two months in YYYY-MM,YYYY-MM format");
    }
    if (months[0] === months[1]) return bad("months must be two different months");
    if (months.some((value) => value > today.slice(0, 7))) return bad("months cannot be in the future");
    months = [...months].sort();
  }

  return { ok: true, spec: { months, today, timezone: zone } };
}

function isMissingTableError(err) {
  const e = (err && (err.original || err.parent)) || err || {};
  return (e.code === "ER_NO_SUCH_TABLE" || e.errno === 1146) && String(e.message || "").includes("daily_inventory_summary");
}

// Variants that share a SKU are one row, the same grouping as the "Inventory info" table.
function groupBySku(records, names) {
  const groups = new Map();
  for (const record of records) {
    const variantId = String(record.variant_id);
    const name = names.get(variantId) || {};
    const key = name.sku ? `sku:${name.sku.toLowerCase()}` : `variant:${variantId}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, sku: name.sku || `Variant ${variantId}`, titles: new Set(), byDate: new Map() };
      groups.set(key, group);
    }
    if (name.title) group.titles.add(name.title);
    group.byDate.set(record.date, (group.byDate.get(record.date) || 0) + Number(record.units || 0));
  }
  return [...groups.values()];
}

function buildInventorySnapshotService({ loadNames = loadVariantNames } = {}) {
  async function getSnapshot({ conn, brandKey, resolveShopSubdomain, months, today }) {
    const yesterday = shiftDays(today, -1);
    // A month that has no finished day yet has no dates to read.
    const ranges = months.map((month) => {
      const start = monthStart(month);
      const last = monthEnd(month);
      const end = last < yesterday ? last : yesterday;
      return { month, start, end: end >= start ? end : null };
    });
    const readable = ranges.filter((range) => range.end);

    let records = [];
    if (readable.length) {
      try {
        // Positional `?` only: the tenant connection formats replacements with mysql2.
        records = await conn.query(
          `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, variant_id, SUM(units_sold) AS units
             FROM daily_inventory_summary
            WHERE ${readable.map(() => "(date >= ? AND date <= ?)").join(" OR ")}
            GROUP BY date, variant_id`,
          { type: QueryTypes.SELECT, replacements: readable.flatMap((range) => [range.start, range.end]) },
        );
      } catch (err) {
        if (isMissingTableError(err)) return { available: false };
        throw err;
      }
    }

    // A date without a single row is a gap in the data, not a day on which nothing sold.
    const datesWithData = new Set(records.map((record) => record.date));
    const monthInfo = ranges.map((range) => ({
      ...range,
      days_with_data: [...datesWithData].filter((date) => date.startsWith(range.month)).length,
    }));

    const detail = ranges[ranges.length - 1];
    const days = [];
    for (let date = detail.start; detail.end && date <= detail.end; date = shiftDays(date, 1)) days.push(date);

    const names = records.length ? await loadNames(brandKey, resolveShopSubdomain) : new Map();
    const rows = groupBySku(records, names).map((group) => {
      const totals = monthInfo.map(() => 0);
      for (const [date, units] of group.byDate) {
        const index = monthInfo.findIndex((info) => date.startsWith(info.month));
        if (index >= 0) totals[index] += units;
      }
      const titles = [...group.titles];
      return {
        key: group.key,
        sku: group.sku,
        title: titles.length > 1 ? `${titles[0]} (+${titles.length - 1} more)` : titles[0] || "",
        drr: monthInfo.map((info, index) => (info.days_with_data ? totals[index] / info.days_with_data : null)),
        units: days.map((date) => (datesWithData.has(date) ? group.byDate.get(date) || 0 : null)),
      };
    });

    return {
      available: true,
      months: monthInfo,
      detail_month: detail.month,
      days,
      rows,
    };
  }

  return { getSnapshot };
}

module.exports = { buildInventorySnapshotService, normalizeSnapshotRequest };
