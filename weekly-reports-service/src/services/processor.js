const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const { convertToPageImages } = require("./converter");

// Turns one claimed report into slide images in the private bucket and flips it to READY.
// Everything that can fail ends in FAILED with a short, user-safe reason. Raw converter output
// is never stored or returned.
//
// Cancellation: while a job runs, a watcher checks every few seconds whether an admin cancelled or
// deleted the report. If so, the running conversion is killed, no more files are written, the
// worker lets go of the report (so its files can be purged) and the job ends as "cancelled", never
// as FAILED. The cleanup sweep then removes whatever reached S3.
function buildProcessor({ config, repo, storage, audit, convert = convertToPageImages, logger = console }) {
  async function toWebp(pngPath) {
    const full = await sharp(pngPath).resize({ width: config.slideWidth, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
    const thumb = await sharp(pngPath).resize({ width: config.thumbWidth, withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
    return { full: full.data, width: full.info.width, height: full.info.height, thumb };
  }

  function classify(err) {
    const code = err && err.code && typeof err.code === "string" && err.status ? err.code : "PROCESSING_ERROR";
    const known = ["CONVERSION_FAILED", "PROCESSING_TIMEOUT", "TOO_MANY_SLIDES", "CONVERTER_MISSING"];
    if (known.includes(code)) return { code, detail: err.message };
    return { code: "PROCESSING_ERROR", detail: "Something went wrong while processing this file." };
  }

  async function process(job) {
    const started = Date.now();
    const workDir = fs.mkdtempSync(path.join(config.uploadTmpDir || os.tmpdir(), `wr-${job.id}-`));
    const controller = new AbortController();
    const { signal } = controller;

    const watcher = setInterval(async () => {
      try {
        if (await repo.isDeleted(job.id)) controller.abort();
      } catch (_) {
        /* a failed check is retried on the next tick */
      }
    }, config.cancelPollMs || 2000);

    const cancelled = () => Object.assign(new Error("cancelled"), { code: "ABORTED" });
    const checkCancelled = () => {
      if (signal.aborted) throw cancelled();
    };

    try {
      const sourcePath = path.join(workDir, `source.${job.sourceType}`);
      await storage.downloadToFile(job.sourceKey, sourcePath);
      checkCancelled();

      const pages = await convert({ sourcePath, workDir, config, signal });
      checkCancelled();

      // The page count is known now: from here the UI can show "7 of 15, 8 remaining".
      await repo.setProgress(job.id, { stage: "SAVING_SLIDES", slidesTotal: pages.length, slidesDone: 0 });

      const slides = [];
      for (let i = 0; i < pages.length; i += 1) {
        checkCancelled(); // stop before writing anything more to S3
        const n = i + 1;
        const img = await toWebp(pages[i]);
        const imageKey = storage.slideKey(job.brandKey, job.id, n);
        const thumbKey = storage.thumbKey(job.brandKey, job.id, n);
        await storage.putBuffer(imageKey, img.full, "image/webp");
        await storage.putBuffer(thumbKey, img.thumb, "image/webp");
        slides.push({ number: n, imageKey, thumbKey, width: img.width, height: img.height });
        await repo.setProgress(job.id, { stage: "SAVING_SLIDES", slidesTotal: pages.length, slidesDone: n });
      }

      // The report may have been cancelled or deleted right at the end.
      if (await repo.isDeleted(job.id)) throw cancelled();

      await repo.complete(job.id, slides);
      await audit.record({
        brandKey: job.brandKey, reportId: job.id, action: audit.ACTIONS.PROCESSED,
        metadata: { slides: slides.length, ms: Date.now() - started },
      });
      return { slides: slides.length };
    } catch (err) {
      if (signal.aborted || (err && err.code === "ABORTED")) {
        logger.warn("[weekly-reports] job cancelled, stopped without finishing", job.id);
        // Free the report so the cleanup sweep can delete the source and any slides already written.
        await repo.releaseLock(job.id);
        return { cancelled: true };
      }
      const { code, detail } = classify(err);
      logger.error("[weekly-reports] processing failed", job.id, code, err && err.message);
      await repo.markFailed(job.id, code, detail);
      await audit.record({ brandKey: job.brandKey, reportId: job.id, action: audit.ACTIONS.PROCESSING_FAILED, metadata: { code } });
      return { failed: code };
    } finally {
      clearInterval(watcher);
      fs.rm(workDir, { recursive: true, force: true }, () => {});
    }
  }

  return { process, classify };
}

module.exports = { buildProcessor };
