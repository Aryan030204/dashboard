const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");
const { normalizePptx, fillRectToSrcRect, toSrcRect } = require("../src/services/pptxNormalizer");
const { convertToPageImages } = require("../src/services/converter");

const fill = (rect) =>
  `<a:blipFill><a:blip r:embed="rId3"/><a:stretch><a:fillRect ${rect}/></a:stretch></a:blipFill>`;

test("the picture crop that LibreOffice drew as a whole slide becomes an equivalent srcRect", () => {
  // Taken from slide 2 of the weekly deck: a thin underline cut out of a full-slide picture.
  const out = fillRectToSrcRect(fill('l="-64339" t="-339581" r="-2199969" b="-2710796"'));
  assert.ok(out.includes('<a:srcRect l="2721" t="10779" r="93049" b="86047"/>'), out);
  assert.ok(out.includes("<a:stretch><a:fillRect/></a:stretch>"));
  assert.ok(out.indexOf("<a:srcRect") < out.indexOf("<a:stretch>"), "schema order: blip, srcRect, stretch");
});

test("a picture that overhangs one side is cropped on that side only", () => {
  assert.deepEqual(toSrcRect({ l: 0, t: -20593, r: 0, b: 0 }), { l: 0, t: 17076, r: 0, b: 0 });
});

test("the visible part is the same before and after (shape width x, picture width x * (1 + overhang))", () => {
  const rect = toSrcRect({ l: -64339, t: 0, r: -2199969, b: 0 });
  const pictureWidth = 1 + 0.64339 + 21.99969; // in shape widths
  const visible = 1 - (rect.l + rect.r) / 100000;
  assert.ok(Math.abs(visible - 1 / pictureWidth) < 1e-4);
});

test("nothing changes for plain fills, positive insets or fills that already have a srcRect", () => {
  for (const xml of [
    fill(""),
    fill('l="0" t="0" r="0" b="0"'),
    fill('l="5000" t="0" r="0" b="0"'),
    fill('l="-10" t="5000" r="0" b="0"'),
    `<a:blipFill><a:blip r:embed="rId2"/><a:srcRect l="10"/><a:stretch><a:fillRect l="-5000"/></a:stretch></a:blipFill>`,
    `<a:blipFill><a:blip r:embed="rId2"/><a:tile tx="0" ty="0"/></a:blipFill>`,
  ]) {
    assert.equal(fillRectToSrcRect(xml), xml);
  }
});

test("picture fills (p:blipFill) and several fills in one slide are all handled", () => {
  const xml = `<p:pic><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect t="-1000" b="-1000"/></a:stretch></p:blipFill></p:pic>` +
    fill('l="-83" t="0" r="-83" b="0"');
  const out = fillRectToSrcRect(xml);
  assert.equal((out.match(/<a:srcRect/g) || []).length, 2);
  assert.equal((out.match(/<a:fillRect\/>/g) || []).length, 2);
});

async function buildPptx(dir, slideXml) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("ppt/slides/slide1.xml", slideXml);
  zip.file("ppt/media/image1.png", Buffer.from([1, 2, 3, 4]));
  const file = path.join(dir, "deck.pptx");
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

test("normalizePptx writes a fixed copy, keeps every other file, and leaves the original alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-"));
  const src = await buildPptx(dir, `<p:sld>${fill('l="-64339" t="-339581" r="-2199969" b="-2710796"')}</p:sld>`);
  const dest = path.join(dir, "fixed.pptx");
  const before = fs.readFileSync(src);

  assert.equal(await normalizePptx(src, dest), true);
  assert.deepEqual(fs.readFileSync(src), before);
  const zip = await JSZip.loadAsync(fs.readFileSync(dest));
  assert.ok((await zip.file("ppt/slides/slide1.xml").async("string")).includes("<a:srcRect"));
  assert.deepEqual([...(await zip.file("ppt/media/image1.png").async("uint8array"))], [1, 2, 3, 4]);
});

test("normalizePptx writes nothing when no fill needs fixing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-"));
  const src = await buildPptx(dir, `<p:sld>${fill("")}</p:sld>`);
  const dest = path.join(dir, "fixed.pptx");
  assert.equal(await normalizePptx(src, dest), false);
  assert.equal(fs.existsSync(dest), false);
});

function fakeExec(workDir, seen) {
  return async (cmd, args) => {
    if (cmd.includes("soffice")) {
      seen.soffice = args;
      fs.writeFileSync(path.join(workDir, "deck.pdf"), "pdf");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd.includes("pdfinfo")) return { code: 0, stdout: "Pages: 1\nPage    1 size: 960 x 540 pts\n", stderr: "" };
    fs.writeFileSync(path.join(workDir, "page-1.png"), "png");
    return { code: 0, stdout: "", stderr: "" };
  };
}
const config = { convertTimeoutMs: 60000, maxSlides: 50, slideWidth: 1600 };

test("the converter hands LibreOffice the fixed copy, under the same file name", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-"));
  const src = await buildPptx(workDir, `<p:sld>${fill('l="-64339" t="-339581" r="-2199969" b="-2710796"')}</p:sld>`);
  const seen = {};
  const images = await convertToPageImages({ sourcePath: src, workDir, config, exec: fakeExec(workDir, seen) });
  const input = seen.soffice[seen.soffice.length - 1];
  assert.equal(path.basename(input), "deck.pptx");
  assert.notEqual(input, src);
  assert.equal(images.length, 1);
});

test("a deck that needs no fix, a damaged file and a PDF are converted exactly as before", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-"));
  const plain = await buildPptx(workDir, `<p:sld>${fill("")}</p:sld>`);
  let seen = {};
  await convertToPageImages({ sourcePath: plain, workDir, config, exec: fakeExec(workDir, seen) });
  assert.equal(seen.soffice[seen.soffice.length - 1], plain);

  const bad = path.join(workDir, "deck.pptx");
  fs.writeFileSync(bad, "not a zip");
  seen = {};
  await convertToPageImages({ sourcePath: bad, workDir, config, exec: fakeExec(workDir, seen) });
  assert.equal(seen.soffice[seen.soffice.length - 1], bad);

  const pdf = path.join(workDir, "deck.pdf");
  fs.writeFileSync(pdf, "pdf");
  seen = {};
  await convertToPageImages({ sourcePath: pdf, workDir, config, exec: fakeExec(workDir, seen) });
  assert.equal(seen.soffice, undefined);
});
