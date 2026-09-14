const { handleControllerError } = require("../shared/middleware/handleControllerError");
const metaAdsCredentialsService = require("../services/metaAdsCredentials.service");

const metaAdsCredentialsController = {
  async status(req, res) {
    try {
      const status = await metaAdsCredentialsService.getStatus(req.brandKey);
      return res.json(status);
    } catch (error) {
      return handleControllerError(res, error, "meta-ads-status failed");
    }
  },

  async connect(req, res) {
    try {
      const adAccountId = req.body?.ad_account_id ? String(req.body.ad_account_id).trim() : "";
      const accessToken = req.body?.access_token ? String(req.body.access_token).trim() : "";

      const result = await metaAdsCredentialsService.saveCredentials({
        brandKey: req.brandKey,
        adAccountId,
        accessToken,
        updatedByEmail: req.user?.email || null,
      });

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      const status = await metaAdsCredentialsService.getStatus(req.brandKey);
      return res.json(status);
    } catch (error) {
      return handleControllerError(res, error, "meta-ads-connect failed");
    }
  },

  async disconnect(req, res) {
    try {
      await metaAdsCredentialsService.deleteCredentials(req.brandKey);
      return res.json({ connected: false });
    } catch (error) {
      return handleControllerError(res, error, "meta-ads-disconnect failed");
    }
  },
};

module.exports = metaAdsCredentialsController;
