// Deterministic fixture for the 19-Nov-2026 acceptance report (1,063 orders: AJMAL & SONS 754, Emiza Gurgaon 309).
//
// IMPORTANT: this is a SYNTHETIC fixture built to the confirmed rules and counts. It is NOT the senior's real GoKwik /
// EasyCom export (that file was not available in the repo). It exists so the pipeline is validated by behaviour:
// every order carries its own independently derived expectation (window, hour, SLA), and the fixture is surrounded by
// every kind of row the rules must reject. Run scripts/verify-golden.js on the real files to check the real data.
//
// Windows for report date 2026-11-19 (end-date anchored, IST):
//   NDD     [2026-11-18 12:00:00, 2026-11-19 12:00:00)
//   non-NDD [2026-11-18 15:00:00, 2026-11-19 15:00:00)
const REPORT_DATE = "2026-11-19";
const WINDOW = {
  ndd: { start: "2026-11-18 12:00:00", end: "2026-11-19 12:00:00" },
  other: { start: "2026-11-18 15:00:00", end: "2026-11-19 15:00:00" },
};
const EXPECTED_TOTAL = { AJMAL_SONS: 754, EMIZA_GGN: 309 };
const SOURCE_LABEL = { AJMAL_SONS: "AJMAL & SONS", EMIZA_GGN: "Emiza Gurgaon" };
const HEADER = ["Reference Code", "Client Location", "Order Status", "Courier Name", "Order Date", "Remarks"];

const pad = (n) => String(n).padStart(2, "0");
// Independent of the service's wall helpers on purpose: plain UTC calendar arithmetic.
function addMinutes(wall, minutes) {
  const [d, t] = wall.split(" ");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi, s] = t.split(":").map(Number);
  const x = new Date(Date.UTC(y, mo - 1, da, h, mi + minutes, s));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())} ${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}:${pad(x.getUTCSeconds())}`;
}

function csvCell(v) {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildGolden() {
  const kept = []; // the orders the report must contain, each with its own expectation
  const csvRows = []; // [ref, clientLabel, status, courier, orderDate, remarks]
  const shipments = []; // EasyCom { reference, pickedAtRaw }

  for (const [location, count] of Object.entries(EXPECTED_TOTAL)) {
    const salt = location === "AJMAL_SONS" ? 0 : 211;
    for (let k = 0; k < count; k += 1) {
      const isNdd = k % 4 === 0;
      const courier = isNdd ? (k % 8 === 0 ? "ElasticrunDirectNDD" : "blitzndd") : ["Delhivery", "BlueDart", "Ecom Express"][k % 3];
      const win = isNdd ? WINDOW.ndd : WINDOW.other;
      const offset = k === 0 || k === 1 ? 0 : (k * 37 + salt) % 1440; // k=0 (NDD) and k=1 sit exactly on window start
      const orderAt = addMinutes(win.start, offset);
      const ref = `${location === "AJMAL_SONS" ? "AJM" : "EMZ"}-${String(k).padStart(5, "0")}`;

      let pickedAtRaw;
      let hasPickup = true;
      if (k % 5 === 0) { pickedAtRaw = ""; hasPickup = false; } // no pickup
      else if (k % 7 === 0) { pickedAtRaw = "00-01-1900 00:00:00"; hasPickup = false; } // Excel placeholder
      else if (k % 11 === 0) { pickedAtRaw = "not a date"; hasPickup = false; } // unparseable
      else pickedAtRaw = addMinutes(orderAt, (k % 90) + 5);

      kept.push({
        reference: ref, location, isNdd, orderAt, orderDate: orderAt.slice(0, 10), orderHour: Number(orderAt.slice(11, 13)),
        pickedAt: hasPickup ? pickedAtRaw : null, sla: hasPickup ? "MET" : "BREACHED",
      });
      csvRows.push([ref, SOURCE_LABEL[location], k % 6 === 0 ? "Shipped" : "Delivered", courier, orderAt, k % 9 === 0 ? 'fragile, "handle" with care' : ""]);
      shipments.push({ reference: ref, pickedAtRaw });
    }
  }

  const noise = { wrong_client: 0, wrong_status: 0, out_of_window: 0, duplicate: 0, invalid: 0 };
  const inWindowTime = "2026-11-19 09:30:00";

  for (let i = 0; i < 40; i += 1) { // other clients
    csvRows.push([`OTH-${i}`, i % 2 ? "Some Other Brand" : "Emiza Mumbai", "Delivered", "Delhivery", inWindowTime, ""]);
    shipments.push({ reference: `OTH-${i}`, pickedAtRaw: "2026-11-19 10:00:00" });
    noise.wrong_client += 1;
  }
  const bad = ["Cancelled", "On Hold", "Returned", "on_hold", "CANCELLED"];
  for (let i = 0; i < 30; i += 1) { // excluded statuses (they also appear in EasyCom: must not leak in)
    csvRows.push([`BAD-${i}`, SOURCE_LABEL.AJMAL_SONS, bad[i % bad.length], "Delhivery", inWindowTime, ""]);
    shipments.push({ reference: `BAD-${i}`, pickedAtRaw: "2026-11-19 10:30:00" });
    noise.wrong_status += 1;
  }
  const outside = [
    ["ElasticrunDirectNDD", "2026-11-19 12:00:00"], // NDD end is EXCLUSIVE
    ["BlitzNDD", "2026-11-18 11:59:59"], // just before the NDD start
    ["Delhivery", "2026-11-19 15:00:00"], // non-NDD end is EXCLUSIVE
    ["Delhivery", "2026-11-18 14:59:59"], // just before the non-NDD start
    ["BlitzNDD", "2026-11-19 13:00:00"], // inside the non-NDD window but NDD uses its own window
    ["Delhivery", "2026-11-17 18:00:00"],
  ];
  for (let i = 0; i < 24; i += 1) {
    const [courier, at] = outside[i % outside.length];
    csvRows.push([`OUT-${i}`, SOURCE_LABEL[i % 2 ? "EMIZA_GGN" : "AJMAL_SONS"], "Delivered", courier, at, ""]);
    noise.out_of_window += 1;
  }
  for (let i = 0; i < 12; i += 1) { // duplicate Reference Codes appearing AFTER the original: first occurrence wins
    const original = csvRows[i * 7];
    csvRows.push([original[0], original[1], "Delivered", original[3], original[4], "duplicate"]); // same reference again: must be ignored
    noise.duplicate += 1;
  }
  for (let i = 0; i < 7; i += 1) { // unparseable order dates
    csvRows.push([`BADDATE-${i}`, SOURCE_LABEL.AJMAL_SONS, "Delivered", "Delhivery", ["", "yesterday", "2026-02-31 10:00:00", "2026-11-19"][i % 4], ""]);
    noise.invalid += 1;
  }
  for (let i = 0; i < 3; i += 1) { // missing Reference Code
    csvRows.push(["", SOURCE_LABEL.EMIZA_GGN, "Delivered", "Delhivery", inWindowTime, ""]);
    noise.invalid += 1;
  }
  // A shipment seen twice for a kept order: an empty record then the real pickup. The real pickup must win.
  const twice = kept.find((o) => o.sla === "MET");
  shipments.unshift({ reference: twice.reference, pickedAtRaw: "" });

  // Deterministic interleave so noise is not all at the end (stride permutation over the row list).
  const n = csvRows.length;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  let step = 389;
  while (gcd(step, n) !== 1) step += 1; // a stride coprime with n makes (i * step) % n a permutation
  const ordered = Array.from({ length: n }, (_, i) => csvRows[(i * step) % n]);
  // The permutation reorders duplicates relative to originals; restore "first occurrence wins" by order of the
  // ORIGINAL rows: keep a duplicate only after its original by sorting duplicates later.
  const firstSeen = new Map();
  const finalRows = [];
  const dupes = [];
  for (const row of ordered) {
    if (row[5] === "duplicate") { dupes.push(row); continue; }
    firstSeen.set(row[0], true);
    finalRows.push(row);
  }
  finalRows.push(...dupes);

  const csv = `﻿${[HEADER, ...finalRows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;

  // EasyCom order is irrelevant to the result: reverse it and cut it into pages of 100.
  const reversed = shipments.slice().reverse();
  const pages = [];
  for (let i = 0; i < reversed.length; i += 100) pages.push(reversed.slice(i, i + 100));

  // Independent oracle for the summary: counts per location/date/hour.
  const buckets = new Map();
  for (const o of kept) {
    const key = `${o.location}|${o.orderDate}|${o.orderHour}`;
    const b = buckets.get(key) || { location: o.location, orderDate: o.orderDate, orderHour: o.orderHour, met: 0, breached: 0, total: 0 };
    if (o.sla === "MET") b.met += 1; else b.breached += 1;
    b.total += 1;
    buckets.set(key, b);
  }
  return { csv, pages, kept, noise, buckets, totalRows: finalRows.length };
}

module.exports = { buildGolden, REPORT_DATE, WINDOW, EXPECTED_TOTAL };
