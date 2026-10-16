const express = require('express');
const {
  requirePermission,
  requireTrustedPrincipal,
  requireTrustedAuthor,
} = require('../../shared/middleware/identityEdge');
const { brandContext, authorizeBrandContext } = require('../../shared/middleware/brandContext');
const { createApiKeyAuthMiddleware } = require('../../shared/middleware/apiKeyAuth');
const { responseTime } = require('../../shared/middleware/responseTime');
const { createAuthOrApiKeyMiddleware } = require('../../shared/middleware/authOrApiKey');
const {
  buildMetricsSnapshotService,
} = require('../../services/metricsSnapshotService');
const {
  buildMetricsReportService,
} = require('../../services/metricsReportService');
const {
  buildMetricsCacheService,
} = require('../../services/metricsCacheService');
const {
  buildMetricsPageService,
} = require('../../services/metricsPageService');
const {
  buildOverallSnapshotService,
} = require('../../services/overallSnapshotService');
const { buildTrendController } = require('./trendController');
const { buildSplitController } = require('./splitController');
const { buildSummaryController } = require('./summaryController');
const { buildProductController } = require('./productController');
const { buildIntentFunnelController } = require('./intentFunnelController');
const { buildIntentFunnelService } = require('../../services/intentFunnelService');

function buildMetricsRouter(sequelize) {
  const router = express.Router();
  router.use(responseTime);

  const cacheService = buildMetricsCacheService();
  const metricsService = buildMetricsSnapshotService({
    fetchCachedMetricsBatch: cacheService.fetchCachedMetricsBatch,
    getDatePresetsCache: cacheService.getDatePresetsCache,
  });
  const reportService = buildMetricsReportService({
    getDatePresetsCache: cacheService.getDatePresetsCache,
  });
  const pageService = buildMetricsPageService({ cacheService });
  const overallSnapshotService = buildOverallSnapshotService({
    metricsService,
  });

  const trend = buildTrendController({ metricsService });
  const split = buildSplitController({ reportService });
  const summary = buildSummaryController({
    metricsService: {
      getDashboardSummary: metricsService.getDashboardSummary,
      getSummaryFilterOptions: metricsService.getSummaryFilterOptions,
      getOverallSnapshot: overallSnapshotService.getOverallSnapshot,
    },
  });
  const product = buildProductController({ pageService });
  const intentFunnel = buildIntentFunnelController({
    intentFunnelService: buildIntentFunnelService(),
  });

  const apiKeyAuth = createApiKeyAuthMiddleware(sequelize, ['metrics:read']);
  const protectedBrand = [requireTrustedPrincipal, brandContext];
  const authOrApiKey = createAuthOrApiKeyMiddleware(apiKeyAuth);
  const ensureBrandDb = (req, res, next) => brandContext(req, res, next);
  const hasValidatedTopPdpsSpeedKey = (req) => req.headers['x-speed-key-validated'] === 'true';
  const allowTopPdpsWithoutAuth = (req, res, next) => {
    if (hasValidatedTopPdpsSpeedKey(req)) return next();
    return authOrApiKey(req, res, next);
  };
  const ensureTopPdpsBrandDb = (req, res, next) => {
    if (hasValidatedTopPdpsSpeedKey(req) && !req.user && !req.apiKey) {
      req.user = {
        id: 'top-pdps-bypass',
        brandKey: (
          req.headers['x-brand-id'] ||
          req.query?.brand_key ||
          ''
        ).toString().trim().toUpperCase(),
        role: 'public',
        isAuthor: false,
        permissions: [],
      };
      req.isAuthenticated = () => true;
    }
    return brandContext(req, res, next);
  };

  router.get('/order-split', ...protectedBrand, split.orderSplit);
  router.get('/payment-sales-split', ...protectedBrand, split.paymentSalesSplit);
  router.get('/payment-split-summary', ...protectedBrand, split.paymentSplitSummary);
  router.get('/payment-split-trend', ...protectedBrand, split.paymentSplitTrend);
  router.get('/traffic-source-split', ...protectedBrand, split.trafficSourceSplit);
  router.get('/summary', requireTrustedPrincipal, authorizeBrandContext, summary.dashboardSummary);
  router.get('/data-restriction-config', requireTrustedPrincipal, summary.dataRestrictionConfig);
  router.get('/summary/brands', requireTrustedPrincipal, summary.dashboardSummaryBrands);
  router.get('/summary-filter-options', requireTrustedPrincipal, authorizeBrandContext, summary.summaryFilterOptions);
  router.get('/web-performance-summary', requireTrustedPrincipal, authorizeBrandContext, summary.webPerformanceSummary);
  router.get('/top-pdps', allowTopPdpsWithoutAuth, ensureTopPdpsBrandDb, product.topProductPages);
  router.get('/top-products', authOrApiKey, ensureBrandDb, product.topProducts);
  router.get('/product-kpis', authOrApiKey, ensureBrandDb, product.productKpis);
  router.get('/hourly-trend', ...protectedBrand, trend.hourlyTrend);
  router.get('/daily-trend', ...protectedBrand, trend.dailyTrend);
  router.get('/daily-funnel', requirePermission('daily_funnel_panel'), brandContext, trend.dailyFunnel);
  router.get('/intent-funnel', requirePermission('intent_funnel_panel'), brandContext, intentFunnel.getIntentFunnel);
  router.get('/monthly-trend', ...protectedBrand, trend.monthlyTrend);
  router.get('/hourly-product-sessions/export', requireTrustedAuthor, brandContext, product.hourlyProductSessionsExport);
  router.get('/product-types', authOrApiKey, ensureBrandDb, product.productTypes);
  router.get('/hourly-sales-compare', ...protectedBrand, split.hourlySalesCompare);
  router.get('/hourly-sales-summary', ...protectedBrand, product.hourlySalesSummary);
  router.get('/diagnose/total-orders', ...protectedBrand, summary.diagnoseTotalOrders(sequelize));

  return router;
}

module.exports = { buildMetricsRouter };
