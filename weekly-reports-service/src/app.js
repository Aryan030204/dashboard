const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { buildAuthMiddleware } = require("./middleware/auth");
const { buildWeeklyReportsRouter } = require("./routes/weeklyReports");
const { HttpError } = require("./errors");

// Dependencies (repo, storage, audit) are injected so tests can run the real routes without
// MySQL or S3.
function buildApp({ config, repo, storage, audit }) {
  const router = buildWeeklyReportsRouter({ config, repo, storage, audit });

  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins.length ? config.corsOrigins : true,
      credentials: true,
    }),
  );

  app.get("/health", (_req, res) => res.json({ ok: true, service: "weekly-reports" }));
  app.get("/health/monitor", (_req, res) => res.json({ ok: true, service: "weekly-reports-service", message: "probe_ok" }));

  // Upload bodies are multipart (handled by multer in the router); JSON bodies stay small.
  app.use(express.json({ limit: "100kb" }));
  app.use("/weekly-reports", buildAuthMiddleware(config), router);

  app.use((err, _req, res, _next) => {
    if (err && err.name === "ZodError") {
      const first = err.issues && err.issues[0];
      return res.status(400).json({ error: (first && first.message) || "Invalid request.", code: "VALIDATION_ERROR" });
    }
    // HttpError messages are written for users and are safe to return; anything else is not.
    if (err instanceof HttpError) {
      if (err.status >= 500) console.error("[weekly-reports] route error", err.code, err.message);
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error("[weekly-reports] unexpected error", err);
    // Never leak internals (paths, SQL, converter output) to the caller.
    return res.status(500).json({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });

  return app;
}

module.exports = { buildApp };
