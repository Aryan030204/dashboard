const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { httpError } = require("../errors");

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

// PPT/PPTX -> PDF (LibreOffice headless) -> one PNG per page (poppler). Returns PNG paths in
// slide order. Runs with a private LibreOffice profile and no network use; macros do not run
// in headless conversion. Pass `signal` to cancel: the running tool is killed and the call rejects
// with code "ABORTED".
async function convertToPageImages({ sourcePath, workDir, config, signal, exec = run }) {
  const remaining = (() => {
    const start = Date.now();
    return () => Math.max(1000, config.convertTimeoutMs - (Date.now() - start));
  })();

  const profileDir = path.join(workDir, "lo-profile");
  const pdfPath = path.join(workDir, `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`);

  try {
    const lo = await exec(
      process.env.SOFFICE_BIN || "soffice",
      [
        "--headless", "--norestore", "--nolockcheck", "--nodefault", "--nofirststartwizard",
        `-env:UserInstallation=file://${profileDir.replace(/\\/g, "/")}`,
        "--convert-to", "pdf", "--outdir", workDir, sourcePath,
      ],
      { timeoutMs: remaining(), cwd: workDir, env: { HOME: workDir }, signal },
    );
    if (lo.code !== 0 || !fs.existsSync(pdfPath)) {
      throw httpError(422, "CONVERSION_FAILED", "The presentation could not be converted.");
    }

    const info = await exec(process.env.PDFINFO_BIN || "pdfinfo", [pdfPath], { timeoutMs: 30000, cwd: workDir, signal });
    const pages = Number((/^Pages:\s+(\d+)/m.exec(info.stdout) || [])[1]);
    if (!pages) throw httpError(422, "CONVERSION_FAILED", "The presentation has no slides.");
    if (pages > config.maxSlides) {
      throw httpError(422, "TOO_MANY_SLIDES", `The presentation has ${pages} slides; the limit is ${config.maxSlides}.`);
    }

    const prefix = path.join(workDir, "page");
    const ppm = await exec(
      process.env.PDFTOPPM_BIN || "pdftoppm",
      ["-r", String(config.rasterDpi), "-png", pdfPath, prefix],
      { timeoutMs: remaining(), cwd: workDir, signal },
    );
    if (ppm.code !== 0) throw httpError(422, "CONVERSION_FAILED", "The slides could not be rendered.");

    const images = fs
      .readdirSync(workDir)
      .filter((f) => /^page-\d+\.png$/.test(f))
      .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]))
      .map((f) => path.join(workDir, f));
    if (images.length !== pages) throw httpError(422, "CONVERSION_FAILED", "Some slides could not be rendered.");
    return images;
  } catch (err) {
    if (err && err.code === "TIMEOUT") throw httpError(422, "PROCESSING_TIMEOUT", "Conversion took too long.");
    if (err && err.code === "ENOENT") throw httpError(500, "CONVERTER_MISSING", "The conversion tools are not installed.");
    throw err; // includes ABORTED, which the processor treats as a cancellation
  }
}

module.exports = { convertToPageImages, run };
