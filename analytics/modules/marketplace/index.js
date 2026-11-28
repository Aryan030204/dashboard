const express = require("express");
const { requirePermission } = require("../../shared/middleware/identityEdge");
const { brandContext } = require("../../shared/middleware/brandContext");
const { buildMarketplaceController } = require("./controller");

function buildMarketplaceRouter() {
  const router = express.Router();
  const controller = buildMarketplaceController();

  router.get("/overview", requirePermission("marketplace_panel"), brandContext, controller.overview);
  router.get("/product", requirePermission("marketplace_panel"), brandContext, controller.product);

  return router;
}

module.exports = { buildMarketplaceRouter };
