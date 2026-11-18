const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { buildAuthMiddleware } = require("./middleware/auth");
const { buildWeeklyReportsRouter } = require("./routes/weeklyReports");
const { HttpError } = require("./errors");
const crypto = require("crypto");
const { ensureLogger } = require("./logger");

// Dependencies (repo, storage, audit) are injected so tests can run the real routes without
// MySQL or S3.
function buildApp({ config, repo, storage, audit, sessions, logger }) {
  const log = ensureLogger(logger, "api");
  const router = buildWeeklyReportsRouter({ config, repo, storage, audit, sessions, logger: log.child("routes") });

  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins.length ? config.corsOrigins : true,
      credentials: true,
    }),
  );

  // One line per request when it finishes: who (brand + user, never headers or the signature), what, how it
  // ended and how long it took. The request id is also written by every other line of the same request, so
  // `grep <id>` shows the whole story. Health probes are skipped: they run every few seconds.
  app.use((req, res, next) => {
    if (req.path.startsWith("/health")) return next();
    const started = Date.now();
    req.reqId = crypto.randomBytes(4).toString("hex");
    res.setHeader("X-Request-Id", req.reqId);
    res.on("finish", () => {
      const status = res.statusCode;
      const write = status >= 500 ? log.error : status >= 400 ? log.warn : log.info;
      write(`${req.method} ${req.baseUrl || ""}${req.path} ${status}`, {
        req: req.reqId,
        ms: Date.now() - started,
        brand: req.principal && req.principal.brand_key,
        user: req.principal && req.principal.user_id,
        in: Number(req.headers["content-length"]) || 0,
        out: Number(res.getHeader("content-length")) || undefined,
      });
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        log.warn(`${req.method} ${req.baseUrl || ""}${req.path} connection closed before the response was sent`, {
          req: req.reqId, ms: Date.now() - started, brand: req.principal && req.principal.brand_key,
        });
      }
    });
    return next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true, service: "weekly-reports" }));
  app.get("/health/monitor", (_req, res) => res.json({ ok: true, service: "weekly-reports-service", message: "probe_ok" }));

  // Upload bodies are multipart (handled by multer in the router); JSON bodies stay small.
  app.use(express.json({ limit: "100kb" }));
  app.use("/weekly-reports", buildAuthMiddleware(config), router);

  app.use((err, req, res, _next) => {
    // Why a request failed, with who asked, before the answer is sent. The user only ever sees the safe message.
    const who = { req: req.reqId, brand: req.principal && req.principal.brand_key, user: req.principal && req.principal.user_id };
    // Errors raised by the body parsers. Without these they would fall through to the generic 500.
    if (err && err.type === "entity.too.large") {
      log.warn("request body too large", { ...who, limit: err.limit, length: err.length });
      return res.status(413).json({ error: "The request is too large.", code: "PAYLOAD_TOO_LARGE" });
    }
    if (err && err.type === "entity.parse.failed") {
      log.warn("request body is not valid JSON", { ...who, message: err.message });
      return res.status(400).json({ error: "The request body is not valid JSON.", code: "INVALID_JSON" });
    }
    if (err && (err.type === "request.aborted" || err.type === "request.size.invalid")) {
      log.warn("the client aborted the upload or sent a wrong size", { ...who, type: err.type, expected: err.expected, received: err.received });
      return res.status(400).json({ error: "The upload was interrupted. Try again.", code: "UPLOAD_INTERRUPTED" });
    }
    if (err && err.name === "ZodError") {
      const first = err.issues && err.issues[0];
      log.warn("validation failed", { ...who, field: first && first.path && first.path.join("."), reason: first && first.message });
      return res.status(400).json({ error: (first && first.message) || "Invalid request.", code: "VALIDATION_ERROR" });
    }
    // HttpError messages are written for users and are safe to return; anything else is not.
    if (err instanceof HttpError) {
      const write = err.status >= 500 ? log.error : log.warn;
      write("request refused", { ...who, status: err.status, code: err.code, message: err.message, ...(err.status >= 500 ? { error: err } : {}) });
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    log.error("unexpected error (the client gets a generic 500)", { ...who, method: req.method, path: req.path, error: err });
    // Never leak internals (paths, SQL, converter output) to the caller.
    return res.status(500).json({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });

  return app;
}

module.exports = { buildApp };
