const { httpError } = require("../errors");

// Only Fireflies meeting links are accepted, and the link is only ever PARSED for its meeting id: it is never
// fetched. The actual API call always goes to the fixed Fireflies GraphQL endpoint (see firefliesClient.js), so a
// user-supplied URL can never make the server request an arbitrary address (SSRF).
//
// Accepted: https://app.fireflies.ai/view/<title-slug>::<id>   or   https://app.fireflies.ai/view/<id>
const ALLOWED_HOST = "app.fireflies.ai";
const MAX_URL_LENGTH = 2048;
const ID_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const INVALID_MESSAGE = "Enter a Fireflies meeting link, for example https://app.fireflies.ai/view/...";

function invalid() {
  return httpError(400, "INVALID_FIREFLIES_URL", INVALID_MESSAGE);
}

// Returns { transcriptId, sourceUrl } or throws a 400 INVALID_FIREFLIES_URL.
function parseFirefliesUrl(input) {
  if (typeof input !== "string") throw invalid();
  const text = input.trim();
  if (!text || text.length > MAX_URL_LENGTH) throw invalid();

  let url;
  try {
    url = new URL(text);
  } catch (_err) {
    throw invalid();
  }
  if (url.protocol !== "https:") throw invalid();
  if (url.hostname !== ALLOWED_HOST) throw invalid(); // exact match: no sub-domains, no look-alike hosts
  if (url.port) throw invalid();
  if (url.username || url.password) throw invalid();

  // /view/<slug>::<id>, ignoring an optional trailing slash
  const parts = url.pathname.split("/").filter((s) => s !== "");
  if (parts.length !== 2 || parts[0] !== "view") throw invalid();

  let last;
  try {
    last = decodeURIComponent(parts[1]);
  } catch (_err) {
    throw invalid();
  }
  const transcriptId = last.includes("::") ? last.slice(last.lastIndexOf("::") + 2) : last;
  if (!ID_PATTERN.test(transcriptId)) throw invalid();

  // Stored form: scheme + host + path only (no query string, fragment or anything else the user attached).
  return { transcriptId, sourceUrl: `https://${ALLOWED_HOST}${url.pathname}` };
}

module.exports = { parseFirefliesUrl, ALLOWED_HOST };
