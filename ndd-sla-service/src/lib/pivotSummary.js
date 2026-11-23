// Reads a PIVOT SUMMARY (the spreadsheet pivot people keep as the legacy report): counts of SLA Breached / SLA Met per
// client location and date, no individual orders. Layout seen in the wild (sections may sit side by side):
//
//   Client Location,AJMAL & SONS,,,,Client Location,Emiza Gurgaon,,
//   Count of Reference Code,Column Labels,,,,Count of Reference Code,Column Labels,,
//   Row Labels,SLA Breached,SLA Met,Grand Total,,Row Labels,SLA Breached,SLA Met,Grand Total
//   21-Nov,12,375,387,,21-Nov,1,178,179
//   Grand Total,18,701,719,,Grand Total,3,317,320
//   Full, ... (a combined section without a client; ignored when per-client sections exist)
//
// The parser is layout-tolerant: it finds every "Row Labels" header cell, reads the Breached / Met / Total columns next to
// it by name (any order), takes the client from a "Client Location" cell above it, and reads date rows until "Grand Total".
const { PipelineError } = require("../errors");

const canon = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad2 = (n) => String(n).padStart(2, "0");

// A file is a pivot summary when its first rows hold the pivot's own headers.
function looksLikePivot(rows) {
  let hasLabels = false;
  let hasMet = false;
  for (const cells of rows) {
    const have = new Set(cells.map(canon));
    if (have.has("rowlabels")) hasLabels = true;
    if (have.has("slamet") || have.has("met")) hasMet = true;
  }
  return hasLabels && hasMet;
}

const isoOk = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

// "21-Nov", "21-Nov-2026", "Nov 21", "2026-11-21", "21/11/2026" -> "YYYY-MM-DD". A label without a year takes the report's
// year, or the year before when that would put it after the report date. Anything else (e.g. "(blank)") -> null.
function parseDateLabel(label, reportDate) {
  const s = String(label ?? "").trim();
  if (!s) return null;
  const reportYear = Number(reportDate.slice(0, 4));
  const fit = (y, m, d, explicitYear) => {
    let year = y;
    if (!explicitYear) {
      year = reportYear;
      if (isoOk(year, m, d) && `${year}-${pad2(m)}-${pad2(d)}` > reportDate) year -= 1;
    }
    return isoOk(year, m, d) ? `${year}-${pad2(m)}-${pad2(d)}` : null;
  };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return fit(Number(m[1]), Number(m[2]), Number(m[3]), true);
  m = /^(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/,]*(\d{2,4})?$/.exec(s);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    const yr = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
    return fit(yr, MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[1]), yr !== null);
  }
  m = /^([A-Za-z]{3,9})[-\s/]+(\d{1,2})[-\s/,]*(\d{2,4})?$/.exec(s);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
    const yr = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
    return fit(yr, MONTHS[m[1].slice(0, 3).toLowerCase()], Number(m[2]), yr !== null);
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return Number(m[1]) > 12 ? fit(Number(m[3]), Number(m[2]), Number(m[1]), true) : fit(Number(m[3]), Number(m[1]), Number(m[2]), true);
  return null;
}

const count = (v) => {
  const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

// rows: array of cell arrays (whole file). locationOf: raw client name -> stored location enum, or null.
// Returns { buckets: [{ location, orderDate, orderHour: 0, met, breached, total }], skipped: [..] }.
function parsePivot(rows, { reportDate, locationOf }) {
  const sections = [];
  for (let r = 0; r < rows.length; r += 1) {
    const cells = rows[r];
    for (let c = 0; c < cells.length; c += 1) {
      if (canon(cells[c]) !== "rowlabels") continue;
      const find = (names) => {
        for (let k = c + 1; k < Math.min(cells.length, c + 8); k += 1) if (names.includes(canon(cells[k]))) return k;
        return -1;
      };
      const iB = find(["slabreached", "breached"]);
      const iM = find(["slamet", "met"]);
      if (iB < 0 || iM < 0) continue;
      const iT = find(["grandtotal", "total"]);
      let client = null;
      for (let up = r - 1; up >= Math.max(0, r - 4) && client === null; up -= 1) {
        const above = rows[up] || [];
        if (canon(above[c]) === "clientlocation" && String(above[c + 1] ?? "").trim()) client = String(above[c + 1]).trim();
      }
      const data = [];
      for (let d = r + 1; d < rows.length; d += 1) {
        const label = String((rows[d] || [])[c] ?? "").trim();
        if (!label || canon(label) === "grandtotal") break;
        const orderDate = parseDateLabel(label, reportDate);
        const breached = count(rows[d][iB]);
        const met = count(rows[d][iM]);
        if (!orderDate || breached === null || met === null) continue;
        data.push({ orderDate, breached, met, total: iT >= 0 && count(rows[d][iT]) !== null ? count(rows[d][iT]) : breached + met });
      }
      sections.push({ client, data });
    }
  }
  if (!sections.length) throw new PipelineError("PIVOT_UNREADABLE", "The summary file has no pivot table with Row Labels, SLA Breached and SLA Met columns.");

  const perClient = sections.filter((s) => s.client);
  if (!perClient.length) throw new PipelineError("PIVOT_NO_LOCATION", "The summary has no Client Location sections (only a combined total), so it cannot be split per client. Use the pivot filtered by Client Location.");

  // The report window spans the report date and the day before; ignore other dates (older/newer pivots).
  const first = new Date(Date.parse(`${reportDate}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const buckets = new Map();
  const skipped = [];
  for (const section of perClient) {
    const location = locationOf(section.client);
    if (!location) { skipped.push(section.client); continue; }
    for (const row of section.data) {
      if (row.orderDate < first || row.orderDate > reportDate) continue;
      const key = `${location}|${row.orderDate}`;
      const b = buckets.get(key) || { location, orderDate: row.orderDate, orderHour: 0, met: 0, breached: 0, total: 0 };
      b.met += row.met;
      b.breached += row.breached;
      b.total += row.met + row.breached;
      buckets.set(key, b);
    }
  }
  if (!buckets.size) {
    throw new PipelineError("PIVOT_NO_MATCH", skipped.length
      ? `The summary's client(s) ${skipped.join(", ")} are not tracked here.`
      : `The summary has no rows for ${first} or ${reportDate}, the dates this report covers.`);
  }
  return { buckets: [...buckets.values()], skipped };
}

module.exports = { looksLikePivot, parsePivot, parseDateLabel };
