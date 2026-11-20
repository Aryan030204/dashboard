// CSV export of a PERSISTED report snapshot. It reads the active generation from MySQL in keyset pages and writes each
// page to the response as it goes, so memory is one page, not the report. Gmail/EasyCom are never contacted.
//
// Spreadsheet formula injection: Courier Name / Reference Code come from third-party files, so any cell that starts
// with = + - @ (or a tab/CR) is prefixed with a single quote, the OWASP-recommended neutralisation.

const LABELS = { AJMAL_SONS: "AJMAL & SONS", EMIZA_GGN: "Emiza Gurgaon" };
const PAGE = 1000;

function cell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const line = (cells) => `${cells.map(cell).join(",")}\r\n`;

const ORDER_HEADER = ["Reference Code", "Client Location", "Order Date", "Order Hour", "Courier Name", "NDD", "Shipment Picked At", "SLA Status"];
const SUMMARY_HEADER = ["Client Location", "Order Date", "Order Hour", "SLA Met", "SLA Breached", "Total", "Met %", "Breached %"];

// write(chunk) must return a promise that resolves when the sink accepts more (handles backpressure).
async function writeOrdersCsv({ repo, run, filters = {}, write }) {
  await write(`﻿${line(ORDER_HEADER)}`);
  let after;
  let rows = 0;
  for (;;) {
    const page = await repo.listOrders(run.id, Number(run.active_generation), { ...filters, limit: PAGE, after });
    const batch = page.slice(0, PAGE);
    if (batch.length) {
      await write(batch.map((o) => line([
        o.reference_code, LABELS[o.client_location] || o.client_location, o.order_at, Number(o.order_hour), o.courier,
        Number(o.is_ndd) ? "Yes" : "No", o.shipment_picked_at || "", o.sla_status === "MET" ? "Met" : "Breached",
      ])).join(""));
      rows += batch.length;
    }
    if (page.length <= PAGE) break;
    const last = batch[batch.length - 1];
    after = { orderAt: last.order_at, reference: last.reference_code };
  }
  return rows;
}

async function writeSummaryCsv({ repo, run, write }) {
  const { percentages } = require("./processor");
  await write(`﻿${line(SUMMARY_HEADER)}`);
  const rows = await repo.getSummary(run.id, Number(run.active_generation)); // at most locations x 2 dates x 24
  await write(rows.map((r) => {
    const met = Number(r.met_count);
    const breached = Number(r.breached_count);
    const pct = percentages(met, breached);
    return line([LABELS[r.client_location] || r.client_location, r.order_date, Number(r.order_hour), met, breached, Number(r.total_count), pct.metPct, pct.breachedPct]);
  }).join(""));
  return rows.length;
}

module.exports = { writeOrdersCsv, writeSummaryCsv, cell, ORDER_HEADER };
