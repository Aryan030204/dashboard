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

  // Feeds the "Connect with Google" button: which OAuth client id to send the
  // user to Google with. The client secret never leaves the backend.
  async oauthConfig(req, res) {
    try {
      const config = googleAdsCredentialsService.getOauthConfig();
      if (!config.clientId) {
        return res.status(400).json({ error: "GOOGLE_ADS_CLIENT_ID is not configured on the backend." });
      }
      return res.json(config);
    } catch (error) {
      return handleControllerError(res, error, "google-ads-oauth-config failed");
    }
  },

  // Second leg of the flow: the redirect back from Google carries a one-time
  // code; this swaps it for a refresh token + access token and stores them.
  async oauthExchange(req, res) {
    try {
      const code = req.body?.code ? String(req.body.code).trim() : "";
      const redirectUri = req.body?.redirect_uri ? String(req.body.redirect_uri).trim() : "";
      const result = await googleAdsCredentialsService.exchangeCode({
        brandKey: req.brandKey,
        code,
        redirectUri,
        updatedByEmail: req.user?.email || null,
      });
      if (!result.success) return res.status(400).json({ error: result.error });
      return res.json({ ...result.status, customersError: result.customersError || null });
    } catch (error) {
      return handleControllerError(res, error, "google-ads-oauth-exchange failed");
    }
  },

  async refreshCustomers(req, res) {
    try {
      const result = await googleAdsCredentialsService.refreshCustomers(req.brandKey);
      if (!result.success) return res.status(400).json({ error: result.error });
      return res.json({ ...result.status, customersError: result.customersError || null });
    } catch (error) {
      return handleControllerError(res, error, "google-ads-customers failed");
    }
  },

  async setCustomer(req, res) {
    try {
      const result = await googleAdsCredentialsService.setCustomer({
        brandKey: req.brandKey,
        customerId: req.body?.customer_id,
      });
      if (!result.success) return res.status(400).json({ error: result.error });
      return res.json(result.status);
    } catch (error) {
      return handleControllerError(res, error, "google-ads-set-customer failed");
    }
  },

  async disconnect(req, res) {
    try {
      await googleAdsCredentialsService.disconnect(req.brandKey);
      return res.json({ connected: false });
    } catch (error) {
      return handleControllerError(res, error, "google-ads-disconnect failed");
    }
  },

  // Date-wise spend for the brand's chosen customer, pulled live from Google
  // with the stored refresh token. ?date=YYYY-MM-DD for one day, or
  // ?start=&end= for an inclusive range; one entry per day either way.
  async spend(req, res) {
    try {
      const result = await googleAdsCredentialsService.getSpendByDate({
        brandKey: req.brandKey,
        date: req.query?.date,
        start: req.query?.start,
        end: req.query?.end,
        customerId: req.query?.customer_id,
      });
      if (!result.success) return res.status(400).json({ error: result.error });
      return res.json(result);
    } catch (error) {
      return handleControllerError(res, error, "google-ads-spend failed");
    }
  },
};

module.exports = googleAdsCredentialsController;
