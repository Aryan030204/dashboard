const { normalizeShopifyId, isFallbackId, synthPid } = require("./normalize");

function resolveProductId(brand, sessionId, e) {
  let productId = normalizeShopifyId(e?.data?.product_id ?? null);
  if (!productId || isFallbackId(productId)) {
    productId = synthPid(brand, sessionId, e);
  }
  return productId;
}

module.exports = { resolveProductId };
