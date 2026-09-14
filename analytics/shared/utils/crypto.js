// Shared AES-256-CBC helpers for encrypting sensitive values (brand tokens,
// third-party API credentials) before they hit the database. Same algorithm
// and key convention as tenant-router's tenant/pipelineCreds models and
// tenantRouterClient's decryptPassword, so PASSWORD_AES_KEY stays the single
// shared secret across services.
const crypto = require("crypto");

const ALGO = "aes-256-cbc";

function normalizeKey(key) {
  const k = key || process.env.PASSWORD_AES_KEY;
  if (!k) throw new Error("PASSWORD_AES_KEY env var is required for encryption/decryption");
  let buf = Buffer.from(k);
  if (buf.length < 32) {
    const padded = Buffer.alloc(32);
    buf.copy(padded);
    buf = padded;
  } else if (buf.length > 32) {
    buf = buf.slice(0, 32);
  }
  return buf;
}

function encryptText(plain, key) {
  const k = normalizeKey(key);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, k, iv);
  let encrypted = cipher.update(plain, "utf8", "base64");
  encrypted += cipher.final("base64");
  return `${iv.toString("base64")}:${encrypted}`;
}

function decryptText(enc, key) {
  if (typeof enc !== "string") return "";
  const parts = enc.split(":");
  if (parts.length !== 2) throw new Error("Invalid encrypted value format");
  const k = normalizeKey(key);
  const iv = Buffer.from(parts[0], "base64");
  const decipher = crypto.createDecipheriv(ALGO, k, iv);
  let dec = decipher.update(parts[1], "base64", "utf8");
  dec += decipher.final("utf8");
  return dec;
}

module.exports = { encryptText, decryptText };
