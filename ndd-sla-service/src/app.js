const express = require("express");
const helmet = require("helmet");
const { buildAuthMiddleware } = require("./middleware/auth");
const { buildNddSlaRouter } = require("./routes/nddSla");
const { HttpError } = require("./errors");
const { buildUploadService } = require("./services/upload");
const { ensureLogger } = require("./logger");

// repo is injected so tests run the real routes without MySQL.
// pipeline is only needed for manual upload (the API never calls Gmail or EasyCom).
function buildApp({ config, repo, logger, pipeline = null, now }) {
  const log = ensureLogger(logger, "api");
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());

  const uploads = pipeline && config.uploadEnabled ? buildUploadService({ config, repo, pipeline, logger: log.child("upload"), now }) : null;

  app.get("/health", (_req, res) => res.json({ ok: true, service: "ndd-sla" }));
  app.get("/health/monitor", (_req, res) => res.json({ ok: true, service: "ndd-sla-service", message: "probe_ok" }));

  app.use("/ndd-sla", buildAuthMiddleware(config), buildNddSlaRouter({ repo, config, uploads }));

  app.use((err, req, res, _next) => {
    if (err && err.name === "ZodError") {
      const first = err.issues && err.issues[0];
      return res.status(400).json({ error: (first && first.message) || "Invalid request.", code: "VALIDATION_ERROR" });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    log.error("unexpected error", { method: req.method, path: req.path, error: err });
    return res.status(500).json({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });
  return app;
}

module.exports = { buildApp };
