const { normalizeShopifyId, isFallbackId, synthPid } = require("./normalize");

// Slug enrichment failures never fail the event (as in the Sessions Pipeline).
async function enrichFromSlugCache(models, brand, e) {
  try {
    if (e.event_name === "page_viewed" && e.slug_info) {
      const cacheId = `${brand}:${e.slug_info.type}:${e.slug_info.slug}`;
      const cacheDoc = await models.SlugCache.findById(cacheId)
        .lean()
        .catch(() => null);
      if (cacheDoc && cacheDoc.shopify_id) {
        e.data = e.data || {};
        e.data.product_id = normalizeShopifyId(cacheDoc.shopify_id) || e.data.product_id;
      }
    }
  } catch {
    // swallow
  }
}

function resolveProductId(brand, sessionId, e) {
  let productId = normalizeShopifyId(e?.data?.product_id ?? null);
  if (!productId || isFallbackId(productId)) {
    productId = synthPid(brand, sessionId, e);
  }
  return productId;
}

module.exports = { enrichFromSlugCache, resolveProductId };
