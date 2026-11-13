const crypto = require("crypto");

// Fireflies returns `summary.action_items` as ONE text block (type String in the Summary schema), not a list. The
// docs show no sample, so the format is not guaranteed; this parser is deliberately conservative:
//   - one pointer per non-empty line, kept verbatim (only surrounding space and a leading bullet / number removed);
//   - a line that is only a bold label ("**Alice**", "**Alice:**") is a group heading, not an item, and is skipped.
// Who an item belongs to when Fireflies groups by person is NOT captured in Phase 1 (no column for it yet).
const MAX_ITEMS = 200;
const MAX_ITEM_CHARS = 5000;
const HEADING = /^\*\*[^*]+\*\*:?$/;
const BULLET = /^(?:[-*•–—]|\d{1,3}[.)])\s+/;

function parseActionItems(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const items = [];
  const seen = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || HEADING.test(line)) continue;
    const original = line.replace(BULLET, "").trim().slice(0, MAX_ITEM_CHARS);
    if (!original) continue;
    // Stable per item: position among items plus a short hash, so re-running the parser gives the same keys.
    const hash = crypto.createHash("sha1").update(original).digest("hex").slice(0, 10);
    const occurrence = (seen.get(hash) || 0) + 1;
    seen.set(hash, occurrence);
    items.push({ sourceKey: `${hash}-${occurrence}`, originalText: original });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

module.exports = { parseActionItems, MAX_ITEMS };
