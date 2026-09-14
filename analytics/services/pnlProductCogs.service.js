// Backs POST /pnl/product-cogs/upload — parses a CSV of per-product COGS
// rates and upserts them into pnl_product_cogs (see migration 004).
//
// No CSV parsing library is used on purpose (none was already a dependency
// of this service) — the format needed here is simple enough that a small
// RFC4180-ish parser is less risk than a new dependency.

const REQUIRED_HEADERS = ["product_id", "value_type", "value", "effective_from"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALUE_TYPES = new Set(["flat", "percentage"]);
const OPEN_ENDED_SENTINEL = "9999-12-31";

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

// Replaces any existing active row for this product whose range overlaps
// the incoming one, then inserts the new row — a re-upload for the same
// product + overlapping date range replaces the old value outright rather
// than keeping history.
async function upsertRow(conn, row) {
  await conn.query(
    `
      DELETE FROM pnl_product_cogs
      WHERE product_id = ?
        AND is_active = 1
        AND effective_from <= ?
        AND (effective_to IS NULL OR effective_to >= ?)
    `,
    {
      replacements: [row.productId, row.effectiveTo || OPEN_ENDED_SENTINEL, row.effectiveFrom],
    },
  );

  await conn.query(
    `
      INSERT INTO pnl_product_cogs
        (product_id, product_title, value_type, value, effective_from, effective_to, source, uploaded_by_email)
      VALUES (?, ?, ?, ?, ?, ?, 'csv_upload', ?)
    `,
    {
      replacements: [
        row.productId,
        row.productTitle || null,
        row.valueType,
        row.value,
        row.effectiveFrom,
        row.effectiveTo || null,
        row.uploadedByEmail || null,
      ],
    },
  );
}

function validateRow(raw, colIndex, lineNumber) {
  const get = (name) => (colIndex[name] != null ? String(raw[colIndex[name]] ?? "").trim() : "");

  const productId = get("product_id");
  const valueType = get("value_type").toLowerCase();
  const valueRaw = get("value");
  const effectiveFrom = get("effective_from");
  const effectiveTo = get("effective_to");
  const productTitle = get("product_title");
  const value = Number(valueRaw);

  if (!productId) return { line: lineNumber, status: "error", error: "product_id is required" };
  if (!VALUE_TYPES.has(valueType)) {
    return { line: lineNumber, product_id: productId, status: "error", error: "value_type must be 'flat' or 'percentage'" };
  }
  if (!valueRaw || !Number.isFinite(value)) {
    return { line: lineNumber, product_id: productId, status: "error", error: "value must be a number" };
  }
  if (!DATE_RE.test(effectiveFrom)) {
    return { line: lineNumber, product_id: productId, status: "error", error: "effective_from must be YYYY-MM-DD" };
  }
  if (effectiveTo && !DATE_RE.test(effectiveTo)) {
    return { line: lineNumber, product_id: productId, status: "error", error: "effective_to must be YYYY-MM-DD" };
  }

  return {
    ok: true,
    productId,
    productTitle,
    valueType,
    value,
    effectiveFrom,
    effectiveTo,
  };
}

async function uploadCsv({ conn, csvText, uploadedByEmail }) {
  if (!conn) throw new Error("No database connection for this brand.");

  const rows = parseCsv(String(csvText || "").trim());
  if (rows.length < 2) {
    return { success: false, error: "CSV must have a header row and at least one data row.", results: [] };
  }

  const header = rows[0].map(normalizeHeader);
  const missing = REQUIRED_HEADERS.filter((h) => !header.includes(h));
  if (missing.length > 0) {
    return { success: false, error: `Missing required column(s): ${missing.join(", ")}`, results: [] };
  }
  const colIndex = Object.fromEntries(header.map((h, i) => [h, i]));

  const results = [];
  for (let i = 1; i < rows.length; i++) {
    const lineNumber = i + 1;
    const validated = validateRow(rows[i], colIndex, lineNumber);
    if (!validated.ok) {
      results.push(validated);
      continue;
    }

    try {
      await upsertRow(conn, { ...validated, uploadedByEmail });
      results.push({ line: lineNumber, product_id: validated.productId, status: "ok" });
    } catch (error) {
      results.push({ line: lineNumber, product_id: validated.productId, status: "error", error: error.message });
    }
  }

  const failed = results.filter((r) => r.status === "error").length;
  return {
    success: failed === 0,
    total: results.length,
    succeeded: results.length - failed,
    failed,
    results,
  };
}

module.exports = {
  uploadCsv,
};
