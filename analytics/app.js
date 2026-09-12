if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "production";
}

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const logger = require("./shared/utils/logger");
const {
  initObservability,
  sentryErrorMiddleware,
  captureError,
} = require("./observability");
const { connectMongo } = require("./shared/db/mongo");
const { sequelize } = require("./shared/db/mainSequelize");
const { buildMetricsRouter } = require("./modules/metrics");
const { buildProductConversionRouter } = require("./modules/product-conversion");
const { buildBundlesRouter } = require("./modules/bundles");
const { buildExternalRouter } = require("./modules/external");
const { buildUploadsRouter } = require("./modules/uploads");
const { buildApiKeysRouter } = require("./modules/api-keys");
const { buildShopifyRouter } = require("./modules/shopify");
const { buildNotificationsRouter } = require("./modules/notifications");
const { buildDashboardRouter } = require("./modules/dashboard");
const { buildSessionAnalyticsRouter } = require("./routes/sessionAnalytics.routes");
const { buildWebVitalsRouter } = require("./routes/webVitals.routes");
const { buildPnlRouter } = require("./routes/pnl.routes");
const {
  collectRoutes,
  createHealthMonitorReporter,
  registerWithHealthMonitor,
} = require("./healthMonitor");

const app = express();
app.set("trust proxy", 1);
app.use(helmet());
initObservability(app);

app.get("/health", (_req, res) => res.json({ ok: true, service: "analytics" }));
app.get("/health/monitor", (_req, res) =>
  res.json({ ok: true, service: "analytics-service", message: "probe_ok" }));

const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (!allowedOrigins.length || allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: "60mb" }));
app.use(createHealthMonitorReporter({
  serviceName: "analytics-service",
  baseUrl: "http://analytics-service:3006",
  logger,
}));

app.get("/", (_req, res) => {
  res.json({ message: "datum backend is running" });
});

const metricsRouter = buildMetricsRouter(sequelize);
const productConversionRouter = buildProductConversionRouter();
const bundlesRouter = buildBundlesRouter();
const dashboardRouter = buildDashboardRouter();
const sessionAnalyticsRouter = buildSessionAnalyticsRouter();
const webVitalsRouter = buildWebVitalsRouter();
const pnlRouter = buildPnlRouter();
const externalRouter = buildExternalRouter();
const uploadsRouter = buildUploadsRouter();
const apiKeysRouter = buildApiKeysRouter(sequelize);
const shopifyRouter = buildShopifyRouter(sequelize);
const notificationsRouter = buildNotificationsRouter();


app.use("/metrics", metricsRouter);
app.use("/metrics", productConversionRouter);
app.use("/metrics", bundlesRouter);
app.use("/dashboard", dashboardRouter);
app.use("/session-analytics", sessionAnalyticsRouter);
app.use("/web-vitals", webVitalsRouter);
app.use("/pnl", pnlRouter);
app.use("/external", externalRouter);
app.use("/", uploadsRouter);
app.use("/", apiKeysRouter);
app.use("/shopify", shopifyRouter);
app.use("/notifications", notificationsRouter);
app.use(sentryErrorMiddleware);
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error("[analytics] unhandled route error", err);
  return res.status(500).json({ error: "Internal Server Error" });
});

async function init() {
  await sequelize.authenticate();
  await connectMongo();
  try {
    await sequelize.models.api_keys.sync();
  } catch (err) {
    logger.warn("API keys sync skipped", { error: err?.message || String(err) });
  }

  const port = process.env.PORT || 3000;
  const { initSocket } = require('./utils/socket');
  
  const server = app.listen(port, () => {
    logger.info(`Metrics API running on :${port}`);
    require("./config/brands")
      .fetchBrandIds()
      .catch((err) => {
        captureError(err, null, { type: "startup_brand_ids" });
        logger.warn("Failed to load dynamic brand IDs on startup", {
          error: err.message,
        });
      });
    registerWithHealthMonitor({
      serviceName: "analytics-service",
      baseUrl: "http://analytics-service:3006",
      healthEndpoint: "/health",
      dependencies: ["mongo", "mysql", "redis"],
      endpoints: [
        { path: "/health", method: "GET", critical: true, intervalSeconds: 3600, successStatusFamily: "2xx" },
        { path: "/health/monitor", method: "GET", critical: true, intervalSeconds: 3600, successStatusFamily: "2xx" },
      ],
      discoveredRoutes: [
        ...collectRoutes(app, { sourceModule: "app.js" }),
        ...collectRoutes(metricsRouter, { mountPath: "/metrics", sourceModule: "modules/metrics/index.js" }),
        ...collectRoutes(productConversionRouter, { mountPath: "/metrics", sourceModule: "modules/product-conversion/index.js" }),
        ...collectRoutes(bundlesRouter, { mountPath: "/metrics", sourceModule: "modules/bundles/index.js" }),
        ...collectRoutes(dashboardRouter, { mountPath: "/dashboard", sourceModule: "modules/dashboard/index.js" }),
        ...collectRoutes(sessionAnalyticsRouter, { mountPath: "/session-analytics", sourceModule: "routes/sessionAnalytics.routes.js" }),
        ...collectRoutes(webVitalsRouter, { mountPath: "/web-vitals", sourceModule: "routes/webVitals.routes.js" }),
        ...collectRoutes(pnlRouter, { mountPath: "/pnl", sourceModule: "routes/pnl.routes.js" }),
        ...collectRoutes(externalRouter, { mountPath: "/external", sourceModule: "modules/external/index.js" }),
        ...collectRoutes(uploadsRouter, { mountPath: "/", sourceModule: "modules/uploads/index.js" }),
        ...collectRoutes(apiKeysRouter, { mountPath: "/", sourceModule: "modules/api-keys/index.js" }),
        ...collectRoutes(shopifyRouter, { mountPath: "/shopify", sourceModule: "modules/shopify/index.js" }),
        ...collectRoutes(notificationsRouter, { mountPath: "/notifications", sourceModule: "modules/notifications/index.js" }),
      ],
    }, logger);
  });

  return server;
}

module.exports = {
  app,
  init,
  sequelize,
};
