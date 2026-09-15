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

  // Feeds the "Connect with Meta" button: tells the frontend which app id to
  // send Meta's OAuth dialog to.
  async oauthConfig(req, res) {
    try {
      const appId = process.env.META_APP_ID || "";
      if (!appId) {
        return res.status(400).json({ error: "META_APP_ID is not configured on the backend." });
      }
      return res.json({
        appId,
        apiVersion: process.env.META_API_VERSION || "v21.0",
        scope: "ads_read",
      });
    } catch (error) {
      return handleControllerError(res, error, "meta-ads-oauth-config failed");
    }
  },

  // Proof-of-concept endpoint backing the "Connect with Meta" button: parks
  // whatever token the OAuth redirect captured in Mongo (analytics-service's
  // own DB, not the tenant brand DB — those connections are read replicas),
  // so we can confirm the connect flow works end to end before wiring it into
  // the real meta_ads_credentials table.
  async logOauthToken(req, res) {
    try {
      const accessToken = req.body?.access_token ? String(req.body.access_token).trim() : "";
      if (!accessToken) {
        return res.status(400).json({ error: "access_token is required" });
      }
      const expiresIn = req.body?.expires_in ? String(req.body.expires_in).trim() : null;

      console.log("[meta-oauth] received token from Meta connect flow", {
        brandKey: req.brandKey,
        updatedByEmail: req.user?.email || null,
        expiresIn,
      });

      const log = await metaAdsCredentialsService.saveOauthLog({
        brandKey: req.brandKey,
        accessToken,
        expiresIn,
        updatedByEmail: req.user?.email || null,
      });
      return res.json({ updated: true, log });
    } catch (error) {
      return handleControllerError(res, error, "meta-ads-oauth-log failed");
    }
  },

  // What the OAuth flow last captured for this brand (token masked), so the
  // P&L page can show it on load.
  async oauthLog(req, res) {
    try {
      const log = await metaAdsCredentialsService.getOauthLog(req.brandKey);
      return res.json({ log });
    } catch (error) {
      return handleControllerError(res, error, "meta-ads-oauth-log-status failed");
    }
  },
};

module.exports = metaAdsCredentialsController;
