const { handleControllerError } = require("../shared/middleware/handleControllerError");
const pnlProductConfigService = require("../services/pnlProductConfig.service");

const pnlProductConfigController = {
  // GET /pnl/product-config -> the brand's saved per-product cogs, for a
  // status summary next to the download/upload controls.
  async get(req, res) {
    try {
      const config = await pnlProductConfigService.getProductConfig(req.brandKey);
      return res.json({ config });
    } catch (error) {
      return handleControllerError(res, error, "pnl-product-config-get failed");
    }
  },

  // GET /pnl/product-config/template -> CSV of this brand's products
  // (product_id, title, any cogs already saved) to fill in and re-upload.
  async downloadTemplate(req, res) {
    try {
      const result = await pnlProductConfigService.downloadTemplate({
        brandKey: req.brandKey,
        conn: req.brandDb?.sequelize,
      });
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
      return res.send(result.csv);
    } catch (error) {
      return handleControllerError(res, error, "pnl-product-config-template failed");
    }
  },

  // POST /pnl/product-config/upload -> parses the filled-in template,
  // replaces the brand's product_config document, and rolls the sum of every
  // product's cogs into total_config.costs.cogs.
  async upload(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "CSV file is required (field name: file)." });
      }
      const result = await pnlProductConfigService.uploadCogs({
        brandKey: req.brandKey,
        csvText: req.file.buffer.toString("utf8"),
        updatedByEmail: req.user?.email || null,
      });
      if (!result.success && (!result.results || result.results.length === 0)) {
        return res.status(400).json({ error: result.error });
      }
      return res.json(result);
    } catch (error) {
      return handleControllerError(res, error, "pnl-product-config-upload failed");
    }
  },
};

module.exports = pnlProductConfigController;
