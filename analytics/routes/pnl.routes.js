const express = require("express");
const multer = require("multer");
const { requirePermission } = require("../shared/middleware/identityEdge");
const { brandContext } = require("../shared/middleware/brandContext");
const pnlController = require("../controllers/pnl.controller");
const metaAdsCredentialsController = require("../controllers/metaAdsCredentials.controller");
const googleAdsCredentialsController = require("../controllers/googleAdsCredentials.controller");
const pnlProductCogsController = require("../controllers/pnlProductCogs.controller");
const pnlCostConfigController = require("../controllers/pnlCostConfig.controller");

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function buildPnlRouter() {
  const router = express.Router();

  router.use(requirePermission("pnl_panel"));

  router.get("/summary", brandContext, pnlController.summary);

  router.get("/meta-ads/status", brandContext, metaAdsCredentialsController.status);
  router.post("/meta-ads/connect", brandContext, metaAdsCredentialsController.connect);
  router.delete("/meta-ads/disconnect", brandContext, metaAdsCredentialsController.disconnect);
  router.get("/meta-ads/oauth/config", brandContext, metaAdsCredentialsController.oauthConfig);
  router.post("/meta-ads/oauth/ad-accounts", brandContext, metaAdsCredentialsController.oauthAdAccounts);
  router.get("/meta-ads/oauth/log", brandContext, metaAdsCredentialsController.oauthLog);
  router.post("/meta-ads/oauth/log", brandContext, metaAdsCredentialsController.logOauthToken);

  // Merchant pastes a Google Ads customer id + token; stored in Mongo for the
  // pipeline's Google Ads sync. No OAuth and no live Google calls here.
  router.get("/google-ads/status", brandContext, googleAdsCredentialsController.status);
  router.post("/google-ads/connect", brandContext, googleAdsCredentialsController.connect);
  router.delete("/google-ads/disconnect", brandContext, googleAdsCredentialsController.disconnect);

  // One total_config document per brand (gst_pct + every cost line).
  router.get("/cost-configs", brandContext, pnlCostConfigController.get);
  router.put("/cost-configs", brandContext, pnlCostConfigController.save);
  router.put("/cost-configs/:field", brandContext, pnlCostConfigController.upsertField);
  router.delete("/cost-configs/:field", brandContext, pnlCostConfigController.clearField);

  router.post(
    "/product-cogs/upload",
    brandContext,
    csvUpload.single("file"),
    pnlProductCogsController.upload,
  );

  return router;
}

module.exports = {
  buildPnlRouter,
};
