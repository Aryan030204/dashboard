const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const yauzl = require("yauzl");
const { httpError } = require("../errors");

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PDF_MAGIC = Buffer.from("%PDF-");
// The PDF spec lets a few bytes of junk precede the header; real readers accept it within the first KB.
const PDF_HEADER_WINDOW = 1024;

const ALLOWED_EXTENSIONS = ["pptx", "ppt", "pdf"];
const UNSUPPORTED_TYPE_MESSAGE = "Only .pptx, .ppt or .pdf files are supported.";

function extensionOf(name) {
  const ext = path.extname(String(name || "")).toLowerCase().replace(".", "");
  return ALLOWED_EXTENSIONS.includes(ext) ? ext : null;
}

async function readHead(filePath, length) {
  const fd = await fs.promises.open(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(filePath)
      .on("data", (d) => hash.update(d))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

// Looks inside the OOXML zip without extracting it to disk: bounded entry count and uncompressed
// size (zip-bomb guard), required parts present, and no macro content. Single pass.
function inspectPptx(filePath, limits) {
  const corrupt = (msg) => httpError(422, "CORRUPT_FILE", msg || "This file could not be read. Re-export it and try again.");
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(corrupt());
      let entries = 0;
      let total = 0;
      let hasContentTypes = false;
      let hasPresentation = false;
      let macro = false;
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        try {
          zip.close();
        } catch (_) {
          /* already closed */
        }
        reject(e);
      };

      zip.on("error", () => fail(corrupt()));
      zip.on("entry", (entry) => {
        entries += 1;
        total += entry.uncompressedSize;
        if (entries > limits.maxZipEntries || total > limits.maxUncompressedBytes) {
          return fail(corrupt("This file is too large or complex to process."));
        }
        const name = entry.fileName;
        if (name === "ppt/presentation.xml") hasPresentation = true;
        if (/(^|\/)vbaProject\.bin$/i.test(name)) macro = true;

        if (name !== "[Content_Types].xml") return zip.readEntry();

        hasContentTypes = true;
        if (entry.uncompressedSize > 1024 * 1024) return fail(corrupt());
        zip.openReadStream(entry, (e, stream) => {
          if (e) return fail(corrupt());
          const chunks = [];
          stream.on("data", (c) => chunks.push(c));
          stream.on("error", () => fail(corrupt()));
          stream.on("end", () => {
            // Macro-enabled decks declare it in their content types.
            if (/macroEnabled|vbaProject/i.test(Buffer.concat(chunks).toString("utf8"))) macro = true;
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => {
        if (settled) return;
        if (!hasContentTypes || !hasPresentation) {
          return fail(corrupt("This file does not look like a PowerPoint presentation."));
        }
        if (macro) {
          return fail(httpError(415, "MACRO_ENABLED_NOT_ALLOWED", "Macro-enabled presentations are not supported."));
        }
        settled = true;
        resolve();
      });
      zip.readEntry();
    });
  });
}

// Validates a file already written to disk by multer. Returns { ext, sizeBytes, sha256 }.
async function validateUpload({ filePath, originalName, sizeBytes }, limits) {
  const ext = extensionOf(originalName);
  if (!ext) throw httpError(415, "UNSUPPORTED_FILE_TYPE", UNSUPPORTED_TYPE_MESSAGE);
  if (!sizeBytes) throw httpError(422, "CORRUPT_FILE", "The file is empty.");

  const head = await readHead(filePath, ext === "pdf" ? PDF_HEADER_WINDOW : 8);
  if (ext === "pdf") {
    // Content is only ever rasterised by poppler (no scripts run), so the header check is the gate here;
    // page count and page shape are enforced by the worker before anything is rendered.
    if (head.indexOf(PDF_MAGIC) === -1) {
      throw httpError(415, "UNSUPPORTED_FILE_TYPE", "This file is not a valid .pdf document.");
    }
  } else if (ext === "pptx") {
    if (head.length < 4 || !head.subarray(0, 4).equals(ZIP_MAGIC)) {
      throw httpError(415, "UNSUPPORTED_FILE_TYPE", "This file is not a valid .pptx presentation.");
    }
    await inspectPptx(filePath, limits);
  } else {
    // Legacy binary PowerPoint (OLE container). Content is not inspectable here; LibreOffice
    // never runs macros headless, and the manager previews before publishing.
    if (head.length < 8 || !head.equals(OLE_MAGIC)) {
      throw httpError(415, "UNSUPPORTED_FILE_TYPE", "This file is not a valid .ppt presentation.");
    }
  }
  return { ext, sizeBytes, sha256: await sha256File(filePath) };
}

module.exports = { validateUpload, extensionOf, UNSUPPORTED_TYPE_MESSAGE };
