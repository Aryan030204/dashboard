const { handleControllerError } = require("../shared/middleware/handleControllerError");
const pnlService = require("../services/pnl.service");

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function currentMonthStartIsoDate() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

const pnlController = {
  async summary(req, res) {
    try {
      const granularity = req.query.granularity === "monthly" ? "monthly" : "daily";
      const end = req.query.end ? String(req.query.end) : todayIsoDate();
      const start = req.query.start ? String(req.query.start) : currentMonthStartIsoDate();
      const channel = req.query.sales_channel ? String(req.query.sales_channel) : null;
      const productId = req.query.product_id ? String(req.query.product_id) : null;

      return res.json(
        pnlService.getSummary({
          brandKey: req.brandKey,
          start,
          end,
          granularity,
          channel,
          productId,
        }),
      );
    } catch (error) {
      return handleControllerError(res, error, "pnl-summary failed");
    }
  },
};

module.exports = pnlController;
