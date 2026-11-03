const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");
const { createLogger, ensureLogger, describeError } = require("../src/logger");
const { convertToPageImages } = require("../src/services/converter");
const { buildProcessor } = require("../src/services/processor");
const { normalizePptx } = require("../src/services/pptxNormalizer");
const { buildApp } = require("../src/app");
const { fakeRepo, baseConfig, author } = require("./helpers");

// A logger that keeps what was written instead of printing it.
function capture() {
  const lines = [];
  const sink = {
    log: (l) => lines.push(l),
    warn: (l) => lines.push(l),
    error: (l) => lines.push(l),
  };
  process.env.WEEKLY_REPORTS_LOG_LEVEL = "debug"; // tests run silent by default
  return { lines, logger: createLogger("test", { sink }), text: () => lines.join("\n") };
}
test.afterEach(() => {
  delete process.env.WEEKLY_REPORTS_LOG_LEVEL;
});

test("a line has a timestamp, level, scope, message and JSON fields", () => {
  const { lines, logger } = capture();
  logger.info("hello", { report: 26, brand: "AJMAL" });
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO  \[test\] hello \{"report":26,"brand":"AJMAL"\}$/);
});

test("the level filter works and silent writes nothing", () => {
  const { lines, logger } = capture();
  process.env.WEEKLY_REPORTS_LOG_LEVEL = "warn";
  logger.debug("d");
  logger.info("i");
  logger.warn("w");
  logger.error("e");
  assert.deepEqual(lines.map((l) => l.split(" ")[1]), ["WARN", "ERROR"]);
  process.env.WEEKLY_REPORTS_LOG_LEVEL = "silent";
  logger.error("never");
  assert.equal(lines.length, 2);
});

test("an error is written with its type, code, message, stack and cause", () => {
  const { text, logger } = capture();
  const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const err = Object.assign(new Error("S3 refused"), { name: "AccessDenied", $metadata: { httpStatusCode: 403, requestId: "REQ1", attempts: 3 }, cause });
  logger.error("upload failed", { report: 7, error: err });
  const out = JSON.parse(text().slice(text().indexOf("{")));
  assert.equal(out.error.name, "AccessDenied");
  assert.equal(out.error.message, "S3 refused");
  assert.deepEqual(out.error.aws, { httpStatus: 403, requestId: "REQ1", attempts: 3 });
  assert.equal(out.error.cause.code, "ECONNRESET");
  assert.ok(out.error.stack.length > 0 && out.error.stack.length <= 8);
  assert.equal(describeError("plain text").message, "plain text");
});

test("ensureLogger accepts partial or missing loggers, so callers and tests can inject anything", () => {
  assert.doesNotThrow(() => ensureLogger({ warn() {}, error() {} }).info("x"));
  assert.doesNotThrow(() => ensureLogger({ warn() {} }).child("a").debug("x"));
  assert.doesNotThrow(() => ensureLogger(undefined).child("a"));
  const seen = [];
  ensureLogger({ warn: (m, f) => seen.push([m, f]) }).warn("careful", { a: 1 });
  assert.deepEqual(seen, [["careful", { a: 1 }]]);
});

function fakeExec(workDir, { sofficeCode = 0, sofficeStderr = "", pdf = true } = {}) {
  return async (cmd) => {
    if (cmd.includes("soffice")) {
      if (pdf && sofficeCode === 0) fs.writeFileSync(path.join(workDir, "deck.pdf"), "pdf");
      return { code: sofficeCode, stdout: "", stderr: sofficeStderr };
    }
    if (cmd.includes("pdfinfo")) return { code: 0, stdout: "Pages: 2\nPage    1 size: 960 x 540 pts\nPage    2 size: 960 x 540 pts\n", stderr: "" };
    fs.writeFileSync(path.join(workDir, "page-1.png"), "png");
    fs.writeFileSync(path.join(workDir, "page-2.png"), "png");
    return { code: 0, stdout: "", stderr: "" };
  };
}
const config = { convertTimeoutMs: 60000, maxSlides: 50, slideWidth: 1600 };
async function emptyPptx(dir) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("ppt/slides/slide1.xml", "<p:sld/>");
  const file = path.join(dir, "deck.pptx");
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

test("a conversion logs every step with timings, and the report id on each line", async () => {
  const { text, logger } = capture();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-"));
  const src = await emptyPptx(workDir);
  await convertToPageImages({ sourcePath: src, workDir, config, exec: fakeExec(workDir), logger, jobId: 26 });
  const out = text();
  for (const step of ["conversion started", "no extreme picture crops", "converting the original presentation", "soffice starting", "soffice finished", "PDF produced", "pdfinfo finished", "page count and sizes checked", "pdftoppm finished", "conversion finished"]) {
    assert.ok(out.includes(step), `missing log: ${step}`);
  }
  assert.ok(out.split("\n").filter((l) => l.includes("soffice")).every((l) => l.includes('"report":26')));
});

test("when LibreOffice fails, its exit code and output are in the log", async () => {
  const { text, logger } = capture();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-"));
  const src = await emptyPptx(workDir);
  await assert.rejects(
    convertToPageImages({ sourcePath: src, workDir, config, exec: fakeExec(workDir, { sofficeCode: 81, sofficeStderr: "javaldx: Could not find a Java Runtime Environment!" }), logger, jobId: 5 }),
    (err) => err.code === "CONVERSION_FAILED",
  );
  assert.match(text(), /ERROR \[test\] soffice failed .*"exit":81.*Could not find a Java Runtime/);
  assert.match(text(), /the presentation was not converted to a PDF/);
});

test("a missing tool and a timeout are explained in the log", async () => {
  for (const [code, expected] of [["ENOENT", /tool is not installed/], ["TIMEOUT", /conversion timed out/]]) {
    const { text, logger } = capture();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-"));
    const src = await emptyPptx(workDir);
    const exec = async () => {
      throw Object.assign(new Error(`${code} happened`), { code });
    };
    await assert.rejects(convertToPageImages({ sourcePath: src, workDir, config, exec, logger, jobId: 1 }));
    assert.match(text(), expected);
  }
});

test("the normalizer says which crops it cut and what it wrote", async () => {
  const { text, logger } = capture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-"));
  const sharp = require("sharp");
  const png = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#fff" } }).png().toBuffer();
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types><Default Extension="png" ContentType="image/png"/></Types>');
  zip.file("ppt/slides/slide1.xml", '<p:sld><a:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect l="0" t="0" r="-300000" b="0"/></a:stretch></a:blipFill></p:sld>');
  zip.file("ppt/slides/_rels/slide1.xml.rels", '<Relationships><Relationship Id="rId2" Type="x/image" Target="../media/image1.png"/></Relationships>');
  zip.file("ppt/media/image1.png", png);
  const src = path.join(dir, "deck.pptx");
  fs.writeFileSync(src, await zip.generateAsync({ type: "nodebuffer" }));
  assert.equal(await normalizePptx(src, path.join(dir, "out.pptx"), { logger }), true);
  assert.match(text(), /cut an extreme crop out of its picture .*"part":"ppt\/slides\/slide1.xml".*"outputPx":"50x100"/);
  assert.match(text(), /wrote the fixed copy of the presentation/);
});

test("a failed job logs where it failed, the code, the user message and the full error", async () => {
  const { text, logger } = capture();
  const repo = { setProgress: async () => {}, isDeleted: async () => false, markFailed: async () => {}, releaseLock: async () => {}, complete: async () => {} };
  const storage = {
    downloadToFile: async () => {
      throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
    },
  };
  const audit = { ACTIONS: { PROCESSED: "P", PROCESSING_FAILED: "F" }, record: async () => {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "log-"));
  const processor = buildProcessor({ config: { ...config, uploadTmpDir: tmp, cancelPollMs: 60000 }, repo, storage, audit, logger });
  const result = await processor.process({ id: 9, brandKey: "AJMAL", sourceKey: "AJMAL/9/source/presentation.pptx", sourceType: "pptx" });
  assert.deepEqual(result, { failed: "PROCESSING_ERROR" });
  assert.match(text(), /job started .*"report":9.*"brand":"AJMAL"/);
  assert.match(text(), /step 1\/4: downloading the source file/);
  assert.match(text(), /ERROR \[test\] job failed .*"atStep":"download".*"code":"PROCESSING_ERROR".*"name":"NoSuchKey"/);
});

test("the API logs each request with a request id and never the identity headers or the signature", async () => {
  const { lines, logger } = capture();
  const repo = fakeRepo();
  const storage = { sourceKey: () => "k", putFile: async () => {}, getBuffer: async () => Buffer.alloc(1) };
  const audit = { ACTIONS: {}, record: async () => {} };
  const app = buildApp({ config: baseConfig(), repo, storage, audit, logger });
  const server = app.listen(0);
  const headers = author();
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/weekly-reports/`, { headers });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("x-request-id"), /^[0-9a-f]{8}$/);
    const bad = await fetch(`http://127.0.0.1:${port}/weekly-reports/abc`, { headers });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
  const out = lines.join("\n");
  assert.match(out, /INFO  \[test\] GET \/weekly-reports\/ 200 .*"brand":"BBB"/);
  assert.match(out, /WARN  \[test\] request refused .*"code":"INVALID_ID"/);
  assert.match(out, /WARN  \[test\] GET \/weekly-reports\/abc 400/);
  assert.ok(!out.includes(headers["x-gw-sig"]), "the gateway signature must never be logged");
  assert.ok(!out.includes("author@datum.test"), "the user's email must never be logged");
});
