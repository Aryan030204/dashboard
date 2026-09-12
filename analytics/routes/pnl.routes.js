const express = require("express");
const { requirePermission } = require("../shared/middleware/identityEdge");
const { brandContext } = require("../shared/middleware/brandContext");
const pnlController = require("../controllers/pnl.controller");

function buildPnlRouter() {
  const router = express.Router();

  router.use(requirePermission("pnl_panel"));

  router.get("/summary", brandContext, pnlController.summary);

  return router;
}

module.exports = {
  buildPnlRouter,
};
