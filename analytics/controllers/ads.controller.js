const { handleControllerError } = require("../shared/middleware/handleControllerError");
const adsPerformanceService = require("../services/adsPerformance.service");
const adsAlertRulesService = require("../services/adsAlertRules.service");
const { triggerPnlBackfill } = require("../shared/utils/pipelineClient");

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Default range: the last 7 complete days (the worker syncs through yesterday).
function rangeFrom(req) {
  return {
    start: req.query.start ? String(req.query.start) : isoDaysAgo(7),
    end: req.query.end ? String(req.query.end) : isoDaysAgo(1),
  };
}

const adsController = {
  async overview(req, res) {
    try {
      return res.json(await adsPerformanceService.getOverview({ conn: req.brandDb?.sequelize, ...rangeFrom(req) }));
    } catch (error) {
      return handleControllerError(res, error, "ads-overview failed");
    }
  },

  // GET /pnl/ads/campaigns?channel=all|meta|google — each campaign carries
  // the alert rules it breaches over the requested range.
  async campaigns(req, res) {
    try {
      const { rules } = await adsAlertRulesService.getRules(req.brandKey);
      return res.json(
        await adsPerformanceService.getCampaigns({
          conn: req.brandDb?.sequelize,
          ...rangeFrom(req),
          channel: req.query.channel ? String(req.query.channel) : null,
          rules,
        }),
      );
    } catch (error) {
      return handleControllerError(res, error, "ads-campaigns failed");
    }
  },

  async campaignAds(req, res) {
    try {
      return res.json(
        await adsPerformanceService.getCampaignAds({
          conn: req.brandDb?.sequelize,
          ...rangeFrom(req),
          channel: req.query.channel ? String(req.query.channel) : null,
          campaignId: String(req.params.campaignId || ""),
        }),
      );
    } catch (error) {
      return handleControllerError(res, error, "ads-campaign-ads failed");
    }
  },

  async products(req, res) {
    try {
      return res.json(await adsPerformanceService.getProducts({ conn: req.brandDb?.sequelize, ...rangeFrom(req) }));
    } catch (error) {
      return handleControllerError(res, error, "ads-products failed");
    }
  },

  async landingPages(req, res) {
    try {
      return res.json(await adsPerformanceService.getLandingPages({ conn: req.brandDb?.sequelize, ...rangeFrom(req) }));
    } catch (error) {
      return handleControllerError(res, error, "ads-landing-pages failed");
    }
  },

  async getAlertRules(req, res) {
    try {
      return res.json(await adsAlertRulesService.getRules(req.brandKey));
    } catch (error) {
      return handleControllerError(res, error, "ads-alert-rules-get failed");
    }
  },

  // PUT /pnl/ads/alert-rules  body: { rules: [...] } — replaces the full set.
  async saveAlertRules(req, res) {
    try {
      return res.json(
        await adsAlertRulesService.saveRules({
          brandKey: req.brandKey,
          rules: req.body?.rules,
          updatedByEmail: req.user?.email || null,
        }),
      );
    } catch (error) {
      return handleControllerError(res, error, "ads-alert-rules-save failed");
    }
  },

  async alertEvents(req, res) {
    try {
      return res.json({ events: await adsAlertRulesService.listEvents({ brandKey: req.brandKey, limit: req.query.limit }) });
    } catch (error) {
      return handleControllerError(res, error, "ads-alert-events failed");
    }
  },

  // POST /pnl/ads/sync — the ads tables are filled by the P&L worker, so a
  // manual sync is the same 30-day P&L backfill the connect flow triggers.
  // The worker only fetches channels with a credential document (and Meta
  // only on a system_user token), so say so up front instead of starting a
  // run that will log "no-credentials" and change nothing.
  async sync(req, res) {
    try {
      const [meta, google] = await Promise.all([
        metaAdsCredentialsService.getStatus(req.brandKey),
        googleAdsCredentialsService.getStatus(req.brandKey),
      ]);
      const connections = {
        meta: {
          connected: Boolean(meta?.connected),
          syncable: Boolean(meta?.connected) && meta.tokenType === "system_user",
          tokenType: meta?.tokenType || null,
          lastError: meta?.lastError || null,
        },
        google: {
          connected: Boolean(google?.connected),
          syncable: Boolean(google?.connected),
          lastError: google?.lastError || null,
        },
      };
      if (!connections.meta.syncable && !connections.google.syncable) {
        return res.json({ triggered: false, syncing: false, reason: "no_connections", connections });
      }
      return res.json({ ...(await triggerPnlBackfill(req.brandKey, { days: 30 })), connections });
    } catch (error) {
      return handleControllerError(res, error, "ads-sync failed");
    }
  },
};

module.exports = adsController;
