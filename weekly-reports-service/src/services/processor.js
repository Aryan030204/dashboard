const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const { convertToPageImages } = require("./converter");
const { ensureLogger, stopwatch } = require("../logger");

// Turns one claimed report into slide images in the private bucket and flips it to READY.
// Everything that can fail ends in FAILED with a short, user-safe reason. Raw converter output
// is never stored or returned to a user, but it IS written to the worker log for whoever runs the service.
//
// Cancellation: while a job runs, a watcher checks every few seconds whether an admin cancelled or
// deleted the report. If so, the running conversion is killed, no more files are written, the
// worker lets go of the report (so its files can be purged) and the job ends as "cancelled", never
// as FAILED. The cleanup sweep then removes whatever reached S3.
function buildProcessor({ config, repo, storage, audit, convert = convertToPageImages, logger }) {
  const log = ensureLogger(logger, "worker.process");

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
    const total = stopwatch();
    const ctx = { report: job.id, brand: job.brandKey };
    const workDir = fs.mkdtempSync(path.join(config.uploadTmpDir || os.tmpdir(), `wr-${job.id}-`));
    const controller = new AbortController();
    const { signal } = controller;
    log.info("job started", { ...ctx, sourceType: job.sourceType, sourceKey: job.sourceKey, workDir });

    const watcher = setInterval(async () => {
      try {
        if (await repo.isDeleted(job.id)) {
          log.warn("the report was cancelled or deleted while processing, stopping the conversion", ctx);
          controller.abort();
        }
      } catch (err) {
        log.warn("cancel check failed, will retry", { ...ctx, error: err });
      }
    }, config.cancelPollMs || 2000);

    const cancelled = () => Object.assign(new Error("cancelled"), { code: "ABORTED" });
    const checkCancelled = () => {
      if (signal.aborted) throw cancelled();
    };

    let step = "download";
    try {
      const sourcePath = path.join(workDir, `source.${job.sourceType}`);
      let elapsed = stopwatch();
      log.info("step 1/4: downloading the source file from storage", { ...ctx, key: job.sourceKey });
      await storage.downloadToFile(job.sourceKey, sourcePath);
      log.info("source file downloaded", { ...ctx, bytes: fs.statSync(sourcePath).size, ms: elapsed() });
      checkCancelled();

      step = "convert";
      elapsed = stopwatch();
      log.info("step 2/4: converting to page images", ctx);
      const pages = await convert({ sourcePath, workDir, config, signal, logger: log.child("convert"), jobId: job.id });
      log.info("conversion done", { ...ctx, pages: pages.length, ms: elapsed() });
      checkCancelled();

      // The page count is known now: from here the UI can show "7 of 15, 8 remaining".
      step = "save slides";
      await repo.setProgress(job.id, { stage: "SAVING_SLIDES", slidesTotal: pages.length, slidesDone: 0 });
      log.info("step 3/4: encoding and storing slides", { ...ctx, slides: pages.length, slideWidth: config.slideWidth, thumbWidth: config.thumbWidth });

      const slides = [];
      let fullBytes = 0;
      for (let i = 0; i < pages.length; i += 1) {
        checkCancelled(); // stop before writing anything more to S3
        const n = i + 1;
        const slideTimer = stopwatch();
        const img = await toWebp(pages[i]);
        const imageKey = storage.slideKey(job.brandKey, job.id, n);
        const thumbKey = storage.thumbKey(job.brandKey, job.id, n);
        await storage.putBuffer(imageKey, img.full, "image/webp");
        await storage.putBuffer(thumbKey, img.thumb, "image/webp");
        slides.push({ number: n, imageKey, thumbKey, width: img.width, height: img.height });
        fullBytes += img.full.length;
        await repo.setProgress(job.id, { stage: "SAVING_SLIDES", slidesTotal: pages.length, slidesDone: n });
        log.info(`slide ${n}/${pages.length} stored`, { ...ctx, px: `${img.width}x${img.height}`, imageBytes: img.full.length, thumbBytes: img.thumb.length, ms: slideTimer() });
      }

      // The report may have been cancelled or deleted right at the end.
      step = "finish";
      if (await repo.isDeleted(job.id)) throw cancelled();

      log.info("step 4/4: marking the report READY", { ...ctx, slides: slides.length });
      await repo.complete(job.id, slides);
      await audit.record({
        brandKey: job.brandKey, reportId: job.id, action: audit.ACTIONS.PROCESSED,
        metadata: { slides: slides.length, ms: total() },
      });
      log.info("job finished", { ...ctx, slides: slides.length, imageBytesTotal: fullBytes, ms: total() });
      return { slides: slides.length };
    } catch (err) {
      if (signal.aborted || (err && err.code === "ABORTED")) {
        log.warn("job cancelled, stopped without finishing", { ...ctx, atStep: step, ms: total() });
        // Free the report so the cleanup sweep can delete the source and any slides already written.
        await repo.releaseLock(job.id);
        return { cancelled: true };
      }
      const { code, detail } = classify(err);
      log.error("job failed", { ...ctx, atStep: step, code, userMessage: detail, ms: total(), error: err });
      await repo.markFailed(job.id, code, detail);
      await audit.record({ brandKey: job.brandKey, reportId: job.id, action: audit.ACTIONS.PROCESSING_FAILED, metadata: { code } });
      return { failed: code };
    } finally {
      clearInterval(watcher);
      fs.rm(workDir, { recursive: true, force: true }, (err) => {
        if (err) log.warn("could not remove the work directory", { ...ctx, workDir, error: err });
        else log.debug("work directory removed", { ...ctx, workDir });
      });
    }
  }

  return { process, classify };
}

module.exports = { buildProcessor };
