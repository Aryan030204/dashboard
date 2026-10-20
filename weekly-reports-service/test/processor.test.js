const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const sharp = require("sharp");
const { buildProcessor } = require("../src/services/processor");
const { convertToPageImages } = require("../src/services/converter");
const { ACTIONS } = require("../src/services/audit");
const { httpError } = require("../src/errors");
const { baseConfig } = require("./helpers");

function makeDeps({ convert, deleted = false, failStorage = false } = {}) {
  const calls = { complete: null, failed: null, put: new Map(), events: [], progress: [], released: [] };
  const repo = {
    async isDeleted() { return typeof deleted === "function" ? deleted() : deleted; },
    async releaseLock(id) { calls.released.push(id); },
    async setProgress(id, p) { calls.progress.push({ id, ...p }); },
    async complete(id, slides) { calls.complete = { id, slides }; },
    async markFailed(id, code, detail) { calls.failed = { id, code, detail }; },
  };
  const storage = {
    slideKey: (b, id, n) => `${b}/${id}/slides/${String(n).padStart(3, "0")}.webp`,
    thumbKey: (b, id, n) => `${b}/${id}/thumbnails/${String(n).padStart(3, "0")}.webp`,
    async downloadToFile(_key, dest) { fs.writeFileSync(dest, "pretend source"); },
    async putBuffer(key, buf) { if (failStorage) throw new Error("s3 down"); calls.put.set(key, buf); },
  };
  const audit = { ACTIONS, async record(e) { calls.events.push(e); } };
  const config = { ...baseConfig(), uploadTmpDir: os.tmpdir(), slideWidth: 800, thumbWidth: 100, cancelPollMs: 20 };
  const logger = { warn() {}, error() {} };
  return { calls, processor: buildProcessor({ config, repo, storage, audit, convert, logger }) };
}

async function fakePages(count, dir) {
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    const p = path.join(dir, `page-${i}.png`);
    await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#336699" } }).png().toFile(p);
    out.push(p);
  }
  return out;
}

const job = { id: 7, brandKey: "BBB", sourceKey: "BBB/7/source/presentation.pptx", sourceType: "pptx" };

test("converts every page to a full-size and a thumbnail webp and marks the report READY", async () => {
  const { calls, processor } = makeDeps({ convert: ({ workDir }) => fakePages(3, workDir) });
  const result = await processor.process(job);
  assert.deepEqual(result, { slides: 3 });
  assert.equal(calls.complete.id, 7);
  assert.equal(calls.complete.slides.length, 3);
  assert.equal(calls.complete.slides[0].imageKey, "BBB/7/slides/001.webp");
  assert.equal(calls.complete.slides[2].thumbKey, "BBB/7/thumbnails/003.webp");
  const full = await sharp(calls.put.get("BBB/7/slides/001.webp")).metadata();
  const thumb = await sharp(calls.put.get("BBB/7/thumbnails/001.webp")).metadata();
  assert.equal(full.format, "webp");
  assert.equal(full.width, 800);
  assert.equal(thumb.width, 100);
  assert.equal(calls.events[0].action, "REPORT_PROCESSED");
});

test("reports slide-by-slide progress: total known first, then 1..n done", async () => {
  const { calls, processor } = makeDeps({ convert: ({ workDir }) => fakePages(3, workDir) });
  await processor.process(job);
  assert.deepEqual(
    calls.progress.map((p) => [p.stage, p.slidesTotal, p.slidesDone]),
    [["SAVING_SLIDES", 3, 0], ["SAVING_SLIDES", 3, 1], ["SAVING_SLIDES", 3, 2], ["SAVING_SLIDES", 3, 3]],
  );
});

test("a conversion failure ends FAILED with a safe message and no converter output", async () => {
  const { calls, processor } = makeDeps({ convert: async () => { throw httpError(422, "CONVERSION_FAILED", "The presentation could not be converted."); } });
  const result = await processor.process(job);
  assert.deepEqual(result, { failed: "CONVERSION_FAILED" });
  assert.equal(calls.failed.code, "CONVERSION_FAILED");
  assert.equal(calls.complete, null);
  assert.equal(calls.events[0].action, "REPORT_PROCESSING_FAILED");
});

test("a timeout is recorded as PROCESSING_TIMEOUT", async () => {
  const { calls, processor } = makeDeps({ convert: async () => { throw httpError(422, "PROCESSING_TIMEOUT", "Conversion took too long."); } });
  await processor.process(job);
  assert.equal(calls.failed.code, "PROCESSING_TIMEOUT");
});

test("an unexpected error is stored generically, never with raw text", async () => {
  const { calls, processor } = makeDeps({ convert: async () => { throw new Error("/usr/lib/office/secret/path exploded"); } });
  await processor.process(job);
  assert.equal(calls.failed.code, "PROCESSING_ERROR");
  assert.ok(!/secret|exploded/.test(calls.failed.detail));
});

test("a storage failure while writing slides ends FAILED", async () => {
  const { calls, processor } = makeDeps({ convert: ({ workDir }) => fakePages(1, workDir), failStorage: true });
  await processor.process(job);
  assert.equal(calls.failed.code, "PROCESSING_ERROR");
});

test("a report cancelled right at the end is not completed, and the worker lets go of it", async () => {
  const { calls, processor } = makeDeps({ convert: ({ workDir }) => fakePages(1, workDir), deleted: true });
  const result = await processor.process(job);
  assert.deepEqual(result, { cancelled: true });
  assert.equal(calls.complete, null);
  assert.equal(calls.failed, null, "a cancelled job is never recorded as FAILED");
  assert.deepEqual(calls.released, [7]);
});

test("cancelling during conversion kills the running tool, writes nothing and releases the report", async () => {
  let stopped = false;
  const flip = { value: false };
  const { calls, processor } = makeDeps({
    deleted: () => flip.value,
    // Stands in for LibreOffice: runs until the abort signal fires, like the real killable child.
    convert: ({ signal }) => new Promise((resolve, reject) => {
      setTimeout(() => { flip.value = true; }, 40); // the admin cancels while it is converting
      signal.addEventListener("abort", () => {
        stopped = true;
        reject(Object.assign(new Error("aborted"), { code: "ABORTED" }));
      });
    }),
  });
  const result = await processor.process(job);
  assert.deepEqual(result, { cancelled: true });
  assert.ok(stopped, "the conversion was told to stop");
  assert.equal(calls.put.size, 0, "nothing was written to S3");
  assert.equal(calls.complete, null);
  assert.equal(calls.failed, null);
  assert.deepEqual(calls.released, [7]);
  assert.equal(calls.events.length, 0, "no processed/failed audit event for a cancelled job");
});

test("cancelling between slides stops writing more files", async () => {
  const holder = {};
  const made = makeDeps({
    convert: ({ workDir }) => fakePages(5, workDir),
    // Reports "deleted" once the third slide (2 files each) has been written.
    deleted: () => holder.calls.put.size >= 6,
  });
  holder.calls = made.calls;
  const result = await made.processor.process(job);
  assert.deepEqual(result, { cancelled: true });
  assert.ok(made.calls.put.size >= 6 && made.calls.put.size < 10, `stopped early, wrote ${made.calls.put.size} of 10 files`);
  assert.equal(made.calls.complete, null);
  assert.deepEqual(made.calls.released, [7]);
});

test("the work directory is removed after a job", async () => {
  let seen;
  const { processor } = makeDeps({ convert: async ({ workDir }) => { seen = workDir; return fakePages(1, workDir); } });
  await processor.process(job);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.existsSync(seen), false);
});

// ---- converter command handling with a fake executor (no LibreOffice needed) -----------------
test("converter: too many slides is rejected before rasterising", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wr-conv-"));
  const source = path.join(dir, "source.pptx");
  fs.writeFileSync(source, "x");
  const seen = [];
  const exec = async (cmd, args) => {
    seen.push(path.basename(cmd));
    if (/soffice/.test(cmd)) { fs.writeFileSync(path.join(dir, "source.pdf"), "pdf"); return { code: 0, stdout: "", stderr: "" }; }
    if (/pdfinfo/.test(cmd)) return { code: 0, stdout: "Title: x\nPages:          250\n", stderr: "" };
    throw new Error("pdftoppm must not run");
  };
  await assert.rejects(
    convertToPageImages({ sourcePath: source, workDir: dir, config: { ...baseConfig(), maxSlides: 100 }, exec }),
    (err) => err.code === "TOO_MANY_SLIDES",
  );
  assert.ok(!seen.includes("pdftoppm"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("converter: a non-zero LibreOffice exit is CONVERSION_FAILED; a timeout is PROCESSING_TIMEOUT", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wr-conv-"));
  const source = path.join(dir, "source.pptx");
  fs.writeFileSync(source, "x");
  const cfg = baseConfig();
  await assert.rejects(
    convertToPageImages({ sourcePath: source, workDir: dir, config: cfg, exec: async () => ({ code: 1, stdout: "", stderr: "boom" }) }),
    (err) => err.code === "CONVERSION_FAILED",
  );
  await assert.rejects(
    convertToPageImages({ sourcePath: source, workDir: dir, config: cfg, exec: async () => { throw Object.assign(new Error("t"), { code: "TIMEOUT" }); } }),
    (err) => err.code === "PROCESSING_TIMEOUT",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
