// AES-256-CBC, same algorithm and key convention as analytics/shared/utils/crypto.js and tenant-router, so
// PASSWORD_AES_KEY stays the single shared secret. Format: "<iv base64>:<ciphertext base64>".
const crypto = require("crypto");

const ALGO = "aes-256-cbc";

function normalizeKey(key) {
  if (!key) throw new Error("PASSWORD_AES_KEY is required for encryption/decryption");
  let buf = Buffer.from(key);
  if (buf.length < 32) {
    const padded = Buffer.alloc(32);
    buf.copy(padded);
    buf = padded;
  } else if (buf.length > 32) {
    buf = buf.subarray(0, 32);
  }
  return buf;
}

function encryptText(plain, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, normalizeKey(key), iv);
  return `${iv.toString("base64")}:${cipher.update(plain, "utf8", "base64") + cipher.final("base64")}`;
}

function decryptText(enc, key) {
  const parts = String(enc || "").split(":");
  if (parts.length !== 2) throw new Error("Invalid encrypted value format");
  const decipher = crypto.createDecipheriv(ALGO, normalizeKey(key), Buffer.from(parts[0], "base64"));
  return decipher.update(parts[1], "base64", "utf8") + decipher.final("utf8");
}

module.exports = { encryptText, decryptText };
