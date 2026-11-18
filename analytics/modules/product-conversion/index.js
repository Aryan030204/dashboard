const express = require('express');
const { requirePermission, requireAnyPermission } = require('../../shared/middleware/identityEdge');
const { brandContext } = require('../../shared/middleware/brandContext');
const { buildProductConversionController } = require('./controller');

function buildProductConversionRouter() {
  const router = express.Router();
  const controller = buildProductConversionController();

  router.get('/product-conversion', requireAnyPermission(['product_conversion', 'inventory_panel']), brandContext, controller.productConversion);
  router.get('/product-conversion/oos-trend', requireAnyPermission(['product_conversion', 'inventory_panel']), brandContext, controller.oosTrend);
  router.get('/product-conversion/oos-trend/options', requireAnyPermission(['product_conversion', 'inventory_panel']), brandContext, controller.oosOptions);
  router.get('/product-conversion/export', requirePermission('product_conversion'), brandContext, controller.productConversionCsv);

  return router;
}

module.exports = { buildProductConversionRouter };
