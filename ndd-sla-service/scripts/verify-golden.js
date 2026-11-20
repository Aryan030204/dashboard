#!/usr/bin/env node
// Runs the REAL processing path on REAL files and compares the result with the expected numbers, offline (no Gmail,
// no EasyCom, no database). Use it to check the senior's 19-Nov data:
//
//   node scripts/verify-golden.js --csv gokwik.csv --easycom shipments.ndjson --date 2026-11-19 \
//        --expect-total 1063 --expect AJMAL_SONS=754 --expect EMIZA_GGN=309
//
// --easycom is NEWLINE-DELIMITED JSON, one shipment per line: {"reference":"...","pickedAt":"..."} (pickedAt may be
// empty/null). It is streamed line by line. Window rules come from the same NDD_SLA_* environment variables as the
// service (.env is loaded). Exit code 1 if any expectation fails.
require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const { getConfig } = require("../src/config");
const { parseCsv } = require("../src/lib/csvStream");
const {
  computeWindows, createPickedIndex, createSummaryAggregator, filterOrders, joinOrders,
} = require("../src/services/processor");

function args(argv) {
  const out = { expect: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--expect") { const [k, v] = argv[i += 1].split("="); out.expect[k] = Number(v); }
    else if (a.startsWith("--")) out[a.slice(2)] = argv[i += 1];
  }
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  if (!a.csv || !a.date) { console.error("usage: --csv <file> --date YYYY-MM-DD [--easycom <ndjson>] [--expect-total N] [--expect LOCATION=N]"); process.exit(2); }
  const config = getConfig();
  const windows = computeWindows(a.date, config.window);
  console.log("windows", JSON.stringify(windows));

  const rows = parseCsv(fs.createReadStream(a.csv), { required: Object.values(config.columns) });
  const { kept, counts } = await filterOrders(rows, { windows, columns: config.columns, maxKeptRows: config.limits.maxKeptRows });
  console.log("counts", JSON.stringify(counts));

  const index = createPickedIndex(kept);
  if (a.easycom) {
    const lines = readline.createInterface({ input: fs.createReadStream(a.easycom), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const s = JSON.parse(line);
      index.offer(s.reference, s.pickedAt);
    }
  }
  const agg = createSummaryAggregator();
  const stats = {};
  for (const order of joinOrders(kept, index.picked, stats)) agg.add(order);

  const totals = agg.totals();
  const byLocation = {};
  for (const b of agg.rows()) byLocation[b.location] = (byLocation[b.location] || 0) + b.total;
  console.log("totals", JSON.stringify(totals), "byLocation", JSON.stringify(byLocation), "easycom", JSON.stringify(index.stats), "unmatched", stats.unmatched);

  let ok = true;
  const check = (name, got, want) => {
    const pass = got === want;
    if (!pass) ok = false;
    console.log(`${pass ? "PASS" : "FAIL"} ${name}: got ${got}, expected ${want}`);
  };
  if (a["expect-total"] !== undefined) check("total", totals.total, Number(a["expect-total"]));
  for (const [loc, want] of Object.entries(a.expect)) check(loc, byLocation[loc] || 0, want);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err.message); process.exit(2); });
