const { handleControllerError } = require("../shared/middleware/handleControllerError");
const webVitalsService = require("../services/webVitals.service");

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

const webVitalsController = {
  async snapshot(req, res) {
    try {
      if (!req.brandDb?.sequelize) {
        return res.status(500).json({ error: "Brand DB connection unavailable" });
      }
      const date = req.query.date ? String(req.query.date) : todayIsoDate();
      return res.json(await webVitalsService.getSnapshot({ conn: req.brandDb.sequelize, date }));
    } catch (error) {
      return handleControllerError(res, error, "web-vitals-snapshot failed");
    }
  },

  async trend(req, res) {
    try {
      if (!req.brandDb?.sequelize) {
        return res.status(500).json({ error: "Brand DB connection unavailable" });
      }
      const end = req.query.end ? String(req.query.end) : todayIsoDate();
      const start = req.query.start ? String(req.query.start) : end;
      const url = typeof req.query.url === "string" && req.query.url.trim() ? req.query.url.trim() : null;
      if (url && url.length > webVitalsService.MAX_TREND_URL_LENGTH) {
        return res.status(400).json({ error: "url is too long" });
      }
      return res.json(
        await webVitalsService.getTrend({ conn: req.brandDb.sequelize, start, end, url }),
      );
    } catch (error) {
      return handleControllerError(res, error, "web-vitals-trend failed");
    }
  },

  async allBrandsSnapshot(req, res) {
    try {
      const permissions = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
      const canViewAllBrands = !!req.user?.isAuthor || permissions.includes("all");
      if (!canViewAllBrands) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const date = req.query.date ? String(req.query.date) : todayIsoDate();
      return res.json({
        date,
        brands: await webVitalsService.getAllBrandsSnapshot({ date, user: req.user }),
      });
    } catch (error) {
      return handleControllerError(res, error, "web-vitals-all-brands-snapshot failed");
    }
  },

  async pages(req, res) {
    try {
      if (!req.brandDb?.sequelize) {
        return res.status(500).json({ error: "Brand DB connection unavailable" });
      }
      const date = req.query.date ? String(req.query.date) : todayIsoDate();
      return res.json({
        date,
        rows: await webVitalsService.getPageBreakdown({ conn: req.brandDb.sequelize, date }),
      });
    } catch (error) {
      return handleControllerError(res, error, "web-vitals-pages failed");
    }
  },
};

module.exports = webVitalsController;
