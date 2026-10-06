// DEAD CODE. Nothing imports this file and nothing should.
//
// Code that has been removed from the live service but kept for reference lives here.
// Add new entries with a note on where they came from and why they were removed.
//
// ---------------------------------------------------------------------------------------
// RS event handling, removed from POST /track (app.js).
//
// It handled two RS payload shapes before the idempotency check was applied:
//   - tags === "RS_Cinema_KP" with a customer_id -> ajrs_otpverified collection
//   - orderId                                    -> ajrsPurchase collection
// Both returned 201 "Session tracked successfully" and skipped records that already
// existed. The models and the CSV import script that went with it are below.
//
// Original routing in /track:
//   const isRSEvent = sessionData.tags === "RS_Cinema_KP" || sessionData.orderId;
//   // the idempotency_key was required only when !isRSEvent
// ---------------------------------------------------------------------------------------
async function handleRsEvent({ sessionData, res, logger, OtpVerified, AjrsPurchase }) {
  if (sessionData.tags === "RS_Cinema_KP" && sessionData.customer_id) {
    const exists = await OtpVerified.findOne({ customer_id: sessionData.customer_id });
    if (!exists) {
      const otpVerify = new OtpVerified({ customer_id: sessionData.customer_id });
      await otpVerify.save();
      logger.info(`[track] OTP Verified saved for customer: ${sessionData.customer_id}`);
    }
  }

  if (sessionData.orderId) {
    const exists = await AjrsPurchase.findOne({ order_id: sessionData.orderId });
    if (!exists) {
      const purchase = new AjrsPurchase({ order_id: sessionData.orderId });
      await purchase.save();
      logger.info(`[track] AJRS Purchase saved for order: ${sessionData.orderId}`);
    }
  }

  return res.status(201).json({ message: "Session tracked successfully" });
}


// ---------------------------------------------------------------------------------------
// RS / AJRS Mongoose models, removed from models/. Wrapped in functions so that loading
// this file never registers a model.
// ---------------------------------------------------------------------------------------

// was models/ajrsPurchase.js
function defineAjrsPurchaseModel(mongoose) {
  const ajrsPurchaseSchema = new mongoose.Schema({
    order_id: { type: String, required: true },
  }, {
    timestamps: true,
    collection: 'ajrsPurchase',
  });
  return mongoose.model('ajrsPurchase', ajrsPurchaseSchema);
}

// was models/otpVerified.js
function defineOtpVerifiedModel(mongoose) {
  const otpVerifiedSchema = new mongoose.Schema({
    customer_id: { type: String, required: true },
  }, {
    timestamps: true,
    collection: 'ajrs_otpverified',
  });
  return mongoose.model('ajrs_otpverified', otpVerifiedSchema);
}

// ---------------------------------------------------------------------------------------
// was scripts/import-otp-verified.js, run with `npm run import:otp-verified` (script
// removed from package.json). One-off import of verified phone numbers from a CSV export
// into the ajrs_otpverified collection. Kept verbatim as a comment so it can never run
// from here. Its require paths ('../models/otpVerified', '../.env') assumed scripts/.
// ---------------------------------------------------------------------------------------
/*
#!/usr/bin/env node
require('dotenv').config({
  path: require('path').resolve(__dirname, '../.env'),
});

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const OtpVerified = require('../models/otpVerified');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const MONGO_DB = process.env.MONGO_DB || 'alerts';
const CSV_PATH = path.resolve(
  __dirname,
  '../user-segmentation-SNOWPLOW-IN-193kbvc47o31-1773998983080.csv'
);

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return headers.reduce((row, header, index) => {
      row[header] = values[index] || '';
      return row;
    }, {});
  });
}

function parseTimestamp(value) {
  const match = String(value || '').trim().match(
    /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/
  );
  if (!match) return null;

  const [, day, month, year, hour, minute] = match;
  const isoValue = `${year}-${month}-${day}T${hour}:${minute}:00+05:30`;
  const parsed = new Date(isoValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function run() {
  const csvContent = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCsv(csvContent);
  const uniqueRows = new Map();
  let skipped = 0;

  for (const row of rows) {
    const status = String(row['OTP Verified'] || '').trim().toLowerCase();
    const customerId = String(row['Phone Number'] || '').trim();
    const timestamp = parseTimestamp(row.Timestamp);

    if (status !== 'verified' || !customerId || !timestamp) {
      skipped += 1;
      continue;
    }

    const existing = uniqueRows.get(customerId);
    if (!existing || timestamp > existing.createdAt) {
      uniqueRows.set(customerId, {
        customer_id: customerId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
  }

  await mongoose.connect(MONGO_URI, { dbName: MONGO_DB });

  const customerIds = Array.from(uniqueRows.keys());
  const existingDocs = customerIds.length
    ? await OtpVerified.find(
        { customer_id: { $in: customerIds } },
        { customer_id: 1, _id: 0 }
      ).lean()
    : [];
  const existingIds = new Set(existingDocs.map((doc) => doc.customer_id));
  const docsToInsert = Array.from(uniqueRows.values()).filter(
    (doc) => !existingIds.has(doc.customer_id)
  );

  if (docsToInsert.length) {
    await OtpVerified.collection.insertMany(docsToInsert, { ordered: false });
  }

  console.log('[otp-import] completed');
  console.log(`csv rows: ${rows.length}`);
  console.log(`unique verified phones: ${uniqueRows.size}`);
  console.log(`skipped rows: ${skipped}`);
  console.log(`inserted: ${docsToInsert.length}`);
  console.log(`already present: ${existingIds.size}`);
}

run()
  .catch((err) => {
    console.error('[otp-import] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
*/

// Nothing below is exported or required anywhere. Referenced once only so editors and
// linters do not flag the definitions above as unused.
void [handleRsEvent, defineAjrsPurchaseModel, defineOtpVerifiedModel];
