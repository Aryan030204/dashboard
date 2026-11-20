// Gmail access behind a small interface so the pipeline never sees HTTP:
//   listCandidates({ sender, afterEpochSec, beforeEpochSec }) -> [{ id, from, subject, receivedMs, attachments }]
//   downloadAttachment({ messageId, attachmentId, destPath, maxBytes }) -> { bytes, sha256 }
// The default implementation uses the public Gmail REST API (users.messages.list/get, messages.attachments.get).
// Gmail returns an attachment as ONE base64url JSON body, so a download is bounded by NDD_SLA_MAX_ATTACHMENT_BYTES
// (Gmail's own ceiling is 25 MB) and is written straight to a temp file; the CSV is then streamed from disk and
// never parsed from memory. Access tokens come from getAccessToken() and are never logged.
const crypto = require("crypto");
const fs = require("fs");
const { PipelineError } = require("../errors");
const { ensureLogger } = require("../logger");

const MAX_LIST_PAGES = 10;

function collectAttachments(part, out = []) {
  if (!part) return out;
  if (part.filename && part.body && part.body.attachmentId) {
    out.push({ id: part.body.attachmentId, filename: part.filename, size: Number(part.body.size) || 0 });
  }
  for (const child of part.parts || []) collectAttachments(child, out);
  return out;
}

function header(message, name) {
  const h = ((message.payload && message.payload.headers) || []).find((x) => String(x.name).toLowerCase() === name);
  return h ? h.value : "";
}

function buildGmailClient({
  getAccessToken, fetchImpl = globalThis.fetch, baseUrl = "https://gmail.googleapis.com/gmail/v1", timeoutMs = 30000, logger,
}) {
  const log = ensureLogger(logger, "gmail");
  if (typeof getAccessToken !== "function") throw new Error("gmail client needs getAccessToken()");

  async function call(path, query) {
    const url = new URL(`${baseUrl}${path}`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${await getAccessToken()}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof PipelineError) throw err;
      throw new PipelineError("GMAIL_NETWORK", `Gmail request failed: ${err.message}`, { retryable: true, cause: err });
    }
    if (res.status === 401 || res.status === 403) {
      throw new PipelineError("GMAIL_AUTH", `Gmail rejected the credentials (HTTP ${res.status})`);
    }
    if (res.status === 429 || res.status >= 500) {
      throw new PipelineError("GMAIL_UNAVAILABLE", `Gmail returned HTTP ${res.status}`, { retryable: true });
    }
    if (!res.ok) throw new PipelineError("GMAIL_HTTP", `Gmail returned HTTP ${res.status}`);
    return res.json();
  }

  return {
    async listCandidates({ sender, afterEpochSec, beforeEpochSec }) {
      const q = [`from:${sender}`, "has:attachment", `after:${afterEpochSec}`, `before:${beforeEpochSec}`].join(" ");
      const out = [];
      let pageToken;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const list = await call("/users/me/messages", { q, maxResults: 50, pageToken });
        for (const ref of list.messages || []) {
          const message = await call(`/users/me/messages/${encodeURIComponent(ref.id)}`, { format: "full" });
          out.push({
            id: message.id,
            from: header(message, "from"),
            subject: header(message, "subject"),
            receivedMs: Number(message.internalDate),
            attachments: collectAttachments(message.payload),
          });
        }
        pageToken = list.nextPageToken;
        if (!pageToken) break;
      }
      log.debug("gmail candidates listed", { count: out.length });
      return out;
    },

    async downloadAttachment({ messageId, attachmentId, destPath, maxBytes, expectedSize = 0 }) {
      if (maxBytes && expectedSize > maxBytes) {
        throw new PipelineError("ATTACHMENT_TOO_LARGE", `Attachment is ${expectedSize} bytes, above the ${maxBytes} byte limit`);
      }
      const body = await call(`/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
      const data = Buffer.from(String(body.data || ""), "base64url");
      if (!data.length) throw new PipelineError("ATTACHMENT_EMPTY", "Gmail returned an empty attachment");
      if (maxBytes && data.length > maxBytes) {
        throw new PipelineError("ATTACHMENT_TOO_LARGE", `Attachment is ${data.length} bytes, above the ${maxBytes} byte limit`);
      }
      await fs.promises.writeFile(destPath, data);
      return { bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
    },
  };
}

// The stored GMAIL credential is an OAuth refresh token (encrypted), exchanged for a short-lived access token at
// Google's token endpoint. The OAuth client id/secret are deployment config (see .env.example).
function buildRefreshTokenProvider({ getRefreshToken, clientId, clientSecret, fetchImpl = globalThis.fetch, tokenUrl = "https://oauth2.googleapis.com/token" }) {
  let cached = null;
  return async function getAccessToken() {
    if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
    if (!clientId || !clientSecret) throw new PipelineError("GMAIL_CONFIG_MISSING", "NDD_GMAIL_CLIENT_ID / NDD_GMAIL_CLIENT_SECRET are not set");
    const refresh = await getRefreshToken();
    const res = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: "refresh_token" }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new PipelineError("GMAIL_AUTH", `Google token exchange failed (HTTP ${res.status})`, { retryable: res.status >= 500 });
    }
    const json = await res.json();
    cached = { token: json.access_token, expiresAt: Date.now() + Number(json.expires_in || 300) * 1000 };
    return cached.token;
  };
}

module.exports = { buildGmailClient, buildRefreshTokenProvider, collectAttachments };
