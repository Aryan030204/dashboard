// Encrypted Gmail / EasyCom credentials (table ndd_sla_credentials). The token is decrypted in memory only, on demand,
// and never logged; token_suffix (last 4 characters) is the only value ever shown.
const { encryptText, decryptText } = require("../lib/crypto");
const { PipelineError } = require("../errors");

const PROVIDERS = ["GMAIL", "EASYCOM"];

function buildCredentials(pool, { aesKey }) {
  const check = (provider) => {
    if (!PROVIDERS.includes(provider)) throw new Error(`unknown credential provider ${provider}`);
  };
  return {
    async save(brandKey, provider, token, { accountEmail = null } = {}) {
      check(provider);
      const plain = String(token || "").trim();
      if (!plain) throw new Error("token is empty");
      await pool.query(
        `INSERT INTO ndd_sla_credentials (brand_key, provider, token_encrypted, token_suffix, account_email, last_error)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON DUPLICATE KEY UPDATE token_encrypted = VALUES(token_encrypted), token_suffix = VALUES(token_suffix),
           account_email = VALUES(account_email), last_error = NULL`,
        [brandKey, provider, encryptText(plain, aesKey), plain.slice(-4), accountEmail],
      );
    },

    // Throws a non-retryable PipelineError when nothing is stored: retrying cannot create a credential.
    async getToken(brandKey, provider) {
      check(provider);
      const [rows] = await pool.query(
        "SELECT token_encrypted FROM ndd_sla_credentials WHERE brand_key = ? AND provider = ?",
        [brandKey, provider],
      );
      if (!rows.length) throw new PipelineError(`${provider}_CREDENTIAL_MISSING`, `No ${provider} credential is stored for brand ${brandKey}`);
      try {
        return decryptText(rows[0].token_encrypted, aesKey);
      } catch (err) {
        throw new PipelineError(`${provider}_CREDENTIAL_UNREADABLE`, `The stored ${provider} credential cannot be decrypted (wrong PASSWORD_AES_KEY?)`);
      }
    },

    async markVerified(brandKey, provider, error = null) {
      check(provider);
      await pool.query(
        "UPDATE ndd_sla_credentials SET last_verified_at = IF(? IS NULL, UTC_TIMESTAMP(), last_verified_at), last_error = ? WHERE brand_key = ? AND provider = ?",
        [error, error ? String(error).slice(0, 500) : null, brandKey, provider],
      );
    },

    async describe(brandKey) {
      const [rows] = await pool.query(
        "SELECT provider, token_suffix, account_email, last_verified_at, last_error FROM ndd_sla_credentials WHERE brand_key = ?",
        [brandKey],
      );
      return rows.map((r) => ({
        provider: r.provider, tokenSuffix: r.token_suffix, accountEmail: r.account_email,
        lastVerifiedAt: r.last_verified_at, lastError: r.last_error,
      }));
    },
  };
}

module.exports = { buildCredentials, PROVIDERS };
