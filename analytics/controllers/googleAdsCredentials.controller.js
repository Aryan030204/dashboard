const { handleControllerError } = require("../shared/middleware/handleControllerError");
const googleAdsCredentialsService = require("../services/googleAdsCredentials.service");

const googleAdsCredentialsController = {
  async status(req, res) {
    try {
      return res.json(await googleAdsCredentialsService.getStatus(req.brandKey));
    } catch (error) {
      return handleControllerError(res, error, "google-ads-status failed");
    }
  },

  // Merchant pasted a customer id + token: validate and store it encrypted.
  // The token goes in the body only and is never echoed back.
  async connect(req, res) {
    try {
      const result = await googleAdsCredentialsService.saveCredentials({
        brandKey: req.brandKey,
        customerId: req.body?.customer_id,
        loginCustomerId: req.body?.login_customer_id,
        token: req.body?.token,
        updatedByEmail: req.user?.email || null,
      });
      if (!result.success) return res.status(400).json({ error: result.error });
      return res.json(result.status);
    } catch (error) {
      return handleControllerError(res, error, "google-ads-connect failed");
    }
  },

  async disconnect(req, res) {
    try {
      await googleAdsCredentialsService.deleteCredentials(req.brandKey);
      return res.json({ connected: false });
    } catch (error) {
      return handleControllerError(res, error, "google-ads-disconnect failed");
    }
  },
};

module.exports = googleAdsCredentialsController;
