// PDF uploads: accepted next to PPT/PPTX, validated by their real header, and rendered without LibreOffice.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const { convertToPageImages } = require("../src/services/converter");
const { makeApp, author, validPptx, baseConfig } = require("./helpers");

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");

const upload = (ctx, buf, name, fields = {}) =>
  request(ctx.app)
    .post("/weekly-reports")
    .set(author("BBB"))
    .field("title", fields.title ?? "Quarterly Deck")
    .field("reporting_week", fields.week ?? "Week 43")
    .attach("file", buf, name);

// ---- upload and validation -------------------------------------------------------------------
test("a PDF is accepted: 202, stored as presentation.pdf with the pdf source type", async () => {
  const ctx = makeApp();
  const res = await upload(ctx, PDF, "deck.pdf");
  assert.equal(res.status, 202);
  assert.equal(res.body.source_type, "pdf");
  assert.equal(res.body.status, "PROCESSING");
  assert.match([...ctx.storage.objects.keys()][0], /^BBB\/\d+\/source\/presentation\.pdf$/);
});

test("the .PDF extension is matched case-insensitively", async () => {
  const ctx = makeApp();
  assert.equal((await upload(ctx, PDF, "DECK.PDF")).status, 202);
});

test("a PDF with a few bytes before the header is still accepted (the spec allows it)", async () => {
  const ctx = makeApp();
  assert.equal((await upload(ctx, Buffer.concat([Buffer.from("\n\n junk \n"), PDF]), "deck.pdf")).status, 202);
});

test("files named .pdf that are not PDFs are rejected and nothing is stored", async () => {
  const cases = [
    ["plain text", Buffer.from("this is just text, renamed to .pdf")],
    ["a pptx renamed .pdf", validPptx()],
    ["header too far in", Buffer.concat([Buffer.alloc(2000, 0x20), PDF])],
  ];
  for (const [label, buf] of cases) {
    const ctx = makeApp();
    const res = await upload(ctx, buf, "deck.pdf");
    assert.equal(res.status, 415, label);
    assert.equal(res.body.code, "UNSUPPORTED_FILE_TYPE", label);
    assert.match(res.body.error, /not a valid \.pdf/, label);
    assert.equal(ctx.repo._reports.length, 0, `${label}: nothing created`);
    assert.equal(ctx.storage.objects.size, 0, `${label}: nothing stored`);
  }
});

test("a PDF renamed .pptx or .ppt is rejected by the presentation checks", async () => {
  const ctx = makeApp();
  assert.equal((await upload(ctx, PDF, "deck.pptx")).status, 415);
  assert.equal((await upload(ctx, PDF, "deck.ppt")).status, 415);
  assert.equal(ctx.repo._reports.length, 0);
});

test("an empty .pdf is refused, and the unsupported-type message now lists PDF", async () => {
  const ctx = makeApp();
  assert.equal((await upload(ctx, Buffer.alloc(0), "empty.pdf")).status, 422);
  const other = await upload(ctx, PDF, "notes.docx");
  assert.equal(other.status, 415);
  assert.equal(other.body.error, "Only .pptx, .ppt or .pdf files are supported.");
});

test("a PDF over the size limit is 413, same as presentations", async () => {
  const ctx = makeApp({ config: { maxUploadBytes: 1024 } });
  const res = await upload(ctx, Buffer.concat([PDF, Buffer.alloc(4000)]), "big.pdf");
  assert.equal(res.status, 413);
  assert.equal(ctx.repo._reports.length, 0);
});

test("duplicate-title handling works the same for PDFs", async () => {
  const ctx = makeApp();
  await upload(ctx, PDF, "a.pdf", { title: "Same Name" });
  const second = await upload(ctx, PDF, "b.pdf", { title: "Same Name" });
  assert.equal(second.body.title, "Same Name (1)");
});

// ---- the converter: a PDF is rendered directly, a presentation goes through LibreOffice first ---
function fakeExec({ pages = 3, pageSizes = null, pdfinfoCode = 0 } = {}) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    const tool = path.basename(cmd);
    calls.push({ tool, args });
    if (/soffice/.test(tool)) {
      fs.writeFileSync(path.join(opts.cwd, "source.pdf"), "pdf");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (/pdfinfo/.test(tool)) {
      const sizes = pageSizes || Array.from({ length: pages }, () => [1920, 1080]);
      const lines = sizes.map(([w, h], i) => `Page ${String(i + 1).padStart(4)} size: ${w} x ${h} pts`).join("\n");
      return { code: pdfinfoCode, stdout: `Title: x\nPages:          ${pages}\n${lines}\n`, stderr: "" };
    }
    if (/pdftoppm/.test(tool)) {
      for (let i = 1; i <= pages; i += 1) fs.writeFileSync(path.join(opts.cwd, `page-${i}.png`), "png");
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected tool ${tool}`);
  };
  return { exec, calls };
}

function workspace(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pdf-"));
  const sourcePath = path.join(dir, file);
  fs.writeFileSync(sourcePath, "x");
  return { dir, sourcePath, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("converter: a PDF skips LibreOffice and is rendered at the slide width", async () => {
  const ws = workspace("source.pdf");
  const { exec, calls } = fakeExec({ pages: 3 });
  const images = await convertToPageImages({ sourcePath: ws.sourcePath, workDir: ws.dir, config: baseConfig(), exec });
  assert.equal(images.length, 3);
  assert.deepEqual(calls.map((c) => c.tool), ["pdfinfo", "pdftoppm"], "no soffice call for a PDF");
  assert.ok(calls[0].args.includes(ws.sourcePath), "pdfinfo reads the uploaded PDF itself");
  const ppm = calls[1].args;
  assert.equal(ppm[ppm.indexOf("-scale-to-x") + 1], String(baseConfig().slideWidth));
  assert.equal(ppm[ppm.indexOf("-scale-to-y") + 1], "-1", "aspect ratio is preserved");
  ws.done();
});

test("converter: a presentation still goes through LibreOffice first", async () => {
  const ws = workspace("source.pptx");
  const { exec, calls } = fakeExec({ pages: 2 });
  await convertToPageImages({ sourcePath: ws.sourcePath, workDir: ws.dir, config: baseConfig(), exec });
  assert.deepEqual(calls.map((c) => c.tool), ["soffice", "pdfinfo", "pdftoppm"]);
  ws.done();
});

test("converter: an unreadable or password-protected PDF fails with a clear message, before rendering", async () => {
  const ws = workspace("source.pdf");
  const { exec, calls } = fakeExec({ pdfinfoCode: 1, pages: 0 });
  await assert.rejects(
    convertToPageImages({ sourcePath: ws.sourcePath, workDir: ws.dir, config: baseConfig(), exec }),
    (err) => err.code === "CONVERSION_FAILED" && /PDF could not be read/.test(err.message),
  );
  assert.ok(!calls.some((c) => c.tool === "pdftoppm"));
  ws.done();
});

test("converter: a PDF with too many pages is refused before rendering", async () => {
  const ws = workspace("source.pdf");
  const { exec, calls } = fakeExec({ pages: 250 });
  await assert.rejects(
    convertToPageImages({ sourcePath: ws.sourcePath, workDir: ws.dir, config: { ...baseConfig(), maxSlides: 100 }, exec }),
    (err) => err.code === "TOO_MANY_SLIDES" && /document has 250/.test(err.message),
  );
  assert.ok(!calls.some((c) => c.tool === "pdftoppm"));
  ws.done();
});

test("converter: a page that would render absurdly tall is refused before rendering", async () => {
  const ws = workspace("source.pdf");
  // 1 point wide and 5000 points tall would be an image about 9.6 million pixels high at slide width.
  const { exec, calls } = fakeExec({ pages: 2, pageSizes: [[612, 792], [1, 5000]] });
  await assert.rejects(
    convertToPageImages({ sourcePath: ws.sourcePath, workDir: ws.dir, config: baseConfig(), exec }),
    (err) => err.code === "CONVERSION_FAILED" && /too large or oddly shaped/.test(err.message),
  );
  assert.ok(!calls.some((c) => c.tool === "pdftoppm"), "nothing was rendered");
  ws.done();
});

test("converter: normal portrait pages (A4, US Letter) and landscape slides are fine", async () => {
  const ws = workspace("source.pdf");
  const { exec } = fakeExec({ pages: 3, pageSizes: [[595.276, 841.89], [612, 792], [1920, 1080]] });
  const images = await convertToPageImages({ sourcePath: ws.sourcePath, workDir: ws.dir, config: baseConfig(), exec });
  assert.equal(images.length, 3);
  ws.done();
});
