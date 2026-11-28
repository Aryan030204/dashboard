const { handleControllerError } = require("../../shared/middleware/handleControllerError");
const {
  buildMarketplaceHistoryService,
  normalizeRangeRequest,
  normalizeProductRequest,
} = require("../../services/marketplaceHistoryService");

function buildMarketplaceController({ service = buildMarketplaceHistoryService() } = {}) {
  const handle = (normalize, run, tag) => async (req, res) => {
    try {
      const normalized = normalize(req.query, { timezone: req.tenantRoute?.timezone });
      if (!normalized.ok) return res.status(normalized.status).json(normalized.body);

      const conn = req.brandDb?.sequelize;
      if (!conn) return res.status(500).json({ error: "Brand DB connection unavailable" });

      const result = await run({ ...normalized.spec, conn });
      if (result.notFound) return res.status(404).json({ error: "Product not found" });
      return res.json(result);
    } catch (e) {
      return handleControllerError(res, e, tag);
    }
  };

  return {
    overview: handle(normalizeRangeRequest, service.getOverview, "marketplace overview failed"),
    product: handle(normalizeProductRequest, service.getProduct, "marketplace product failed"),
  };
}

module.exports = { buildMarketplaceController };
