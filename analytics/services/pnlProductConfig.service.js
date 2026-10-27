const { QueryTypes } = require("sequelize");
const ProductConfig = require("../shared/db/models/ProductConfig.mongo");
const { resolveBrandRef } = require("../shared/db/models/Tenant.mongo");
const pnlCostConfigService = require("./pnlCostConfig.service");

// Per-product COGS: the brand downloads a CSV template (product_id + title
// from their own product_landing_mapping table, plus any cogs already
// saved), fills in a flat cogs value per product, and re-uploads it. The
// upload replaces the brand's single product_config document wholesale (a
// blank cogs cell just means "not set for this product", the same way a
// re-download always reflects current state) and rolls the sum of every
// product's cogs into total_config.costs.cogs via pnlCostConfig.service, so
// the existing brand-level P&L keeps working without a separate manual
// entry for that line.

function normalizeBrandKey(brandKey) {
  return String(brandKey || "").trim().toUpperCase();
}

async function getProductConfig(brandKey) {
  const key = normalizeBrandKey(brandKey);
  if (!key) return { exists: false, productConfig: {} };
  const doc = await ProductConfig.findOne({ brand_id: key }).lean();
  if (!doc) return { exists: false, productConfig: {} };
  return {
    exists: true,
    productConfig: doc.product_config || {},
    updatedByEmail: doc.updated_by_email || null,
    updatedAt: doc.updated_at || null,
  };
}

// ---- CSV template -----------------------------------------------------

const TEMPLATE_HEADER = ["product_id", "title", "cogs"];

function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(rows) {
  return [TEMPLATE_HEADER, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

// One row per product_id known to this brand (latest-synced title wins for
// products with more than one landing page row), with any already-saved
// cogs value pre-filled so a re-download always reflects current state.
async function downloadTemplate({ brandKey, conn }) {
  if (!conn) throw new Error("No database connection for this brand.");
  const key = normalizeBrandKey(brandKey);

  const rows = await conn.query(
    `
      SELECT product_id, title
      FROM product_landing_mapping
      WHERE id IN (SELECT MAX(id) FROM product_landing_mapping GROUP BY product_id)
      ORDER BY product_id ASC
    `,
    { type: QueryTypes.SELECT },
  );

  const existing = await getProductConfig(key);
  const csv = toCsv(
    rows.map((row) => {
      const cogs = existing.productConfig?.[String(row.product_id)]?.cogs;
      return [row.product_id, row.title || "", cogs != null ? cogs : ""];
    }),
  );

  return { csv, filename: `product-cogs-template-${key}.csv` };
}

// ---- CSV upload ---------------------------------------------------------
// Same small RFC4180-ish parser as pnlProductCogs.service.js's CSV upload -
// kept local rather than shared since the two services' row shapes and
// validation differ, and neither warrants a dependency for this.

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      pushField();
    } else if (char === "\n") {
      pushRow();
    } else if (char === "\r") {
      // ignore — the following \n (or end of text) terminates the row
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase();
}

function validateRow(raw, colIndex, lineNumber) {
  const get = (name) => (colIndex[name] != null ? String(raw[colIndex[name]] ?? "").trim() : "");
  const productId = get("product_id");
  const cogsRaw = get("cogs");

  if (!productId) return { line: lineNumber, status: "error", error: "product_id is required" };
  if (cogsRaw === "") {
    return { line: lineNumber, product_id: productId, status: "skipped", error: "cogs is blank" };
  }
  const cogs = Number(cogsRaw);
  if (!Number.isFinite(cogs) || cogs < 0) {
    return { line: lineNumber, product_id: productId, status: "error", error: "cogs must be a number >= 0" };
  }
  return { ok: true, productId, cogs };
}

// Parses the filled-in template and replaces the brand's whole
// product_config document (not a per-row upsert) - a re-upload is the new
// complete picture, matching downloadTemplate always reflecting current
// state. Rows with a blank cogs cell are skipped, not errors: a brand can
// fill in only the products they have a rate for.
async function uploadCogs({ brandKey, csvText, updatedByEmail }) {
  const key = normalizeBrandKey(brandKey);
  if (!key) throw new Error("brandKey is required");

  const rows = parseCsv(String(csvText || "").trim());
  if (rows.length < 2) {
    return { success: false, error: "CSV must have a header row and at least one data row.", results: [] };
  }

  const header = rows[0].map(normalizeHeader);
  const missing = ["product_id", "cogs"].filter((h) => !header.includes(h));
  if (missing.length > 0) {
    return { success: false, error: `Missing required column(s): ${missing.join(", ")}`, results: [] };
  }
  const colIndex = Object.fromEntries(header.map((h, i) => [h, i]));

  const results = [];
  const productConfig = {};
  for (let i = 1; i < rows.length; i++) {
    const lineNumber = i + 1;
    const validated = validateRow(rows[i], colIndex, lineNumber);
    if (!validated.ok) {
      results.push(validated);
      continue;
    }
    productConfig[validated.productId] = { cogs: validated.cogs };
    results.push({ line: lineNumber, product_id: validated.productId, status: "ok" });
  }

  const failed = results.filter((r) => r.status === "error").length;
  const succeeded = Object.keys(productConfig).length;
  if (succeeded === 0) {
    return {
      success: false,
      error: "No valid cogs values found in the CSV.",
      total: results.length,
      succeeded: 0,
      failed,
      results,
    };
  }

  await ProductConfig.findOneAndUpdate(
    { brand_id: key },
    {
      $set: {
        brand: await resolveBrandRef(key),
        brand_id: key,
        product_config: productConfig,
        updated_by_email: updatedByEmail || null,
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  const aggregateCogs = Object.values(productConfig).reduce((sum, entry) => sum + entry.cogs, 0);
  await pnlCostConfigService.upsertCostLine({
    brandKey: key,
    field: "cogs",
    value: aggregateCogs,
    valueType: "flat",
    updatedByEmail,
  });

  return {
    success: failed === 0,
    total: results.length,
    succeeded,
    failed,
    aggregateCogs,
    results,
  };
}

module.exports = {
  getProductConfig,
  downloadTemplate,
  uploadCogs,
};
