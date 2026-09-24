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
      const rawTokenType = req.body?.token_type ? String(req.body.token_type).trim() : "user";
      if (rawTokenType !== "user" && rawTokenType !== "system_user") {
        return res.status(400).json({ error: "token_type must be 'user' or 'system_user'." });
      }

      const result = await metaAdsCredentialsService.saveCredentials({
        brandKey: req.brandKey,
        adAccountId,
        accessToken,
        tokenType: rawTokenType,
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

  // Feeds the "Continue with Meta" button: tells the frontend which app id
  // and Facebook Login for Business configuration to send Meta's OAuth
  // dialog to. The configuration (Meta App Dashboard > Facebook Login for
  // Business > Configurations) is what determines the requested
  // ads_read/ads_management permissions and the ad-account asset picker, and
  // sets the token type to a non-expiring System-business access token - so
  // no `scope` param here, config_id carries all of that instead.
  async oauthConfig(req, res) {
    try {
      const appId = process.env.META_APP_ID || "";
      const configId = process.env.META_LOGIN_CONFIG_ID || "";
      if (!appId) {
        return res.status(400).json({ error: "META_APP_ID is not configured on the backend." });
      }
      if (!configId) {
        return res.status(400).json({ error: "META_LOGIN_CONFIG_ID is not configured on the backend." });
      }
      return res.json({
        appId,
        configId,
        apiVersion: process.env.META_API_VERSION || "v21.0",
      });
    } catch (error) {
      return handleControllerError(res, error, "meta-ads-oauth-config failed");
    }
  },

  // Backs the manual System User token paste path: lists the ad accounts a
  // pasted token can see so the brand can pick which one to connect, the same
  // way oauthExchange does for the "Continue with Meta" redirect. Token
  // travels in the body, not the query string, to keep it out of access logs.
  async oauthAdAccounts(req, res) {
    try {
      const accessToken = req.body?.access_token ? String(req.body.access_token).trim() : "";
      if (!accessToken) {
        return res.status(400).json({ error: "access_token is required" });
      }
      const result = await metaAdsCredentialsService.listAdAccounts(accessToken);
      if (!result.success) {
        return res.status(400).json({ error: `Meta rejected the token: ${result.error}` });
      }
      return res.json({ accounts: result.accounts });
    } catch (error) {
      return handleControllerError(res, error, "meta-ads-oauth-ad-accounts failed");
    }
  },

  // Second leg of "Continue with Meta": the OAuth redirect hands the frontend
  // an authorization code, which is exchanged here (needs the app secret) for
  // a System-business access token that's parked server-side - never sent
  // back to the browser - while the brand picks which ad account to connect
  // from the list Meta scoped the login to.
  async oauthExchange(req, res) {
    try {
      const code = req.body?.code ? String(req.body.code).trim() : "";
      const redirectUri = req.body?.redirect_uri ? String(req.body.redirect_uri).trim() : "";
      if (!code || !redirectUri) {
        return res.status(400).json({ error: "code and redirect_uri are required." });
      }
      const result = await metaAdsCredentialsService.startOauth({
        brandKey: req.brandKey,
        code,
        redirectUri,
        updatedByEmail: req.user?.email || null,
      });
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      return res.json({ accounts: result.accounts });
    } catch (error) {
      return handleControllerError(res, error, "meta-ads-oauth-exchange failed");
    }
  },

  // Third leg: the brand picked which ad account to connect. Reads the token
  // parked by oauthExchange and stores the real credential.
  async oauthConnect(req, res) {
    try {
      const adAccountId = req.body?.ad_account_id ? String(req.body.ad_account_id).trim() : "";
      if (!adAccountId) {
        return res.status(400).json({ error: "ad_account_id is required" });
      }
      const result = await metaAdsCredentialsService.finalizeOauth({
        brandKey: req.brandKey,
        adAccountId,
        updatedByEmail: req.user?.email || null,
      });
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      const status = await metaAdsCredentialsService.getStatus(req.brandKey);
      return res.json(status);
    } catch (error) {
      return handleControllerError(res, error, "meta-ads-oauth-connect failed");
    }
  },
};

module.exports = metaAdsCredentialsController;
