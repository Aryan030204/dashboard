// Token parity: src/styles/datum-tokens.css must define exactly the same values as src/design/tokens.js.
// Run with: node --test src/design/tokens.parity.node.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LIGHT, DARK } from "./tokens.js";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "styles", "datum-tokens.css"), "utf8");

// Split the stylesheet into the :root block and the dark block.
const darkStart = css.indexOf(":root.dark");
assert.ok(darkStart > 0, "dark block present in CSS");
const lightCss = css.slice(0, darkStart);
const darkCss = css.slice(darkStart);

const parseVars = (block) => {
  const out = {};
  for (const m of block.matchAll(/--dz-([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
};

const norm = (v) => String(v).replace(/\s+/g, " ").trim().toLowerCase();

const compare = (name, cssVars, tokens) => {
  test(`${name}: every JS token exists in CSS with the same value`, () => {
    for (const [key, value] of Object.entries(tokens)) {
      assert.ok(key in cssVars, `${name}: --dz-${key} missing in CSS`);
      assert.equal(norm(cssVars[key]), norm(value), `${name}: --dz-${key} differs`);
    }
  });
  test(`${name}: CSS has no color token that JS lacks`, () => {
    const nonColor = new Set(["font", "font-mono", "r-panel", "r-control", "r-tag"]);
    for (const key of Object.keys(cssVars)) {
      if (nonColor.has(key)) continue;
      assert.ok(key in tokens, `${name}: --dz-${key} in CSS but not in tokens.js`);
    }
  });
};

compare("light", parseVars(lightCss), LIGHT);
compare("dark", parseVars(darkCss), DARK);

test("light and dark define the same token names", () => {
  assert.deepEqual(Object.keys(LIGHT).sort(), Object.keys(DARK).sort());
});
