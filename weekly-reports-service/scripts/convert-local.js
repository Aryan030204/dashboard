// One-shot check of the real conversion pipeline, with no database and no S3.
// Runs the same converter and image code the worker uses and writes the results to a folder.
//
//   docker run --rm -v "<folder with deck>:/data" weekly-reports-worker \
//     node scripts/convert-local.js /data/sample.pptx /data/out
//
// Expect: slide count printed, then full-size and thumbnail WebP files per slide in /data/out.
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const { getConfig } = require("../src/config");
const { convertToPageImages } = require("../src/services/converter");

async function main() {
  const [source, outDir] = process.argv.slice(2);
  if (!source || !outDir) {
    console.error("usage: node scripts/convert-local.js <deck.pptx> <output folder>");
    process.exit(2);
  }
  const config = getConfig();
  fs.mkdirSync(outDir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wr-local-"));
  const sourcePath = path.join(workDir, `source${path.extname(source).toLowerCase()}`);
  fs.copyFileSync(source, sourcePath);

  const started = Date.now();
  const pages = await convertToPageImages({ sourcePath, workDir, config });
  console.log(`converted ${pages.length} slide(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  for (let i = 0; i < pages.length; i += 1) {
    const n = String(i + 1).padStart(3, "0");
    const full = await sharp(pages[i]).resize({ width: config.slideWidth, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    const thumb = await sharp(pages[i]).resize({ width: config.thumbWidth, withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
    fs.writeFileSync(path.join(outDir, `${n}.webp`), full);
    fs.writeFileSync(path.join(outDir, `${n}.thumb.webp`), thumb);
    console.log(`  slide ${n}: ${(full.length / 1024).toFixed(0)} KB full, ${(thumb.length / 1024).toFixed(0)} KB thumbnail`);
  }
  fs.rmSync(workDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("FAILED:", err.code || "", err.message);
  process.exit(1);
});
