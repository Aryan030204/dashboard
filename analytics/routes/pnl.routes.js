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

  router.get("/google-ads/status", brandContext, googleAdsCredentialsController.status);
  router.get("/google-ads/oauth/config", brandContext, googleAdsCredentialsController.oauthConfig);
  router.post("/google-ads/oauth/exchange", brandContext, googleAdsCredentialsController.oauthExchange);
  router.post("/google-ads/customers/refresh", brandContext, googleAdsCredentialsController.refreshCustomers);
  router.put("/google-ads/customer", brandContext, googleAdsCredentialsController.setCustomer);
  router.delete("/google-ads/disconnect", brandContext, googleAdsCredentialsController.disconnect);
  router.get("/google-ads/spend", brandContext, googleAdsCredentialsController.spend);

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
