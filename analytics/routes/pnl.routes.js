const express = require("express");
const multer = require("multer");
const { requirePermission } = require("../shared/middleware/identityEdge");
const { brandContext } = require("../shared/middleware/brandContext");
const pnlController = require("../controllers/pnl.controller");
const metaAdsCredentialsController = require("../controllers/metaAdsCredentials.controller");
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
  router.get("/meta-ads/oauth/log", brandContext, metaAdsCredentialsController.oauthLog);
  router.post("/meta-ads/oauth/log", brandContext, metaAdsCredentialsController.logOauthToken);

  router.get("/cost-configs", brandContext, pnlCostConfigController.list);
  router.put("/cost-configs/:category", brandContext, pnlCostConfigController.upsert);
  router.delete("/cost-configs/:category", brandContext, pnlCostConfigController.clear);

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
