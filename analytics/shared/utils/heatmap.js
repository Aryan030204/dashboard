// Pure helpers shared by the heatmap rollup job and the heatmap API.

const MAX_PATH_LENGTH = 255;
const DEVICES = Object.freeze(["desktop", "mobile", "tablet"]);

// A storefront URL (or path) -> the page path the click rollups use (click_behavior_daily.page_path):
// no scheme or host, no query string or hash (so UTM / fbclid / variant parameters never split a page),
// lowercase, no duplicate or trailing slashes ("/" stays "/"). Returns "" when there is nothing usable.
function normalizePagePath(input) {
  let text = String(input ?? "").trim();
  if (!text) return "";
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  text = text.split("#")[0].split("?")[0];
  if (!text) return "/";
  if (!text.startsWith("/")) text = `/${text}`;
  text = text.replace(/\/{2,}/g, "/").toLowerCase();
  if (text.length > 1) text = text.replace(/\/+$/, "");
  if (!text) return "/";
  return text.length > MAX_PATH_LENGTH ? "" : text;
}

// Device from the user agent. Mirrors DEVICE_CASE_SQL, which the rollup job runs in the database.
// iPads that ask for the desktop site look like a Mac and count as desktop; there is no way to tell.
function deviceFromUserAgent(userAgent) {
  const ua = String(userAgent ?? "");
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "tablet";
  if (/iPhone|Android|Mobile/i.test(ua)) return "mobile";
  return "desktop";
}

// Constant SQL, never request input.
const DEVICE_CASE_SQL = `CASE
        WHEN user_agent LIKE '%iPad%' OR user_agent LIKE '%Tablet%'
          OR (user_agent LIKE '%Android%' AND user_agent NOT LIKE '%Mobile%') THEN 'tablet'
        WHEN user_agent LIKE '%iPhone%' OR user_agent LIKE '%Android%' OR user_agent LIKE '%Mobile%' THEN 'mobile'
        ELSE 'desktop'
      END`;

// Escapes LIKE wildcards in user input so a search for "50%" is not a pattern.
function escapeLike(value) {
  return String(value ?? "").replace(/[\\%_]/g, (char) => `\\${char}`);
}

module.exports = {
  MAX_PATH_LENGTH,
  DEVICES,
  DEVICE_CASE_SQL,
  normalizePagePath,
  deviceFromUserAgent,
  escapeLike,
};
