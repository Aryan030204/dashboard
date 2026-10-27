const express = require("express");
const { requirePermission } = require("../shared/middleware/identityEdge");
const { brandContext } = require("../shared/middleware/brandContext");
const adsController = require("../controllers/ads.controller");

// Mounted at /pnl/ads (ahead of the P&L router, which would otherwise gate
// it on pnl_panel): it lives under /pnl because it reads the same ad
// connections and the same worker's output, but has its own permission.
function buildAdsRouter() {
  const router = express.Router();

  router.use(requirePermission("ads_panel"));

  router.get("/overview", brandContext, adsController.overview);
  router.get("/campaigns", brandContext, adsController.campaigns);
  router.get("/campaigns/:campaignId/ads", brandContext, adsController.campaignAds);
  router.get("/products", brandContext, adsController.products);
  router.get("/landing-pages", brandContext, adsController.landingPages);

  router.get("/alert-rules", brandContext, adsController.getAlertRules);
  router.put("/alert-rules", brandContext, adsController.saveAlertRules);
  router.get("/alert-events", brandContext, adsController.alertEvents);

  router.post("/sync", brandContext, adsController.sync);

  return router;
}

module.exports = {
  buildAdsRouter,
};
