const express = require("express");
const multer = require("multer");
const { requirePermission } = require("../shared/middleware/identityEdge");
const { brandContext } = require("../shared/middleware/brandContext");
const pnlController = require("../controllers/pnl.controller");
const metaAdsCredentialsController = require("../controllers/metaAdsCredentials.controller");
const googleAdsCredentialsController = require("../controllers/googleAdsCredentials.controller");
const pnlProductCogsController = require("../controllers/pnlProductCogs.controller");
const pnlProductConfigController = require("../controllers/pnlProductConfig.controller");
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
  router.post("/meta-ads/oauth/exchange", brandContext, metaAdsCredentialsController.oauthExchange);
  router.post("/meta-ads/oauth/connect", brandContext, metaAdsCredentialsController.oauthConnect);

  // "Connect with Google" sends the brand through Google's OAuth consent
  // screen for a refresh token; /connect stays as a fallback for a brand
  // that already has a refresh token in hand and pastes it directly. Either
  // way it's stored in Mongo for the pipeline's Google Ads sync.
  router.get("/google-ads/status", brandContext, googleAdsCredentialsController.status);
  router.post("/google-ads/connect", brandContext, googleAdsCredentialsController.connect);
  router.delete("/google-ads/disconnect", brandContext, googleAdsCredentialsController.disconnect);
  router.get("/google-ads/oauth/config", brandContext, googleAdsCredentialsController.oauthConfig);
  router.post("/google-ads/oauth/exchange", brandContext, googleAdsCredentialsController.oauthExchange);
  router.post("/google-ads/oauth/connect", brandContext, googleAdsCredentialsController.oauthConnect);

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

  // Per-product COGS (flat, one document per brand in `product_config`):
  // download a CSV of the brand's products to fill in, then upload it back.
  // Uploading also rolls the sum into the cost config's "cogs" line above.
  router.get("/product-config", brandContext, pnlProductConfigController.get);
  router.get("/product-config/template", brandContext, pnlProductConfigController.downloadTemplate);
  router.post(
    "/product-config/upload",
    brandContext,
    csvUpload.single("file"),
    pnlProductConfigController.upload,
  );

  return router;
}

module.exports = {
  buildPnlRouter,
};
