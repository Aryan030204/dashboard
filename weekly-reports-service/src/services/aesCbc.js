const crypto = require("crypto");

// AES-256-CBC for the Fireflies API key (the repo's established algorithm for stored third-party credentials).
//
//   encrypt(plain)            -> { ciphertext, iv }       both base64, a fresh random 16-byte IV every call
//   decrypt(ciphertext, iv)   -> plain
//
// The 32-byte key comes from the server environment (FIREFLIES_API_KEY_ENCRYPTION_KEY), as 64 hex characters or
// base64 of exactly 32 bytes. It is validated strictly (no padding or truncating) and never stored with the data.
// Errors are deliberately generic: they never contain the plaintext, the ciphertext or the key.
//
// Note: CBC is not authenticated, so a wrong key almost always fails with a padding error but can, rarely, decrypt to
// garbage. The caller will then be refused by Fireflies (auth_failed) rather than leak anything.

const ALGORITHM = "aes-256-cbc";
const ALGORITHM_LABEL = "AES-256-CBC";
const IV_BYTES = 16;

class CredentialCryptoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CredentialCryptoError";
    this.code = code;
  }
}

function parseKey(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new CredentialCryptoError("KEY_MISSING", "The encryption key is not configured.");
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(text)) key = Buffer.from(text, "hex");
  else if (/^[A-Za-z0-9+/]{43}=?$/.test(text)) key = Buffer.from(text, "base64");
  if (!key || key.length !== 32) {
    throw new CredentialCryptoError("KEY_INVALID", "The encryption key must be 32 bytes (64 hex characters or base64).");
  }
  return key;
}

const isBase64 = (value) => typeof value === "string" && value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);

function createAesCbc(rawKey) {
  const key = parseKey(rawKey);
  return {
    algorithm: ALGORITHM_LABEL,

    encrypt(plaintext) {
      if (typeof plaintext !== "string" || plaintext.length === 0) {
        throw new CredentialCryptoError("PLAINTEXT_INVALID", "There is nothing to encrypt.");
      }
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return { ciphertext: encrypted.toString("base64"), iv: iv.toString("base64") };
    },

    decrypt(ciphertext, iv) {
      if (!isBase64(ciphertext) || !isBase64(iv)) {
        throw new CredentialCryptoError("DECRYPT_FAILED", "The stored credential could not be decrypted.");
      }
      try {
        const ivBuffer = Buffer.from(iv, "base64");
        if (ivBuffer.length !== IV_BYTES) throw new Error("bad iv");
        const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuffer);
        const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
        const text = decrypted.toString("utf8");
        if (!text) throw new Error("empty");
        return text;
      } catch (_err) {
        throw new CredentialCryptoError("DECRYPT_FAILED", "The stored credential could not be decrypted.");
      }
    },
  };
}

module.exports = { createAesCbc, CredentialCryptoError, ALGORITHM_LABEL };
