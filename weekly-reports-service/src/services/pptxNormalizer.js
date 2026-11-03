const fs = require("fs");
const JSZip = require("jszip");

// Some exporters (Canva, Google Slides) draw a small piece of a big picture by giving the shape a picture fill
// whose <a:fillRect> has huge negative insets, e.g. l="-64339" r="-2199969": "the picture is 23x as wide as this
// shape, and the shape shows the part that falls inside it". PowerPoint honours that. LibreOffice does not: it
// paints the whole picture, which is how a thin green underline turned into a full slide of unrelated content.
//
// The same crop written as <a:srcRect> ("cut this much off each side of the picture") is handled correctly by
// LibreOffice, so before converting we rewrite every such fill. The picture and the shape stay as they were.

const BLIP_FILL = /<(a|p):blipFill\b[\s\S]*?<\/\1:blipFill>/g;
const STRETCH_FILL_RECT = /<a:stretch>\s*<a:fillRect([^>]*?)\/>\s*<\/a:stretch>/;
const PART = /^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/;

function readInsets(attrs) {
  const insets = { l: 0, t: 0, r: 0, b: 0 };
  for (const [, key, value] of attrs.matchAll(/\b([ltrb])="(-?\d+)"/g)) insets[key] = Number(value);
  return insets;
}

// Insets are in 1/1000 percent of the shape. Negative = the picture sticks out of the shape on that side.
// Only the "sticks out" case is converted; a positive inset (picture smaller than the shape) is left alone.
function toSrcRect({ l, t, r, b }) {
  if (l > 0 || t > 0 || r > 0 || b > 0) return null;
  if (l === 0 && t === 0 && r === 0 && b === 0) return null;
  const width = 100000 - l - r; // the whole picture, as a share of the shape's width (x100000)
  const height = 100000 - t - b;
  const share = (outside, whole) => Math.round((-outside * 100000) / whole) + 0; // + 0 turns -0 into 0
  return { l: share(l, width), t: share(t, height), r: share(r, width), b: share(b, height) };
}

// Returns the XML with picture fills rewritten, or the same string when nothing needed changing.
function fillRectToSrcRect(xml) {
  return xml.replace(BLIP_FILL, (block) => {
    if (block.includes("<a:srcRect")) return block;
    const match = STRETCH_FILL_RECT.exec(block);
    if (!match) return block;
    const rect = toSrcRect(readInsets(match[1]));
    if (!rect) return block;
    const srcRect = `<a:srcRect l="${rect.l}" t="${rect.t}" r="${rect.r}" b="${rect.b}"/>`;
    return block.replace(STRETCH_FILL_RECT, `${srcRect}<a:stretch><a:fillRect/></a:stretch>`);
  });
}

// Writes a copy of the presentation with the fills above rewritten. Returns true when a copy was written,
// false when the file needed no change (the caller then keeps using the original).
async function normalizePptx(sourcePath, destPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  let changed = false;
  for (const name of Object.keys(zip.files)) {
    if (!PART.test(name)) continue;
    const xml = await zip.file(name).async("string");
    const fixed = fillRectToSrcRect(xml);
    if (fixed !== xml) {
      zip.file(name, fixed);
      changed = true;
    }
  }
  if (!changed) return false;
  // STORE: the pictures are already compressed, and this copy only lives for the conversion.
  fs.writeFileSync(destPath, await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }));
  return true;
}

module.exports = { normalizePptx, fillRectToSrcRect, toSrcRect };
