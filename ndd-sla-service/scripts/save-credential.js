#!/usr/bin/env node
// Stores (or replaces) an encrypted integration credential in ndd_sla_credentials. The token is read from STDIN, never
// from argv (which ends up in shell history and process listings) and is never printed.
//
//   printf '%s' "<gmail refresh token>"   | node scripts/save-credential.js GMAIL   [--account-email ops@example.com]
//   printf '%s' "<easycom api token>"     | node scripts/save-credential.js EASYCOM
//   node scripts/save-credential.js --describe        (provider, last 4 characters, last verification, last error)
//
// Uses NDD_DB_* and PASSWORD_AES_KEY (+ NDD_SLA_BRAND_KEY) from the environment / .env, like the worker.
require("dotenv").config();
const { getConfig } = require("../src/config");
const { createPool } = require("../src/db/pool");
const { buildCredentials, PROVIDERS } = require("../src/services/credentials");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main() {
  const argv = process.argv.slice(2);
  const config = getConfig();
  if (!config.passwordAesKey) throw new Error("PASSWORD_AES_KEY is not set");
  const pool = createPool(config);
  const credentials = buildCredentials(pool, { aesKey: config.passwordAesKey });
  try {
    if (argv.includes("--describe")) {
      console.table(await credentials.describe(config.brandKey));
      return;
    }
    const provider = String(argv[0] || "").toUpperCase();
    if (!PROVIDERS.includes(provider)) throw new Error(`first argument must be one of ${PROVIDERS.join(", ")}`);
    const at = argv.indexOf("--account-email");
    const accountEmail = at >= 0 ? argv[at + 1] : null;
    if (process.stdin.isTTY) throw new Error("pipe the token on stdin, e.g.: printf '%s' \"$TOKEN\" | node scripts/save-credential.js " + provider);
    const token = await readStdin();
    if (!token) throw new Error("no token received on stdin");
    await credentials.save(config.brandKey, provider, token, { accountEmail });
    console.log(`saved ${provider} credential for ${config.brandKey} (ends with ...${token.slice(-4)})`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
