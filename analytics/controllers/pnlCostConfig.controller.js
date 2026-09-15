const { handleControllerError } = require("../shared/middleware/handleControllerError");
const pnlCostConfigService = require("../services/pnlCostConfig.service");

const pnlCostConfigController = {
  async list(req, res) {
    try {
      const configs = await pnlCostConfigService.listCurrentConfigs(req.brandKey);
      return res.json({ configs });
    } catch (error) {
      return handleControllerError(res, error, "pnl-cost-configs-list failed");
    }
  },

  async upsert(req, res) {
    try {
      const category = String(req.params.category || "").trim();
      const valueType = req.body?.value_type ? String(req.body.value_type).trim() : "flat";
      const frequency = req.body?.frequency ? String(req.body.frequency).trim() : "recurring";
      const notes = req.body?.notes ? String(req.body.notes).trim() : null;

      const result = await pnlCostConfigService.upsertConfig({
        brandKey: req.brandKey,
        category,
        value: req.body?.value,
        valueType,
        frequency,
        notes,
        updatedByEmail: req.user?.email || null,
      });

      return res.json(result);
    } catch (error) {
      return handleControllerError(res, error, "pnl-cost-configs-upsert failed");
    }
  },

  async clear(req, res) {
    try {
      const category = String(req.params.category || "").trim();
      const result = await pnlCostConfigService.clearConfig({
        brandKey: req.brandKey,
        category,
        updatedByEmail: req.user?.email || null,
      });
      return res.json(result);
    } catch (error) {
      return handleControllerError(res, error, "pnl-cost-configs-clear failed");
    }
  },
};

module.exports = pnlCostConfigController;
