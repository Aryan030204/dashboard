#!/usr/bin/env node
// Generates rich, deterministic sample files for manual upload (same seed => same files):
//   docs/sample-gokwik-orders-rich-2026-11-19.csv
//   docs/sample-easycom-shipments-rich-2026-11-19.csv
//   docs/sample-expected-rich-2026-11-19.json      (what the report must show, derived independently of the service)
//
//   node scripts/generate-sample-data.js [--seed 19112026]
//
// The values are random but realistic: many couriers (NDD and not), cities, payment modes, order values, quoted fields
// with commas, plus every kind of row the rules must reject, so the report exercises every code path.
const fs = require("fs");
const path = require("path");

const seedArg = process.argv.indexOf("--seed");
let seed = seedArg > 0 ? Number(process.argv[seedArg + 1]) : 19112026;
// mulberry32: tiny seeded PRNG
const rand = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = (list) => list[int(0, list.length - 1)];
const weighted = (pairs) => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; }
  return pairs[0][0];
};

const pad = (n, w = 2) => String(n).padStart(w, "0");
function addSeconds(wall, sec) {
  const [d, t] = wall.split(" ");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi, s] = t.split(":").map(Number);
  const x = new Date(Date.UTC(y, mo - 1, da, h, mi, s + sec));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())} ${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}:${pad(x.getUTCSeconds())}`;
}
const dmy = (wall) => `${wall.slice(8, 10)}-${wall.slice(5, 7)}-${wall.slice(0, 4)} ${wall.slice(11)}`; // DD-MM-YYYY HH:mm:ss

const WINDOW = {
  ndd: { start: "2026-11-18 12:00:00", end: "2026-11-19 12:00:00" },
  other: { start: "2026-11-18 15:00:00", end: "2026-11-19 15:00:00" },
};
const CLIENTS = [
  { code: "AJMAL_SONS", label: "AJMAL & SONS", weight: 7, prefix: "AJM" },
  { code: "EMIZA_GGN", label: "Emiza Gurgaon", weight: 3, prefix: "EMZ" },
];
const NDD_COURIERS = ["ElasticrunDirectNDD", "BlitzNDD", "Shadowfax NDD", "dunzo ndd"];
const COURIERS = ["Delhivery", "BlueDart", "Ecom Express", "XpressBees", "DTDC", "Shiprocket Surface", "Amazon Shipping"];
const STATUSES = [["Delivered", 40], ["Shipped", 25], ["In Transit", 20], ["Packed", 8], ["Out For Delivery", 7]];
const CITIES = ["New Delhi", "Gurgaon", "Noida", "Mumbai", "Pune", "Bengaluru", "Hyderabad", "Chennai", "Kolkata", "Jaipur", "Lucknow", "Chandigarh"];
const PAYMENT = [["Prepaid", 55], ["COD", 40], ["Partial COD", 5]];
const FIRST = ["Aarav", "Vivaan", "Diya", "Anaya", "Rohan", "Isha", "Kabir", "Meera", "Arjun", "Saanvi", "Vihaan", "Kiara", "Aditya", "Riya", "Neel", "Tara"];
const LAST = ["Sharma", "Verma", "Gupta", "Singh", "Khanna", "Mehta", "Iyer", "Nair", "Kapoor", "Bose", "Reddy", "Joshi"];
const REMARKS = ["", "", "", "", "Gift wrap", "Call before delivery", "Leave with security, gate 2", "Fragile, handle with care", "Customer asked to deliver after 6 PM", 'Says "urgent" on invoice'];

const q = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const line = (cells) => cells.map(q).join(",");

const GOKWIK_HEADER = ["Reference Code", "Client Location", "Order Status", "Courier Name", "Order Date", "Customer Name", "City", "Pincode", "Payment Mode", "Order Value (INR)", "AWB", "Remarks"];
const EASYCOM_HEADER = ["Reference Code", "Shipment Picked At", "AWB", "Courier", "Warehouse", "Manifest ID"];

const gokwik = []; // rows
const easycom = []; // rows
const expected = { kept: [], excluded: { wrong_client: 0, wrong_status: 0, out_of_window: 0, duplicate: 0, invalid: 0 } };

let awbSeq = 70000000;
const customer = () => `${pick(FIRST)} ${pick(LAST)}`;
const common = (courier) => ({ customer: customer(), city: pick(CITIES), pin: String(int(110001, 700099)), pay: weighted(PAYMENT), value: (int(199, 14999) + pick([0, 0.5, 0.99])).toFixed(2), awb: `AWB${awbSeq += int(1, 9)}`, remark: pick(REMARKS), courier });

function randomOrderTime(isNdd) {
  const w = isNdd ? WINDOW.ndd : WINDOW.other;
  // Busier in the evening and morning: pick an offset in the 24h window with a bias.
  const hourBias = weighted([[0, 4], [1, 5], [2, 4], [3, 3], [4, 6], [5, 6], [6, 6], [7, 5], [8, 5], [9, 4], [10, 4], [11, 3]]);
  const offset = hourBias * 7200 + int(0, 7199);
  return addSeconds(w.start, Math.min(offset, 86399));
}

function pickupFor(orderAt, isNdd) {
  const r = rand();
  if (r < 0.12) return { raw: "", real: null, note: "blank" };
  if (r < 0.17) return { raw: "00-01-1900 00:00:00", real: null, note: "excel1900" };
  if (r < 0.20) return { raw: "pending", real: null, note: "unparseable" };
  const delay = isNdd ? int(900, 9 * 3600) : int(2 * 3600, 30 * 3600);
  const real = addSeconds(orderAt, delay);
  const raw = rand() < 0.15 ? dmy(real) : real; // some exports use DD-MM-YYYY
  return { raw, real, note: "picked" };
}

// ---- 1. Orders the report must contain --------------------------------------------------------------------------------
let n = 0;
const ORDERS = 640;
for (let i = 0; i < ORDERS; i += 1) {
  const client = weighted(CLIENTS.map((c) => [c, c.weight]));
  const isNdd = rand() < 0.3;
  const courier = isNdd ? pick(NDD_COURIERS) : pick(COURIERS);
  let orderAt = randomOrderTime(isNdd);
  if (i === 0) orderAt = isNdd ? WINDOW.ndd.start : WINDOW.other.start; // exact start is included
  const ref = `${client.prefix}-${String(++n + 10000)}`;
  const c = common(courier);
  const status = weighted(STATUSES);
  const p = pickupFor(orderAt, isNdd);
  gokwik.push([ref, client.label, status, courier, orderAt, c.customer, c.city, c.pin, c.pay, c.value, c.awb, c.remark]);
  const inEasycom = rand() > 0.04; // ~4% never show up in EasyCom
  if (inEasycom) easycom.push([ref, p.raw, c.awb, courier, pick(["Gurgaon WH-1", "Bhiwandi WH-2", "Noida WH-3"]), `MNF-${int(100000, 999999)}`]);
  expected.kept.push({
    reference: ref, client: client.code, orderAt, isNdd, courier,
    pickedAt: inEasycom ? p.real : null, sla: inEasycom && p.real ? "MET" : "BREACHED", inEasycom,
  });
}
// A few orders sitting on the exact boundaries, all inside their windows.
const edge = [
  ["AJM-EDGE1", CLIENTS[0], "BlitzNDD", WINDOW.ndd.start], ["AJM-EDGE2", CLIENTS[0], "BlitzNDD", addSeconds(WINDOW.ndd.end, -1)],
  ["AJM-EDGE3", CLIENTS[0], "Delhivery", WINDOW.other.start], ["AJM-EDGE4", CLIENTS[0], "Delhivery", addSeconds(WINDOW.other.end, -1)],
  ["EMZ-EDGE5", CLIENTS[1], "ElasticrunDirectNDD", addSeconds(WINDOW.ndd.end, -1)], ["EMZ-EDGE6", CLIENTS[1], "XpressBees", WINDOW.other.start],
];
for (const [ref, client, courier, orderAt] of edge) {
  const isNdd = /ndd/i.test(courier);
  const c = common(courier);
  const real = addSeconds(orderAt, 1800);
  gokwik.push([ref, client.label, "Shipped", courier, orderAt, c.customer, c.city, c.pin, c.pay, c.value, c.awb, "Window boundary (included)"]);
  easycom.push([ref, real, c.awb, courier, "Gurgaon WH-1", `MNF-${int(100000, 999999)}`]);
  expected.kept.push({ reference: ref, client: client.code, orderAt, isNdd, courier, pickedAt: real, sla: "MET", inEasycom: true });
}

// ---- 2. Rows the rules must reject (also present in EasyCom where that could leak them in) ----------------------------
const sample = () => ({ ...common(pick(COURIERS)) });
function noise(count, make, key) {
  for (let i = 0; i < count; i += 1) {
    const row = make(i);
    gokwik.push(row);
    expected.excluded[key] += 1;
  }
}
noise(35, (i) => {
  const c = sample();
  const ref = `OTH-${20000 + i}`;
  easycom.push([ref, "2026-11-19 09:00:00", c.awb, c.courier, "Gurgaon WH-1", `MNF-${int(100000, 999999)}`]);
  return [ref, pick(["Some Other Brand", "Emiza Mumbai", "Kapoor Textiles", "ajmal and sons"]), "Delivered", c.courier, randomOrderTime(false), c.customer, c.city, c.pin, c.pay, c.value, c.awb, "Other client"];
}, "wrong_client");
noise(40, (i) => {
  const c = sample();
  const client = pick(CLIENTS);
  const ref = `${client.prefix}-X${30000 + i}`;
  easycom.push([ref, "2026-11-19 07:30:00", c.awb, c.courier, "Gurgaon WH-1", `MNF-${int(100000, 999999)}`]);
  return [ref, client.label, pick(["Cancelled", "On Hold", "Returned", "on_hold", "CANCELLED", "RETURNED", "On-Hold"]), c.courier, randomOrderTime(false), c.customer, c.city, c.pin, c.pay, c.value, c.awb, "Excluded status"];
}, "wrong_status");
const outside = [
  ["ElasticrunDirectNDD", WINDOW.ndd.end], ["BlitzNDD", addSeconds(WINDOW.ndd.start, -1)], ["Delhivery", WINDOW.other.end],
  ["BlueDart", addSeconds(WINDOW.other.start, -1)], ["BlitzNDD", "2026-11-19 14:00:00"], ["Delhivery", "2026-11-17 18:00:00"], ["DTDC", "2026-11-20 01:00:00"],
];
noise(28, (i) => {
  const c = sample();
  const client = pick(CLIENTS);
  const [courier, at] = outside[i % outside.length];
  return [`${client.prefix}-O${40000 + i}`, client.label, "Delivered", courier, at, c.customer, c.city, c.pin, c.pay, c.value, c.awb, "Outside its window"];
}, "out_of_window");
// duplicates: same Reference Code again, later in the file; the first occurrence must win
const originals = gokwik.slice(0, 30);
noise(15, (i) => {
  const o = originals[i * 2];
  return [o[0], o[1], "Delivered", o[3], o[4], "Duplicate Person", o[6], o[7], o[8], "1.00", "AWB00000000", "Duplicate row (ignored)"];
}, "duplicate");
const badDates = ["", "yesterday", "2026-02-31 10:00:00", "2026-11-19", "19/11/26", "tomorrow 9am", "N/A"];
noise(10, (i) => {
  const c = sample();
  const client = pick(CLIENTS);
  return [`${client.prefix}-B${50000 + i}`, client.label, "Delivered", c.courier, badDates[i % badDates.length], c.customer, c.city, c.pin, c.pay, c.value, c.awb, "Unreadable order date"];
}, "invalid");
noise(4, () => {
  const c = sample();
  return ["", pick(CLIENTS).label, "Delivered", c.courier, randomOrderTime(false), c.customer, c.city, c.pin, c.pay, c.value, c.awb, "Missing Reference Code"];
}, "invalid");

// ---- 3. EasyCom extras: re-scans, unknown shipments, a duplicate where the real pickup comes second --------------------
for (let i = 0; i < 25; i += 1) easycom.push([`ZZZ-${60000 + i}`, "2026-11-19 10:00:00", `AWB${int(80000000, 89999999)}`, pick(COURIERS), "Noida WH-3", `MNF-${int(100000, 999999)}`]);
const twice = expected.kept.filter((o) => o.pickedAt && o.inEasycom).slice(0, 12);
for (const o of twice) {
  const idx = easycom.findIndex((r) => r[0] === o.reference);
  easycom.splice(Math.max(0, idx - 1), 0, [o.reference, "", "RESCAN", o.courier, "Gurgaon WH-1", "MNF-RESCAN"]); // an empty record before the real one
}

// Deterministic shuffle so the files do not list orders in generation order.
function shuffle(rows) {
  const a = rows.slice();
  for (let i = a.length - 1; i > 0; i -= 1) { const j = int(0, i); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// Duplicates must come after their original, so shuffle only the non-duplicates, then append the duplicates.
const dupRows = gokwik.filter((r) => r[11] === "Duplicate row (ignored)");
const rest = shuffle(gokwik.filter((r) => r[11] !== "Duplicate row (ignored)"));
// Make sure originals stay before their duplicates (they do: duplicates go last).
const gokwikOut = [...rest, ...dupRows];
const easycomOut = shuffle(easycom);

// ---- 4. Expected totals (computed from the spec above, not from the service) ---------------------------------------------
const bucket = (o) => `${o.client}|${o.orderAt.slice(0, 10)}|${Number(o.orderAt.slice(11, 13))}`;
const hourly = {};
const totals = { AJMAL_SONS: { met: 0, breached: 0 }, EMIZA_GGN: { met: 0, breached: 0 } };
for (const o of expected.kept) {
  const k = bucket(o);
  hourly[k] ||= { client: o.client, orderDate: o.orderAt.slice(0, 10), orderHour: Number(o.orderAt.slice(11, 13)), met: 0, breached: 0 };
  const key = o.sla === "MET" ? "met" : "breached";
  hourly[k][key] += 1;
  totals[o.client][key] += 1;
}
const summary = {
  reportDate: "2026-11-19",
  windows: WINDOW,
  rowsInGoKwikFile: gokwikOut.length,
  rowsInEasycomFile: easycomOut.length,
  excluded: expected.excluded,
  kept: expected.kept.length,
  notInEasycom: expected.kept.filter((o) => !o.inEasycom).length,
  total: {
    orders: expected.kept.length,
    met: totals.AJMAL_SONS.met + totals.EMIZA_GGN.met,
    breached: totals.AJMAL_SONS.breached + totals.EMIZA_GGN.breached,
  },
  byLocation: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, { orders: v.met + v.breached, ...v }])),
  hourly: Object.values(hourly).sort((a, b) => a.client.localeCompare(b.client) || a.orderDate.localeCompare(b.orderDate) || a.orderHour - b.orderHour),
};

const docs = path.join(__dirname, "..", "docs");
fs.mkdirSync(docs, { recursive: true });
fs.writeFileSync(path.join(docs, "sample-gokwik-orders-rich-2026-11-19.csv"), `${[line(GOKWIK_HEADER), ...gokwikOut.map(line)].join("\n")}\n`);
fs.writeFileSync(path.join(docs, "sample-easycom-shipments-rich-2026-11-19.csv"), `${[line(EASYCOM_HEADER), ...easycomOut.map(line)].join("\n")}\n`);
fs.writeFileSync(path.join(docs, "sample-expected-rich-2026-11-19.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ gokwikRows: gokwikOut.length, easycomRows: easycomOut.length, kept: summary.kept, total: summary.total, byLocation: summary.byLocation, excluded: summary.excluded, notInEasycom: summary.notInEasycom }, null, 2));
