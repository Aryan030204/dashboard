const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { httpError } = require("../errors");

// Runs a command with a hard timeout and no shell. Resolves with { code, stdout, stderr }.
function run(cmd, args, { timeoutMs, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      try {
        // Negative pid kills the whole group (soffice spawns soffice.bin).
        process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
      } catch (_) {
        child.kill("SIGKILL");
      }
    }, timeoutMs || 300000);
    child.stdout.on("data", (d) => { stdout += d; if (stdout.length > 20000) stdout = stdout.slice(-20000); });
    child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on("error", (err) => { clearTimeout(killer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(killer);
      if (timedOut) return reject(Object.assign(new Error(`${cmd} timed out`), { code: "TIMEOUT" }));
      return resolve({ code, stdout, stderr });
    });
  });
}

// PPT/PPTX -> PDF (LibreOffice headless) -> one PNG per page (poppler). Returns PNG paths in
// slide order. Runs with a private LibreOffice profile and no network use; macros do not run
// in headless conversion.
async function convertToPageImages({ sourcePath, workDir, config, exec = run }) {
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
      { timeoutMs: remaining(), cwd: workDir, env: { HOME: workDir } },
    );
    if (lo.code !== 0 || !fs.existsSync(pdfPath)) {
      throw httpError(422, "CONVERSION_FAILED", "The presentation could not be converted.");
    }

    const info = await exec(process.env.PDFINFO_BIN || "pdfinfo", [pdfPath], { timeoutMs: 30000, cwd: workDir });
    const pages = Number((/^Pages:\s+(\d+)/m.exec(info.stdout) || [])[1]);
    if (!pages) throw httpError(422, "CONVERSION_FAILED", "The presentation has no slides.");
    if (pages > config.maxSlides) {
      throw httpError(422, "TOO_MANY_SLIDES", `The presentation has ${pages} slides; the limit is ${config.maxSlides}.`);
    }

    const prefix = path.join(workDir, "page");
    const ppm = await exec(
      process.env.PDFTOPPM_BIN || "pdftoppm",
      ["-r", String(config.rasterDpi), "-png", pdfPath, prefix],
      { timeoutMs: remaining(), cwd: workDir },
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
    throw err;
  }
}

module.exports = { convertToPageImages, run };
