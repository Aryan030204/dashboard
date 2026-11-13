const express = require("express");
const { z } = require("zod");
const { requirePermission, requireIntegrationManage } = require("../middleware/auth");
const { brandGuard } = require("../middleware/brandGuard");
const { httpError } = require("../errors");
const { ensureLogger } = require("../logger");

// Meeting Pointers (Phase 1: backend only). Mounted at /meeting-pointers behind the gateway-signed auth middleware.
//   GET  /integrations/fireflies   POST /integrations/fireflies   (Fireflies key: admin / meeting_integration_manage)
//   POST /import                   GET  /imports/:id              (meeting_pointers_manage)
//   GET  /meetings/:id                                            (meeting_pointers_view)
// The Fireflies API key is accepted once (POST) and never returned, logged or echoed in any error.
const PERM_VIEW = "meeting_pointers_view";
const PERM_MANAGE = "meeting_pointers_manage";

// Error messages never echo the submitted value (it may be the API key).
const integrationSchema = z.object({
  api_key: z
    .string({ required_error: "The Fireflies API key is required.", invalid_type_error: "The Fireflies API key must be text." })
    .trim()
    .min(8, "The Fireflies API key looks too short.")
    .max(512, "The Fireflies API key is too long.")
    .regex(/^\S+$/, "The Fireflies API key must not contain spaces."),
  account_email: z
    .string({ invalid_type_error: "The account email must be text." })
    .trim()
    .max(320, "The account email is too long.")
    .email("Enter a valid account email.")
    .optional(),
});

const importSchema = z.object({
  fireflies_url: z
    .string({ required_error: "A Fireflies meeting link is required.", invalid_type_error: "The Fireflies link must be text." })
    .trim()
    .min(1, "A Fireflies meeting link is required.")
    .max(2048, "The Fireflies link is too long."),
  brand_key: z
    .string({ required_error: "The target brand is required.", invalid_type_error: "The brand must be text." })
    .trim()
    .min(1, "The target brand is required.")
    .max(32, "The brand is too long."),
});

function buildMeetingPointersRouter({ service, logger }) {
  const log = ensureLogger(logger, "meeting-routes");
  const router = express.Router();

  // Errors may carry extra safe fields (the id of the existing import or meeting for a duplicate).
  const fail = (res, next, err) => {
    if (err && err.details && err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code, ...err.details });
    }
    return next(err);
  };

  // ---- Fireflies connection -----------------------------------------------------------------
  router.get("/integrations/fireflies", requireIntegrationManage, brandGuard, async (_req, res, next) => {
    try {
      res.json(await service.getIntegration());
    } catch (err) {
      next(err);
    }
  });

  router.post("/integrations/fireflies", requireIntegrationManage, brandGuard, async (req, res, next) => {
    try {
      const body = integrationSchema.parse(req.body || {});
      const saved = await service.saveIntegration({ principal: req.principal, apiKey: body.api_key, accountEmail: body.account_email });
      res.json(saved); // configuration metadata only, never the key
    } catch (err) {
      next(err);
    }
  });

  // ---- import ---------------------------------------------------------------------------------
  router.post("/import", requirePermission(PERM_MANAGE), brandGuard, async (req, res, next) => {
    try {
      const raw = req.body || {};
      const body = importSchema.parse({
        fireflies_url: raw.fireflies_url ?? raw.firefliesUrl,
        brand_key: raw.brand_key ?? raw.brandKey ?? raw.brand_id,
      });
      log.info("import requested", { req: req.reqId, brand: req.principal.brand_key, user: req.principal.user_id });
      const queued = await service.requestImport({ principal: req.principal, brandKey: body.brand_key, firefliesUrl: body.fireflies_url });
      res.status(202).json(queued);
    } catch (err) {
      fail(res, next, err);
    }
  });

  router.get("/imports/:id", requirePermission(PERM_MANAGE), brandGuard, async (req, res, next) => {
    try {
      res.json(await service.getImport({ principal: req.principal, id: req.params.id }));
    } catch (err) {
      next(err);
    }
  });

  // ---- read -----------------------------------------------------------------------------------
  router.get("/meetings/:id", requirePermission(PERM_VIEW), brandGuard, async (req, res, next) => {
    try {
      res.json(await service.getMeeting({ principal: req.principal, id: req.params.id }));
    } catch (err) {
      next(err);
    }
  });

  // Anything else under /meeting-pointers is simply not there.
  router.use((_req, _res, next) => next(httpError(404, "NOT_FOUND", "Not found.")));

  return router;
}

module.exports = { buildMeetingPointersRouter, PERM_VIEW, PERM_MANAGE };
