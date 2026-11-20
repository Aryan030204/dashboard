// Streaming RFC 4180 CSV reader. Consumes a Readable chunk by chunk and yields ONE row object at a time, keyed by the
// header names, so memory is bounded by the chunk size plus the largest single row, never by the file size.
// Handles: UTF-8 BOM, CRLF/LF, quoted fields with embedded commas/newlines/"" escapes, multi-byte characters split
// across chunks, ragged rows (missing trailing fields become ""), blank lines (skipped).
const { StringDecoder } = require("string_decoder");
const { PipelineError } = require("../errors");

// Header matching ignores case, spaces and punctuation, so "Shipment(Pickup At)" and "shipment pickup at" are the same.
const canon = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
const HEADER_SCAN_ROWS = 25; // a title/banner above the real header is tolerated for this many rows

// `required`: column names the caller will read. Header cells are matched case/whitespace-insensitively and renamed
// to the caller's spelling, so a "reference code " header still works. Missing columns fail fast, before any row.
// `project: true` materializes ONLY the required columns of each row (the exports have ~100 columns, the report reads 2-5).
// `aliases`: { requiredName: [other accepted header spellings] }, tried when the preferred name is absent. Column ORDER
// never matters (cells are read by header name). If the first row is not the header (banner/blank lines above it), the
// first of the next HEADER_SCAN_ROWS rows that contains every required column is used instead.
async function* parseCsv(readable, { required = [], aliases = {}, project = false, delimiter = ",", maxFieldChars = 100000 } = {}) {
  const decoder = new StringDecoder("utf8");
  let header = null;
  let projected = null; // with `project`: [[index, name]] of the required columns only
  let row = [];
  let field = "";
  let inQuotes = false;
  let quoteSeen = false; // inside quotes a `"` was just read: escape or closing quote, decided by the next char
  let fieldWasQuoted = false;
  let started = false;
  let pending = [];
  let headerRowsSeen = 0;
  let firstHeaderFields = null;
  let firstMissing = [];

  const endField = () => {
    row.push(field);
    field = "";
    fieldWasQuoted = false;
  };

  const endRow = () => {
    endField();
    const fields = row;
    row = [];
    if (!header) {
      const wanted = new Map();
      for (const name of required) {
        for (const alias of [name, ...(aliases[name] || [])]) if (!wanted.has(canon(alias))) wanted.set(canon(alias), name);
      }
      // Preferred spelling wins over an alias when both exist in the file.
      const mapped = fields.map((cell) => wanted.get(canon(cell)) || String(cell).trim());
      const preferred = new Set(fields.map((c) => canon(c)));
      const seen = new Set();
      const candidate = mapped.map((name, i) => {
        if (!required.includes(name)) return name;
        const isPreferred = canon(fields[i]) === canon(name);
        if (seen.has(name)) return `${name}#dup${i}`;
        if (!isPreferred && preferred.has(canon(name))) return `${name}#alias${i}`;
        seen.add(name);
        return name;
      });
      const missing = required.filter((name) => !candidate.includes(name));
      if (missing.length) {
        headerRowsSeen += 1;
        if (headerRowsSeen < HEADER_SCAN_ROWS) {
          if (!firstHeaderFields) {
            firstHeaderFields = fields;
            firstMissing = missing;
          }
          return; // maybe the real header is further down
        }
        const found = (firstHeaderFields || fields).filter(Boolean).join(" | ").slice(0, 220);
        throw new PipelineError("CSV_MISSING_COLUMNS", `CSV header is missing column(s): ${(firstHeaderFields ? firstMissing : missing).join(", ")}. The file's columns are: ${found}`);
      }
      header = candidate;
      if (project) projected = candidate.map((name, i) => [i, name]).filter(([, name]) => required.includes(name));
      return;
    }
    if (fields.length === 1 && fields[0] === "") return; // blank line
    const obj = {};
    if (projected) for (const [i, name] of projected) obj[name] = i < fields.length ? fields[i] : "";
    else for (let i = 0; i < header.length; i += 1) obj[header[i]] = i < fields.length ? fields[i] : "";
    pending.push(obj);
  };

  // Fast scanner: ordinary characters are copied as whole runs (slice), and only quotes, the delimiter and line breaks are
  // looked at one by one. Same output as a char-by-char state machine, far fewer string appends on wide files.
  const escapedDelimiter = delimiter.replace(/[\]\\^-]/g, "\\$&");
  const plain = new RegExp(`[^"${escapedDelimiter}\\r\\n]*`, "y");
  const feed = (text) => {
    const n = text.length;
    let i = 0;
    while (i < n) {
      if (quoteSeen) {
        quoteSeen = false;
        if (text[i] === '"') {
          field += '"';
          i += 1;
          continue;
        }
        inQuotes = false; // it was the closing quote; the char at i is read as unquoted below
      }
      if (inQuotes) {
        const q = text.indexOf('"', i);
        if (q === -1) {
          field += text.slice(i);
          i = n;
        } else {
          field += text.slice(i, q);
          quoteSeen = true;
          i = q + 1;
        }
      } else {
        plain.lastIndex = i;
        const run = plain.exec(text)[0];
        if (run.length) {
          field += run;
          i += run.length;
          if (i >= n) break;
        }
        const ch = text[i];
        i += 1;
        if (ch === '"' && field === "" && !fieldWasQuoted) {
          inQuotes = true;
          fieldWasQuoted = true;
        } else if (ch === delimiter) {
          endField();
        } else if (ch === "\n") {
          endRow();
        } else if (ch !== "\r") {
          field += ch; // a quote in the middle of an unquoted field is literal
        }
      }
      if (field.length > maxFieldChars) {
        throw new PipelineError("CSV_FIELD_TOO_LARGE", `A CSV field exceeds ${maxFieldChars} characters (unterminated quote?)`);
      }
    }
  };

  for await (const chunk of readable) {
    let text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (!started && text.length) {
      started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    feed(text);
    if (pending.length) {
      const out = pending;
      pending = [];
      for (const r of out) yield r;
    }
  }
  feed(decoder.end());
  if (quoteSeen) {
    quoteSeen = false;
    inQuotes = false;
  }
  if (inQuotes) throw new PipelineError("CSV_UNTERMINATED_QUOTE", "CSV ends inside a quoted field");
  if (field !== "" || row.length) endRow();
  if (!header && firstHeaderFields) {
    // Short file that never produced a header: report what the first row held.
    const miss = firstMissing.join(", ");
    throw new PipelineError("CSV_MISSING_COLUMNS", `CSV header is missing column(s): ${miss}. The file's columns are: ${firstHeaderFields.filter(Boolean).join(" | ").slice(0, 220)}`);
  }
  if (!header) throw new PipelineError("CSV_EMPTY", "CSV file is empty (no header row)");
  for (const r of pending) yield r;
}

module.exports = { parseCsv };
