const express = require("express");
const multer = require("multer");
const fs = require("fs");
const { z } = require("zod");
const { requirePermission, requireAuthor } = require("../middleware/auth");
const { httpError } = require("../errors");
const { validateUpload, extensionOf } = require("../services/uploadValidator");
const { buildSlideCache } = require("../services/slideCache");

// The single grantable scope. Holders (non-admins) can only preview PUBLISHED reports of their
// brand; everything else is role-gated to elevated users.
const VIEW_PERMISSION = "weekly_report_preview";
const CONTENT_TYPES = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
};

const createSchema = z.object({
  title: z.string().trim().min(1, "Report title is required.").max(200, "Report title is too long (200 characters max)."),
  reporting_week: z.string().trim().min(1, "Reporting week is required.").max(40, "Reporting week is too long (40 characters max)."),
});

// What a client may ever see: no storage keys, no error detail, no internal user ids, no history.
function clientDto(r) {
  return {
    id: Number(r.id),
    brand_key: r.brand_key,
    title: r.title,
    reporting_week: r.reporting_week,
    published_at: r.published_at,
    slide_count: r.slide_count,
  };
}

// What an elevated user sees. The source storage key is never returned to anyone.
function managerDto(r) {
  return {
    id: Number(r.id),
    brand_key: r.brand_key,
    title: r.title,
    reporting_week: r.reporting_week,
    version: Number(r.version),
    status: r.status,
    stage: r.stage || null,
    source_type: r.source_type,
    source_size_bytes: r.source_size_bytes === null ? null : Number(r.source_size_bytes),
    slide_count: r.slide_count,
    slides_total: r.slides_total === null || r.slides_total === undefined ? null : Number(r.slides_total),
    slides_done: r.slides_done === null || r.slides_done === undefined ? null : Number(r.slides_done),
    error_code: r.error_code,
    error_detail: r.error_detail,
    uploaded_by: r.uploaded_by,
    published_by: r.published_by,
    uploaded_at: r.uploaded_at,
    published_at: r.published_at,
    created_at: r.created_at,
  };
}

function parseId(raw) {
  if (!/^\d{1,18}$/.test(String(raw))) throw httpError(400, "INVALID_ID", "Invalid report id.");
  return Number(raw);
}

// The brand is whatever the gateway signed (x-brand-id). Any other brand supplied by the client
// (query, body) must agree with it; it is never used to choose a brand (PRD SEC-2).
function assertBrandInputsAgree(req) {
  const signed = req.principal.brand_key;
  const candidates = [
    req.query && req.query.brand_key,
    req.query && req.query.brand_id,
    req.body && req.body.brand_key,
    req.body && req.body.brand_id,
    req.body && req.body.brandKey,
  ];
  for (const value of candidates) {
    if (value === undefined || value === null || value === "") continue;
    if (String(value).toUpperCase() !== signed) {
      throw httpError(400, "BRAND_MISMATCH", "The brand in the request does not match the current brand.");
    }
  }
}

function buildWeeklyReportsRouter({ config, repo, storage, audit }) {
  const router = express.Router();
  const slideCache = buildSlideCache(config.slideCacheMax);
  const A = audit.ACTIONS;

  const brandGuard = (req, _res, next) => {
    try {
      assertBrandInputsAgree(req);
      next();
    } catch (err) {
      next(err);
    }
  };

  // Loads a report and authorizes it against the signed brand. This is the single place where
  // "report id -> is this caller allowed to see it" is decided (PRD SEC-3, section 21).
  async function loadAuthorizedReport(req) {
    const id = parseId(req.params.id);
    const { brand_key: brand, isAuthor, user_id: userId } = req.principal;
    const report = await repo.findById(id);
    if (!report) throw httpError(404, "NOT_FOUND", "Report not found.");
    if (report.brand_key !== brand) {
      await audit.record({
        brandKey: brand, reportId: id, userId, action: A.ACCESS_DENIED,
        metadata: { reason: "cross_brand", request_brand: brand, report_brand: report.brand_key },
      });
      if (config.crossBrandStatus === 404) throw httpError(404, "NOT_FOUND", "Report not found.");
      throw httpError(403, "FORBIDDEN", "Forbidden");
    }
    // Clients only ever reach the live report. Everything else looks like it does not exist.
    if (!isAuthor && report.status !== "PUBLISHED") throw httpError(404, "NOT_FOUND", "Report not found.");
    return report;
  }

  // ---- uploads ---------------------------------------------------------------------------------
  const uploader = multer({
    dest: config.uploadTmpDir,
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 8 },
    fileFilter(_req, file, cb) {
      if (!extensionOf(file.originalname)) {
        return cb(httpError(415, "UNSUPPORTED_FILE_TYPE", "Only .pptx or .ppt files are supported."));
      }
      return cb(null, true);
    },
  }).single("file");

  const uploadMiddleware = (req, res, next) => {
    uploader(req, res, (err) => {
      if (!err) return next();
      if (err.code === "LIMIT_FILE_SIZE") {
        const mb = Math.round(config.maxUploadBytes / (1024 * 1024));
        return next(httpError(413, "FILE_TOO_LARGE", `File is larger than ${mb} MB.`));
      }
      if (err.code === "LIMIT_UNEXPECTED_FILE") return next(httpError(400, "INVALID_UPLOAD", "Upload one file in the 'file' field."));
      return next(err);
    });
  };

  // ---- view (client + elevated) -------------------------------------------------------------
  router.get("/:id/slides/:n", requirePermission(VIEW_PERMISSION), brandGuard, async (req, res, next) => {
    try {
      const report = await loadAuthorizedReport(req);
      const n = Number(req.params.n);
      if (!Number.isInteger(n) || n < 1 || !report.slide_count || n > report.slide_count) {
        throw httpError(404, "SLIDE_NOT_FOUND", "Slide not found.");
      }
      const slide = await repo.getSlide(report.id, n);
      if (!slide) throw httpError(404, "SLIDE_NOT_FOUND", "Slide not found.");

      const thumb = req.query.size === "thumb";
      const cacheKey = `${report.id}:${n}:${thumb ? "t" : "f"}`;

      let body = slideCache.get(cacheKey);
      if (!body) {
        try {
          body = await storage.getBuffer(thumb ? slide.thumbnail_storage_key : slide.image_storage_key);
        } catch (err) {
          if (err && (err.name === "NoSuchKey" || err.Code === "NoSuchKey")) {
            throw httpError(404, "SLIDE_NOT_FOUND", "Slide not found.");
          }
          throw httpError(503, "STORAGE_UNAVAILABLE", "Report is temporarily unavailable.");
        }
        slideCache.set(cacheKey, body);
      }

      res.set({
        "Content-Type": "image/webp",
        "Content-Disposition": "inline",
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      });
      res.send(body);
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", requirePermission(VIEW_PERMISSION), brandGuard, async (req, res, next) => {
    try {
      const report = await loadAuthorizedReport(req);
      res.json(req.principal.isAuthor ? managerDto(report) : clientDto(report));
    } catch (err) {
      next(err);
    }
  });

  // ---- manage (elevated roles only) -------------------------------------------------------------
  // The brand's reports. Elevated users see all of them (any status, with progress); everyone else
  // with the preview permission sees only the PUBLISHED ones, with no internal fields.
  router.get("/", requirePermission(VIEW_PERMISSION), brandGuard, async (req, res, next) => {
    try {
      const { brand_key: brand, isAuthor } = req.principal;
      const rows = await repo.listByBrand(brand, { publishedOnly: !isAuthor });
      res.json({ reports: rows.map(isAuthor ? managerDto : clientDto) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", requireAuthor, brandGuard, uploadMiddleware, async (req, res, next) => {
    const file = req.file;
    try {
      assertBrandInputsAgree(req); // body fields exist only after multer parsed them
      if (!file) throw httpError(400, "FILE_REQUIRED", "Choose a .pptx or .ppt file to upload.");
      const fields = createSchema.parse({ title: req.body.title, reporting_week: req.body.reporting_week });
      const { brand_key: brand, user_id: userId } = req.principal;

      const info = await validateUpload(
        { filePath: file.path, originalName: file.originalname, sizeBytes: file.size },
        config,
      );

      const { id, version } = await repo.createReport({
        brandKey: brand,
        title: fields.title,
        reportingWeek: fields.reporting_week,
        sourceType: info.ext,
        uploadedBy: userId,
      });

      try {
        const sourceKey = storage.sourceKey(brand, id, info.ext);
        await storage.putFile(sourceKey, file.path, CONTENT_TYPES[info.ext]);
        await repo.releaseForProcessing(id, brand, { sourceKey, sizeBytes: info.sizeBytes, sha256: info.sha256 });
      } catch (err) {
        console.error("[weekly-reports] source upload failed", id, err && err.message);
        await repo.markFailed(id, "UPLOAD_FAILED", "The source file could not be stored.");
        throw httpError(503, "STORAGE_UNAVAILABLE", "Report is temporarily unavailable. Try again.");
      }

      await audit.record({ brandKey: brand, reportId: id, userId, action: A.UPLOADED, metadata: { version, size: info.sizeBytes } });
      if (version > 1) {
        await audit.record({ brandKey: brand, reportId: id, userId, action: A.VERSION_CREATED, metadata: { version, reporting_week: fields.reporting_week } });
      }

      const created = await repo.findById(id);
      res.status(202).json(managerDto(created));
    } catch (err) {
      next(err);
    } finally {
      if (file && file.path) fs.unlink(file.path, () => {});
    }
  });

  router.post("/:id/publish", requireAuthor, brandGuard, async (req, res, next) => {
    try {
      const report = await loadAuthorizedReport(req);
      const { brand_key: brand, user_id: userId } = req.principal;
      await repo.publish(report.id, brand, userId);
      await audit.record({ brandKey: brand, reportId: report.id, userId, action: A.PUBLISHED, metadata: { version: report.version } });
      res.json(managerDto(await repo.findById(report.id)));
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/unpublish", requireAuthor, brandGuard, async (req, res, next) => {
    try {
      const report = await loadAuthorizedReport(req);
      const { brand_key: brand, user_id: userId } = req.principal;
      await repo.unpublish(report.id, brand);
      await audit.record({ brandKey: brand, reportId: report.id, userId, action: A.UNPUBLISHED, metadata: { reason: "manual" } });
      res.json(managerDto(await repo.findById(report.id)));
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", requireAuthor, brandGuard, async (req, res, next) => {
    try {
      const report = await loadAuthorizedReport(req);
      const { brand_key: brand, user_id: userId } = req.principal;
      await repo.softDelete(report.id, brand);
      await audit.record({ brandKey: brand, reportId: report.id, userId, action: A.DELETED, metadata: { version: report.version } });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildWeeklyReportsRouter, clientDto, managerDto };
