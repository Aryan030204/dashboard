const { parseIanaTimezone } = require("./timezone");

// In-memory snapshot of brand config from arch-auth.pipelinecreds, keyed by
// `${brand_tag}_shop` (the brand_id the pixel sends). Read once at startup and
// refreshed on an interval, so there is no per-event DB or API call. A failed
// refresh keeps the last good snapshot.
function createBrandSnapshot({ loadDocs, intervalMs, logger }) {
  let snapshot = new Map();
  let inFlight = null;

  async function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const docs = await loadDocs();
      const next = new Map();
      for (const doc of docs) {
        if (!doc?.brand_tag) continue;
        next.set(`${doc.brand_tag}_shop`, {
          active: doc.is_active === true,
          store_timezone_iana: parseIanaTimezone(doc.store_timezone),
        });
      }
      snapshot = next;
      logger?.info?.(`[brandSnapshot] loaded ${next.size} brands`);
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function getBrand(brandId) {
    return snapshot.get(brandId) || null;
  }

  function startRefresh() {
    const timer = setInterval(() => {
      refresh().catch((err) => {
        logger?.error?.(`[brandSnapshot] refresh failed, keeping last snapshot: ${err.message}`);
      });
    }, intervalMs);
    timer.unref?.();
    return timer;
  }

  return { refresh, getBrand, startRefresh };
}

module.exports = { createBrandSnapshot };
