const { handleControllerError } = require("../shared/middleware/handleControllerError");
const pnlCostConfigService = require("../services/pnlCostConfig.service");

const pnlCostConfigController = {
  // GET /pnl/cost-configs -> the brand's single total_config document
  async get(req, res) {
    try {
      const config = await pnlCostConfigService.getTotalConfig(req.brandKey);
      return res.json({ config });
    } catch (error) {
      return handleControllerError(res, error, "pnl-cost-configs-get failed");
    }
  },

  // PUT /pnl/cost-configs  body: { gst_pct?, costs?: { field: {value, value_type} | null }, notes? }
  async save(req, res) {
    try {
      const config = await pnlCostConfigService.saveTotalConfig({
        brandKey: req.brandKey,
        gstPct: req.body?.gst_pct,
        costs: req.body?.costs,
        notes: req.body?.notes,
        updatedByEmail: req.user?.email || null,
      });
      return res.json({ config });
    } catch (error) {
      return handleControllerError(res, error, "pnl-cost-configs-save failed");
    }
  },

  // PUT /pnl/cost-configs/:field  body: { value, value_type }
  async upsertField(req, res) {
    try {
      const config = await pnlCostConfigService.upsertCostLine({
        brandKey: req.brandKey,
        field: String(req.params.field || "").trim(),
        value: req.body?.value,
        valueType: req.body?.value_type ? String(req.body.value_type).trim() : "flat",
        updatedByEmail: req.user?.email || null,
      });
      return res.json({ config });
    } catch (error) {
      return handleControllerError(res, error, "pnl-cost-configs-upsert failed");
    }
  },

  // DELETE /pnl/cost-configs/:field -> clears that one line (document stays)
  async clearField(req, res) {
    try {
      const config = await pnlCostConfigService.clearCostLine({
        brandKey: req.brandKey,
        field: String(req.params.field || "").trim(),
        updatedByEmail: req.user?.email || null,
      });
      return res.json({ config });
    } catch (error) {
      return handleControllerError(res, error, "pnl-cost-configs-clear failed");
    }
  },
};

module.exports = pnlCostConfigController;
