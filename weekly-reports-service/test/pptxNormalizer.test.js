const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");
const sharp = require("sharp");
const { normalizePptx, visibleRegion } = require("../src/services/pptxNormalizer");
const { convertToPageImages } = require("../src/services/converter");

const EXTREME = 'l="-64339" t="-339581" r="-2199969" b="-2710796"'; // the underline on slide 2 of the weekly deck
const fill = (rect, rid = "rId2") =>
  `<a:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect ${rect}/></a:stretch></a:blipFill>`;

test("the part of the picture inside the shape is worked out from the insets", () => {
  const region = visibleRegion({ l: -64339, t: -339581, r: -2199969, b: -2710796 });
  assert.ok(Math.abs(region.left - 0.02721) < 1e-4);
  assert.ok(Math.abs(region.width - 0.04230) < 1e-4);
  assert.ok(Math.abs(region.top - 0.10779) < 1e-4);
  assert.ok(Math.abs(region.height - 0.03174) < 1e-4);
});

test("ordinary fills are not extreme: no change for small overhangs, zero or positive insets", () => {
  assert.equal(visibleRegion({ l: 0, t: -20593, r: 0, b: 0 }), null);
  assert.equal(visibleRegion({ l: -83, t: 0, r: -83, b: 0 }), null);
  assert.equal(visibleRegion({ l: 0, t: 0, r: 0, b: 0 }), null);
  assert.equal(visibleRegion({ l: 5000, t: -300000, r: 0, b: 0 }), null);
});

// A 200x100 picture: red on the left quarter, blue on the rest.
async function picture() {
  const raw = Buffer.alloc(200 * 100 * 3);
  for (let y = 0; y < 100; y += 1) {
    for (let x = 0; x < 200; x += 1) {
      const i = (y * 200 + x) * 3;
      const red = x < 50;
      raw[i] = red ? 255 : 0;
      raw[i + 2] = red ? 0 : 255;
    }
  }
  return sharp(raw, { raw: { width: 200, height: 100, channels: 3 } }).png().toBuffer();
}

async function buildPptx(dir, slideXml) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types><Default Extension="png" ContentType="image/png"/></Types>');
  zip.file("ppt/slides/slide1.xml", `<p:sld>${slideXml}</p:sld>`);
  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>',
  );
  zip.file("ppt/media/image1.png", await picture());
  const file = path.join(dir, "deck.pptx");
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

test("an extreme crop is cut out of the picture and the shape gets it as a plain fill", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-"));
  // Shape shows x from 0 to 25% of the picture (the red part): picture is 4 shape-widths wide, 1 high.
  const src = await buildPptx(dir, fill('l="0" t="0" r="-300000" b="0"'));
  const dest = path.join(dir, "fixed.pptx");
  const before = fs.readFileSync(src);

  assert.equal(await normalizePptx(src, dest), true);
  assert.deepEqual(fs.readFileSync(src), before, "the original is not modified");

  const zip = await JSZip.loadAsync(fs.readFileSync(dest));
  const slide = await zip.file("ppt/slides/slide1.xml").async("string");
  assert.ok(slide.includes('r:embed="rIdCrop1"'));
  assert.ok(slide.includes("<a:stretch><a:fillRect/></a:stretch>"));
  assert.ok(!slide.includes("srcRect"));
  const rels = await zip.file("ppt/slides/_rels/slide1.xml.rels").async("string");
  assert.ok(rels.includes('Id="rIdCrop1"') && rels.includes('Target="../media/crop-1.png"'));
  assert.ok(rels.includes('Id="rId2"'), "the original relationship stays");
  assert.ok(zip.file("ppt/media/image1.png"), "the original picture stays");

  const cropped = await zip.file("ppt/media/crop-1.png").async("nodebuffer");
  const meta = await sharp(cropped).metadata();
  assert.deepEqual([meta.width, meta.height], [50, 100]);
  const { data } = await sharp(cropped).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([data[0], data[1], data[2]], [255, 0, 0], "only the red part is left");
});

test("the same crop used twice is cut once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-"));
  const src = await buildPptx(dir, fill('l="0" t="0" r="-300000" b="0"') + fill('l="0" t="0" r="-300000" b="0"'));
  const dest = path.join(dir, "fixed.pptx");
  await normalizePptx(src, dest);
  const zip = await JSZip.loadAsync(fs.readFileSync(dest));
  assert.deepEqual(Object.keys(zip.files).filter((n) => n.includes("crop-")), ["ppt/media/crop-1.png"]);
  const slide = await zip.file("ppt/slides/slide1.xml").async("string");
  assert.equal((slide.match(/rIdCrop1/g) || []).length, 2);
});

test("nothing is written when no fill is extreme, or the picture cannot be found", async () => {
  for (const xml of [fill(""), fill('l="0" t="-20593" r="0" b="0"'), fill(EXTREME, "rId9")]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-"));
    const src = await buildPptx(dir, xml);
    const dest = path.join(dir, "fixed.pptx");
    assert.equal(await normalizePptx(src, dest), false);
    assert.equal(fs.existsSync(dest), false);
  }
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
  const src = await buildPptx(workDir, fill('l="0" t="0" r="-300000" b="0"'));
  const seen = {};
  const images = await convertToPageImages({ sourcePath: src, workDir, config, exec: fakeExec(workDir, seen) });
  const input = seen.soffice[seen.soffice.length - 1];
  assert.equal(path.basename(input), "deck.pptx");
  assert.notEqual(input, src);
  assert.equal(images.length, 1);
});

test("a deck that needs no fix, a damaged file and a PDF are converted exactly as before", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-"));
  const plain = await buildPptx(workDir, fill(""));
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
