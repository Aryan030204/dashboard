// Opens an uploaded/downloaded file as a Readable of CSV bytes, transparently un-gzipping it (the browser compresses
// uploads so a large CSV fits through the hosting proxy's request-size limit). Streaming throughout: nothing is read
// whole. A byte cap on the EXPANDED stream stops a zip bomb.
const fs = require("fs");
const zlib = require("zlib");
const crypto = require("crypto");
const { Transform, pipeline } = require("stream");
const { PipelineError } = require("../errors");

async function isGzip(path) {
  const handle = await fs.promises.open(path, "r");
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(2), 0, 2, 0);
    return bytesRead === 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  } finally {
    await handle.close();
  }
}

function byteLimit(max) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > max) return cb(new PipelineError("FILE_TOO_LARGE", `The file expands beyond ${max} bytes`));
      return cb(null, chunk);
    },
  });
}

async function openCsvStream(path, { maxExpandedBytes = 150 * 1024 * 1024 } = {}) {
  if (!(await isGzip(path))) return fs.createReadStream(path);
  const out = byteLimit(maxExpandedBytes);
  const gunzip = zlib.createGunzip();
  // Registered before pipeline() attaches its own listener, so the consumer sees a clear, non-retryable error.
  gunzip.on("error", (e) => {
    if (e && /^Z_/.test(String(e.code))) {
      e.code = "FILE_CORRUPT";
      e.message = "The file is not a valid gzip archive";
      e.retryable = false;
    }
  });
  pipeline(fs.createReadStream(path), gunzip, out, () => {});
  return out;
}

// sha256 and size of the file exactly as uploaded (what the audit record keeps; the file itself is not kept).
function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    fs.createReadStream(path)
      .on("data", (chunk) => { hash.update(chunk); bytes += chunk.length; })
      .on("error", reject)
      .on("end", () => resolve({ sha256: hash.digest("hex"), bytes }));
  });
}

module.exports = { openCsvStream, hashFile, isGzip };
