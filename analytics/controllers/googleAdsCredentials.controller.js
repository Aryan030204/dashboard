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

  // Feeds the "Connect with Google" button: tells the frontend which OAuth
  // client id and scope to send Google's consent screen to.
  async oauthConfig(req, res) {
    try {
      const clientId = process.env.GOOGLE_ADS_CLIENT_ID || "";
      if (!clientId) {
        return res.status(400).json({ error: "GOOGLE_ADS_CLIENT_ID is not configured on the backend." });
      }
      return res.json({ clientId, scope: googleAdsCredentialsService.GOOGLE_OAUTH_SCOPE });
    } catch (error) {
      return handleControllerError(res, error, "google-ads-oauth-config failed");
    }
  },

  // Second leg of "Connect with Google": the OAuth redirect hands the
  // frontend an authorization code, which is exchanged here (needs the
  // client secret) for a refresh token that's parked against the brand -
  // never sent back to the browser.
  async oauthExchange(req, res) {
    try {
      const code = req.body?.code ? String(req.body.code).trim() : "";
      const redirectUri = req.body?.redirect_uri ? String(req.body.redirect_uri).trim() : "";
      if (!code || !redirectUri) {
        return res.status(400).json({ error: "code and redirect_uri are required." });
      }
      const result = await googleAdsCredentialsService.startOauth({
        brandKey: req.brandKey,
        code,
        redirectUri,
        updatedByEmail: req.user?.email || null,
      });
      if (!result.success) return res.status(400).json({ error: result.error });
      return res.json({ verified: true });
    } catch (error) {
      return handleControllerError(res, error, "google-ads-oauth-exchange failed");
    }
  },

  // Third leg: the brand picked which customer id to connect. Reads the
  // refresh token parked by oauthExchange and stores the real credential.
  async oauthConnect(req, res) {
    try {
      const result = await googleAdsCredentialsService.finalizeOauth({
        brandKey: req.brandKey,
        customerId: req.body?.customer_id,
        loginCustomerId: req.body?.login_customer_id,
        updatedByEmail: req.user?.email || null,
      });
      if (!result.success) return res.status(400).json({ error: result.error });
      return res.json(result.status);
    } catch (error) {
      return handleControllerError(res, error, "google-ads-oauth-connect failed");
    }
  },
};

module.exports = googleAdsCredentialsController;
