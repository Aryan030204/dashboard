#!/usr/bin/env node
/**
 * Read-only check that the optimised Intent panel queries give the same numbers as the separate ones they replace,
 * and how much faster they are. It only runs SELECT statements.
 *
 * It runs each of these twice on one brand database, once with the optimisation switched off and once on, and
 * compares every number of the two answers:
 *
 *   intent page          INTENT_COMBINED_SCAN         (one scan instead of four)
 *   user overlap         INTENT_OVERLAP_SINGLE_QUERY  (one query instead of two)
 *   heatmap pages        INTENT_HEATMAP_SINGLE_QUERY  (list and totals in one)
 *   heatmap elements     INTENT_HEATMAP_SINGLE_QUERY  (list and totals in one)
 *
 * Usage:
 *   node scripts/intent-queries-parity.cjs --brand BBB --from 2026-10-01 --to 2026-10-20
 *   node scripts/intent-queries-parity.cjs --brand BBB --from 2026-10-01 --to 2026-10-20 --path /collections/all
 *
 * Use a range that ended before today: today's live (still open) sessions change from one second to the next, so
 * two runs would differ for reasons that have nothing to do with the queries. Exit code 0 = identical, 1 = a difference.
 *
 *   --read-host <host>   run the queries on another host (for example a read replica)
 *
 * Brand connection settings come from BRANDS_CONFIG in the environment (same JSON as the API uses).
 */

const path = require("path");

function parseArgs(argv) {
  const options = { brand: "", from: "", to: "", path: "", readHost: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === "--brand") options.brand = next().trim().toUpperCase();
    else if (arg === "--from") options.from = next().trim();
    else if (arg === "--to") options.to = next().trim();
    else if (arg === "--path") options.path = next().trim();
    else if (arg === "--read-host") options.readHost = next().trim();
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.brand) throw new Error("--brand is required (for example --brand BBB)");
  const dateOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!dateOk(options.from) || !dateOk(options.to)) throw new Error("--from and --to must be dates like 2026-10-01");
  if (options.to < options.from) throw new Error("--to is before --from");
  return options;
}

function loadBrand(brandKey) {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
  let brands;
  try {
    brands = JSON.parse(process.env.BRANDS_CONFIG || "[]");
  } catch {
    throw new Error("BRANDS_CONFIG is not valid JSON");
  }
  const brand = (Array.isArray(brands) ? brands : []).find((b) => String(b.key || "").toUpperCase() === brandKey);
  if (!brand) throw new Error(`Brand ${brandKey} is not in BRANDS_CONFIG`);
  return brand;
}

// The same connection the API uses for a brand, wrapped so the services can call conn.query(sql, { replacements }).
async function openConnection(brand, hostOverride) {
  const mysql = require("mysql2/promise");
  const raw = await mysql.createConnection({
    host: hostOverride || brand.dbHost,
    port: Number(brand.dbPort) || 3306,
    user: brand.dbUser,
    password: brand.dbPass,
    database: brand.dbName,
    connectTimeout: 15000,
    timezone: "Z",
    dateStrings: true,
  });
  return {
    raw,
    conn: {
      query: async (sql, options = {}) => {
        const [rows] = await raw.query({ sql, timeout: 180000 }, options.replacements || []);
        return rows;
      },
    },
  };
}

// Every difference between two JSON-like values, as "path: a != b" lines.
function diff(a, b, at = "root", out = []) {
  if (a === b) return out;
  if (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9) return out;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    keys.forEach((key) => diff(a[key], b[key], `${at}.${key}`, out));
    return out;
  }
  out.push(`${at}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  return out;
}

async function timed(fn) {
  const started = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - started };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const brand = loadBrand(options.brand);
  const { raw, conn } = await openConnection(brand, options.readHost);
  const { buildIntentFunnelService, createQueryCache } = require("../services/intentFunnelService");
  const { buildHeatmapService } = require("../services/heatmapService");

  const spec = { conn, brandKey: options.brand, start: options.from, end: options.to };
  // a fresh cache each run, so nothing is answered from an earlier one
  const funnel = () => buildIntentFunnelService({ cache: createQueryCache() });
  const heatmap = () => buildHeatmapService({ cache: createQueryCache() });

  const checks = [
    {
      name: "intent page",
      flag: "INTENT_COMBINED_SCAN",
      run: () => funnel().getIntentFunnel({ ...spec, timezone: "Asia/Kolkata", sort: "views", pathStart: "page_viewed", pathTop: 5, skipPaths: true }),
    },
    { name: "user overlap (behaviour)", flag: "INTENT_OVERLAP_SINGLE_QUERY", run: () => funnel().getSourceOverlap({ ...spec, basis: "behavior", intent: "all" }) },
    { name: "user overlap (score, high)", flag: "INTENT_OVERLAP_SINGLE_QUERY", run: () => funnel().getSourceOverlap({ ...spec, basis: "score", intent: "high" }) },
    { name: "heatmap pages", flag: "INTENT_HEATMAP_SINGLE_QUERY", run: () => heatmap().getHeatmapPages({ ...spec, device: "all", search: "", limit: 50 }) },
  ];
  if (options.path) {
    checks.push({
      name: `heatmap elements ${options.path}`,
      flag: "INTENT_HEATMAP_SINGLE_QUERY",
      run: () => heatmap().getHeatmapElements({ ...spec, path: options.path, limit: 20 }),
    });
  }

  let failed = 0;
  console.log(`Brand ${options.brand}, ${options.from}..${options.to} (read-only)\n`);
  for (const check of checks) {
    process.env[check.flag] = "off";
    const before = await timed(check.run);
    delete process.env[check.flag];
    const after = await timed(check.run);

    const differences = diff(JSON.parse(JSON.stringify(before.result)), JSON.parse(JSON.stringify(after.result)));
    const verdict = differences.length === 0 ? "SAME" : `DIFFERENT (${differences.length})`;
    console.log(`${check.name.padEnd(34)} ${verdict.padEnd(14)} before ${String(before.ms).padStart(6)} ms   after ${String(after.ms).padStart(6)} ms`);
    if (differences.length) {
      failed += 1;
      differences.slice(0, 15).forEach((line) => console.log(`    ${line}`));
    }
  }

  await raw.end();
  console.log(failed === 0 ? "\nAll answers are identical." : `\n${failed} check(s) differ. Do not switch the optimisations on for this brand.`);
  process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, diff };
