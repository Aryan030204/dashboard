const fs = require("fs");
const JSZip = require("jszip");
const sharp = require("sharp");

// Some exporters (Canva, Google Slides) draw a small piece of a big picture by giving the shape a picture fill
// whose <a:fillRect> has huge negative insets, e.g. l="-64339" r="-2199969": "the picture is 23x as wide as this
// shape, and the shape shows the part that falls inside it". PowerPoint honours that. LibreOffice does not: it
// paints the whole picture, which is how a thin green underline turned into a full slide of unrelated content.
//
// Rather than rely on how LibreOffice reads some other form of the same crop, the visible part is cut out of the
// picture here and the shape is given that small picture with a plain stretch fill, which every renderer handles.
// Only the extreme cases are touched; ordinary fills are left exactly as they were.

const BLIP_FILL = /<(a|p):blipFill\b[\s\S]*?<\/\1:blipFill>/g;
const STRETCH_FILL_RECT = /<a:stretch>\s*<a:fillRect([^>]*?)\/>\s*<\/a:stretch>/;
const EMBED = /<a:blip\b[^>]*\br:embed="([^"]+)"/;
const PART = /^ppt\/(slides|slideLayouts|slideMasters)\/([^/]+\.xml)$/;
const IMAGE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

// Insets are in 1/1000 percent of the shape: -100000 = the picture sticks out by one whole shape width/height.
const EXTREME_INSET = 100000;

function readInsets(attrs) {
  const insets = { l: 0, t: 0, r: 0, b: 0 };
  for (const [, key, value] of attrs.matchAll(/\b([ltrb])="(-?\d+)"/g)) insets[key] = Number(value);
  return insets;
}

// The part of the picture (fractions 0..1 of its width/height) that falls inside the shape, or null when this
// fill is not an extreme overhang. Negative inset = the picture sticks out of the shape on that side.
function visibleRegion({ l, t, r, b }) {
  if (l > 0 || t > 0 || r > 0 || b > 0) return null;
  if (Math.min(l, t, r, b) > -EXTREME_INSET) return null;
  const width = 100000 - l - r; // the whole picture, as a share of the shape's width (x100000)
  const height = 100000 - t - b;
  return {
    left: -l / width,
    top: -t / height,
    width: 100000 / width,
    height: 100000 / height,
  };
}

async function cropPicture(buffer, region) {
  const image = sharp(buffer);
  const { width, height } = await image.metadata();
  const left = Math.min(width - 1, Math.max(0, Math.floor(region.left * width)));
  const top = Math.min(height - 1, Math.max(0, Math.floor(region.top * height)));
  return image
    .extract({
      left,
      top,
      width: Math.max(1, Math.min(width - left, Math.ceil(region.width * width))),
      height: Math.max(1, Math.min(height - top, Math.ceil(region.height * height))),
    })
    .png()
    .toBuffer();
}

function relsNameFor(partName) {
  const [, dir, file] = PART.exec(partName);
  return `ppt/${dir}/_rels/${file}.rels`;
}

// Writes a copy of the presentation with the extreme picture crops cut out of their pictures. Returns true when a
// copy was written, false when the file needed no change (the caller then keeps using the original).
async function normalizePptx(sourcePath, destPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const made = new Map(); // "<media>|<region>" -> new media path, so repeated crops are cut once
  let changed = false;
  let counter = 0;

  for (const name of Object.keys(zip.files)) {
    if (!PART.test(name)) continue;
    const relsName = relsNameFor(name);
    const relsFile = zip.file(relsName);
    if (!relsFile) continue;
    const xml = await zip.file(name).async("string");
    if (!/<a:fillRect[^>]*-\d{6,}/.test(xml)) continue; // cheap check: nothing extreme in this part

    let rels = await relsFile.async("string");
    const targets = new Map();
    for (const tag of rels.match(/<Relationship\b[^>]*>/g) || []) {
      const id = /\bId="([^"]+)"/.exec(tag);
      const target = /\bTarget="([^"]+)"/.exec(tag);
      if (id && target) targets.set(id[1], target[1]);
    }

    const replacements = [];
    for (const match of xml.matchAll(BLIP_FILL)) {
      const block = match[0];
      const fillRect = STRETCH_FILL_RECT.exec(block);
      const embed = EMBED.exec(block);
      if (!fillRect || !embed || block.includes("<a:srcRect")) continue;
      const region = visibleRegion(readInsets(fillRect[1]));
      const target = targets.get(embed[1]);
      if (!region || !target || /^https?:/i.test(target)) continue;

      const mediaPath = target.startsWith("/") ? target.slice(1) : `ppt/${target.replace(/^\.\.\//, "")}`;
      const media = zip.file(mediaPath);
      if (!media) continue;

      const key = `${mediaPath}|${region.left.toFixed(6)}|${region.top.toFixed(6)}|${region.width.toFixed(6)}|${region.height.toFixed(6)}`;
      let cropped = made.get(key);
      if (!cropped) {
        counter += 1;
        cropped = { path: `ppt/media/crop-${counter}.png`, id: `rIdCrop${counter}` };
        zip.file(cropped.path, await cropPicture(await media.async("nodebuffer"), region));
        made.set(key, cropped);
      }
      replacements.push({ block, embed: embed[1], cropped });
    }
    if (replacements.length === 0) continue;

    let fixed = xml;
    for (const { block, embed, cropped } of replacements) {
      const next = block
        .replace(`r:embed="${embed}"`, `r:embed="${cropped.id}"`)
        .replace(STRETCH_FILL_RECT, "<a:stretch><a:fillRect/></a:stretch>");
      fixed = fixed.replace(block, () => next);
      if (!rels.includes(`Id="${cropped.id}"`)) {
        rels = rels.replace(
          "</Relationships>",
          `<Relationship Id="${cropped.id}" Type="${IMAGE_REL}" Target="../media/${cropped.path.split("/").pop()}"/></Relationships>`,
        );
      }
    }
    zip.file(name, fixed);
    zip.file(relsName, rels);
    changed = true;
  }

  if (!changed) return false;
  // STORE: the pictures are already compressed, and this copy only lives for the conversion.
  fs.writeFileSync(destPath, await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }));
  return true;
}

module.exports = { normalizePptx, visibleRegion };
