const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { httpError } = require("../errors");
const { normalizePptx } = require("./pptxNormalizer");
const { ensureLogger, stopwatch, clip } = require("../logger");

// A page far taller than it is wide would render as an enormous image once scaled to the slide width.
// Refuse those instead of letting poppler allocate it.
const MAX_RENDER_HEIGHT_PX = 8000;

const abortedError = () => Object.assign(new Error("aborted"), { code: "ABORTED" });

// Runs a command with a hard timeout and no shell. Resolves with { code, stdout, stderr }.
// If `signal` aborts, the whole process group is killed (soffice spawns soffice.bin) and the
// promise rejects with code "ABORTED".
function run(cmd, args, { timeoutMs, cwd, env, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortedError());

    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const kill = () => {
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
      } catch (_) {
        child.kill("SIGKILL");
      }
    };
    const killer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs || 300000);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(killer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (d) => { stdout += d; if (stdout.length > 20000) stdout = stdout.slice(-20000); });
    child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on("error", (err) => { cleanup(); reject(err); });
    child.on("close", (code) => {
      cleanup();
      if (aborted) return reject(abortedError());
      if (timedOut) return reject(Object.assign(new Error(`${cmd} timed out`), { code: "TIMEOUT" }));
      return resolve({ code, stdout, stderr });
    });
    return undefined;
  });
}

// PPT/PPTX -> PDF (LibreOffice headless) -> one PNG per page (poppler). A PDF upload skips the first step. Returns PNG paths in
// slide order. Runs with a private LibreOffice profile and no network use; macros do not run
// in headless conversion. Pass `signal` to cancel: the running tool is killed and the call rejects
// with code "ABORTED".
async function convertToPageImages({ sourcePath, workDir, config, signal, exec = run, logger, jobId = null }) {
  const log = ensureLogger(logger, "converter");
  const total = stopwatch();
  const ctx = jobId === null ? {} : { report: jobId };

  // Every external tool call is logged with its exit code and timing; on failure also the tail of its output,
  // which is where LibreOffice / poppler say what went wrong.
  const tool = async (label, cmd, args, options) => {
    const elapsed = stopwatch();
    log.info(`${label} starting`, { ...ctx, cmd: path.basename(cmd), args: args.map((a) => (path.isAbsolute(a) ? path.basename(a) : a)), timeoutMs: options.timeoutMs });
    let result;
    try {
      result = await exec(cmd, args, options);
    } catch (err) {
      log.error(`${label} could not run`, { ...ctx, cmd: path.basename(cmd), ms: elapsed(), error: err });
      throw err;
    }
    const fields = { ...ctx, cmd: path.basename(cmd), exit: result.code, ms: elapsed() };
    if (result.code === 0) {
      log.info(`${label} finished`, fields);
      if (result.stderr && result.stderr.trim()) log.debug(`${label} wrote to stderr`, { ...ctx, stderr: clip(result.stderr.trim().slice(-1000)) });
    } else {
      log.error(`${label} failed`, { ...fields, stderr: clip((result.stderr || "").trim().slice(-2000)), stdout: clip((result.stdout || "").trim().slice(-1000)) });
    }
    return result;
  };

  const remaining = (() => {
    const start = Date.now();
    return () => Math.max(1000, config.convertTimeoutMs - (Date.now() - start));
  })();

  const isPdf = path.extname(sourcePath).toLowerCase() === ".pdf";
  const profileDir = path.join(workDir, "lo-profile");
  // A PDF upload is already the page source; presentations are converted to one first.
  const pdfPath = isPdf ? sourcePath : path.join(workDir, `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`);
  const what = isPdf ? "document" : "presentation";
  let sourceBytes = null;
  try {
    sourceBytes = fs.statSync(sourcePath).size;
  } catch (_) {
    /* reported by the tools below */
  }
  log.info("conversion started", { ...ctx, file: path.basename(sourcePath), type: isPdf ? "pdf" : path.extname(sourcePath).slice(1).toLowerCase(), bytes: sourceBytes, maxSlides: config.maxSlides, slideWidth: config.slideWidth, timeoutMs: config.convertTimeoutMs });

  try {
    if (!isPdf) {
      // Picture crops that LibreOffice cannot read are rewritten first (see pptxNormalizer). Any failure here
      // just means the original file is converted as it always was.
      let inputPath = sourcePath;
      if (path.extname(sourcePath).toLowerCase() === ".pptx") {
        try {
          const fixedDir = path.join(workDir, "normalized");
          fs.mkdirSync(fixedDir, { recursive: true });
          const fixedPath = path.join(fixedDir, path.basename(sourcePath));
          if (await normalizePptx(sourcePath, fixedPath, { logger: log.child("normalize") })) {
            inputPath = fixedPath;
            log.info("converting the fixed copy of the presentation", ctx);
          } else {
            log.info("converting the original presentation (nothing to fix)", ctx);
          }
        } catch (err) {
          // not fatal: the original file is converted, but say so, otherwise a broken fix looks like no fix
          log.warn("picture crops were not fixed, converting the original presentation", { ...ctx, error: err });
          inputPath = sourcePath;
        }
      } else {
        log.info("legacy .ppt, no picture fix applied", ctx);
      }
      const lo = await tool(
        "soffice",
        process.env.SOFFICE_BIN || "soffice",
        [
          "--headless", "--norestore", "--nolockcheck", "--nodefault", "--nofirststartwizard",
          `-env:UserInstallation=file://${profileDir.replace(/\\/g, "/")}`,
          "--convert-to", "pdf", "--outdir", workDir, inputPath,
        ],
        { timeoutMs: remaining(), cwd: workDir, env: { HOME: workDir }, signal },
      );
      if (lo.code !== 0 || !fs.existsSync(pdfPath)) {
        log.error("the presentation was not converted to a PDF", { ...ctx, exit: lo.code, pdfExists: fs.existsSync(pdfPath), expected: path.basename(pdfPath), workDirFiles: safeList(workDir) });
        throw httpError(422, "CONVERSION_FAILED", "The presentation could not be converted.");
      }
      log.info("PDF produced", { ...ctx, pdf: path.basename(pdfPath), bytes: fs.statSync(pdfPath).size });
    }

    // -f/-l makes pdfinfo also print every page's size (up to the slide limit) so odd shapes are caught.
    const info = await tool(
      "pdfinfo",
      process.env.PDFINFO_BIN || "pdfinfo",
      ["-f", "1", "-l", String(config.maxSlides), pdfPath],
      { timeoutMs: 30000, cwd: workDir, signal },
    );
    if (isPdf && info.code !== 0) {
      throw httpError(422, "CONVERSION_FAILED", "This PDF could not be read. It may be damaged or password-protected.");
    }
    const pages = Number((/^Pages:\s+(\d+)/m.exec(info.stdout) || [])[1]);
    if (!pages) {
      log.error("the document has no pages", { ...ctx, pdfinfoExit: info.code, pdfinfo: clip((info.stdout || "").slice(0, 600)) });
      throw httpError(422, "CONVERSION_FAILED", `The ${what} has no pages.`);
    }
    if (pages > config.maxSlides) {
      log.warn("too many slides", { ...ctx, pages, limit: config.maxSlides });
      throw httpError(422, "TOO_MANY_SLIDES", `The ${what} has ${pages} slides; the limit is ${config.maxSlides}.`);
    }
    const shapes = new Map();
    for (const m of info.stdout.matchAll(/^Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gm)) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      shapes.set(`${w}x${h}`, (shapes.get(`${w}x${h}`) || 0) + 1);
      if (!(w > 0) || !(h > 0) || (config.slideWidth * h) / w > MAX_RENDER_HEIGHT_PX) {
        log.error("a page is too large or oddly shaped", { ...ctx, widthPts: w, heightPts: h, maxRenderHeightPx: MAX_RENDER_HEIGHT_PX });
        throw httpError(422, "CONVERSION_FAILED", "A page is too large or oddly shaped to render.");
      }
    }
    log.info("page count and sizes checked", { ...ctx, pages, pageSizesPts: Object.fromEntries(shapes) });

    const prefix = path.join(workDir, "page");
    const ppm = await tool(
      "pdftoppm",
      process.env.PDFTOPPM_BIN || "pdftoppm",
      ["-scale-to-x", String(config.slideWidth), "-scale-to-y", "-1", "-png", pdfPath, prefix],
      { timeoutMs: remaining(), cwd: workDir, signal },
    );
    if (ppm.code !== 0) throw httpError(422, "CONVERSION_FAILED", "The slides could not be rendered.");

    const images = fs
      .readdirSync(workDir)
      .filter((f) => /^page-\d+\.png$/.test(f))
      .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]))
      .map((f) => path.join(workDir, f));
    if (images.length !== pages) {
      log.error("some pages were not rendered", { ...ctx, pages, images: images.length });
      throw httpError(422, "CONVERSION_FAILED", "Some slides could not be rendered.");
    }
    log.info("conversion finished", { ...ctx, pages, images: images.length, ms: total() });
    return images;
  } catch (err) {
    if (err && err.code === "TIMEOUT") {
      log.error("conversion timed out", { ...ctx, ms: total(), timeoutMs: config.convertTimeoutMs, error: err });
      throw httpError(422, "PROCESSING_TIMEOUT", "Conversion took too long.");
    }
    if (err && err.code === "ENOENT") {
      log.error("a conversion tool is not installed (soffice, pdfinfo or pdftoppm)", { ...ctx, error: err });
      throw httpError(500, "CONVERTER_MISSING", "The conversion tools are not installed.");
    }
    if (err && err.code === "ABORTED") log.warn("conversion aborted (the report was cancelled or deleted)", { ...ctx, ms: total() });
    else if (!err || !err.status) log.error("conversion failed unexpectedly", { ...ctx, ms: total(), error: err });
    throw err; // includes ABORTED, which the processor treats as a cancellation
  }
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir).slice(0, 30);
  } catch (_) {
    return [];
  }
}

module.exports = { convertToPageImages, run };
