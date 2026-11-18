const { handleControllerError } = require("../shared/middleware/handleControllerError");
const pnlService = require("../services/pnl.service");

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function currentMonthStartIsoDate() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

const pnlController = {
  async summary(req, res) {
    try {
      const granularity = req.query.granularity === "monthly" ? "monthly" : "daily";
      const end = req.query.end ? String(req.query.end) : todayIsoDate();
      const start = req.query.start ? String(req.query.start) : currentMonthStartIsoDate();
      const channel = req.query.sales_channel ? String(req.query.sales_channel) : null;
      const productId = req.query.product_id ? String(req.query.product_id) : null;
      const compareStart = isIsoDate(req.query.compare_start) ? String(req.query.compare_start) : null;
      const compareEnd = isIsoDate(req.query.compare_end) ? String(req.query.compare_end) : null;

      return res.json(
        await pnlService.getSummary({
          brandKey: req.brandKey,
          start,
          end,
          granularity,
          channel,
          productId,
          compareStart: compareStart && compareEnd ? compareStart : null,
          compareEnd: compareStart && compareEnd ? compareEnd : null,
          conn: req.brandDb?.sequelize,
        }),
      );
    } catch (error) {
      return handleControllerError(res, error, "pnl-summary failed");
    }
  },

  async series(req, res) {
    try {
      const granularity = req.query.granularity === "monthly" ? "monthly" : "daily";
      const end = isIsoDate(req.query.end) ? String(req.query.end) : todayIsoDate();
      const start = isIsoDate(req.query.start) ? String(req.query.start) : currentMonthStartIsoDate();
      if (start > end) {
        return res.status(400).json({ error: "start must be on or before end" });
      }

      return res.json(
        await pnlService.getSeries({
          brandKey: req.brandKey,
          start,
          end,
          granularity,
          conn: req.brandDb?.sequelize,
        }),
      );
    } catch (error) {
      return handleControllerError(res, error, "pnl-series failed");
    }
  },
};

module.exports = pnlController;
