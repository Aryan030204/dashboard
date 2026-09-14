const { handleControllerError } = require("../shared/middleware/handleControllerError");
const pnlProductCogsService = require("../services/pnlProductCogs.service");

const pnlProductCogsController = {
  async upload(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "CSV file is required (field name: file)." });
      }

      const result = await pnlProductCogsService.uploadCsv({
        conn: req.brandDb?.sequelize,
        csvText: req.file.buffer.toString("utf8"),
        uploadedByEmail: req.user?.email || null,
      });

      if (!result.success && result.results.length === 0) {
        return res.status(400).json({ error: result.error });
      }
      return res.json(result);
    } catch (error) {
      return handleControllerError(res, error, "pnl-product-cogs-upload failed");
    }
  },
};

module.exports = pnlProductCogsController;
