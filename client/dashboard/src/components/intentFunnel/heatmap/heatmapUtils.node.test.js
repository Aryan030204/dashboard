import test from "node:test";
import assert from "node:assert/strict";
import {
  HEATMAP_DEVICE_OPTIONS,
  clickSplit,
  describeElement,
  describePage,
  formatCount,
  formatShare,
  humanizeSlug,
  pageShare,
} from "./heatmapUtils.js";

test("the device filter offers all devices first, then the three the data has", () => {
  assert.deepEqual(
    HEATMAP_DEVICE_OPTIONS.map((option) => option.value),
    ["all", "desktop", "mobile", "tablet"],
  );
});

test("counts group digits the Indian way and tolerate bad input", () => {
  assert.equal(formatCount(9622), "9,622");
  assert.equal(formatCount(1234567), "12,34,567");
  assert.equal(formatCount(null), "0");
  assert.equal(formatCount("abc"), "0");
});

test("shares use one decimal under 10 and none above", () => {
  assert.equal(formatShare(8.88), "8.9%");
  assert.equal(formatShare(60.7), "61%");
  assert.equal(formatShare(0), "0.0%");
  assert.equal(formatShare(undefined), "-");
  assert.equal(formatShare(null), "0.0%");
});

test("slugs read as words, and bad encoding does not throw", () => {
  assert.equal(humanizeSlug("build-your-small-own-box"), "Build your small own box");
  assert.equal(humanizeSlug("perfume_gift+sets"), "Perfume gift sets");
  assert.equal(humanizeSlug("caf%C3%A9-au-lait"), "Café au lait");
  assert.equal(humanizeSlug("100%-off"), "100%-off".replace(/-/g, " ").replace(/^./, "1"));
  assert.equal(humanizeSlug(""), "");
  assert.equal(humanizeSlug(null), "");
});

test("pages are named from their path and the path is always kept", () => {
  assert.deepEqual(describePage("/"), { kind: "Home", label: "Home page", path: "/" });
  assert.deepEqual(describePage("/products/build-your-small-own-box"), {
    kind: "Product", label: "Build your small own box", path: "/products/build-your-small-own-box",
  });
  assert.deepEqual(describePage("/collections/perfume-gift-sets"), {
    kind: "Collection", label: "Perfume gift sets", path: "/collections/perfume-gift-sets",
  });
  assert.deepEqual(describePage("/collections/all/products/x-y"), {
    kind: "Product", label: "X y", path: "/collections/all/products/x-y",
  });
  assert.deepEqual(describePage("/account"), { kind: "Page", label: "Account", path: "/account" });
  assert.equal(describePage("/collections").label, "All collections");
  assert.equal(describePage("").path, "/");
  assert.equal(describePage(undefined).kind, "Home");
});

test("an element is labelled by name, then id, then link, then value, then its tag", () => {
  assert.deepEqual(describeElement({ tag: "a", elementId: "menu", name: "Menu", href: "/cart" }), {
    title: "Menu", subtitle: "a · #menu · /cart",
  });
  assert.equal(describeElement({ tag: "button", elementId: "add-btn" }).title, "add-btn");
  assert.deepEqual(describeElement({ tag: "a", href: "/cart" }), { title: "Link to /cart", subtitle: "a" });
  assert.equal(describeElement({ tag: "BUTTON", value: "Buy now" }).title, "Buy now");
  assert.deepEqual(describeElement({ tag: "IMG" }), { title: "img element", subtitle: "img" });
  assert.deepEqual(describeElement({ tag: "button", type: "submit" }), {
    title: "button element", subtitle: "button · submit",
  });
  assert.deepEqual(describeElement({}), { title: "Unlabelled element", subtitle: "" });
  assert.deepEqual(describeElement(null), { title: "Unlabelled element", subtitle: "" });
});

test("the useful and dead split adds up to 100, or is zero with no clicks", () => {
  assert.deepEqual(clickSplit({ usefulClicks: 25, deadClicks: 75 }), { usefulPct: 25, deadPct: 75 });
  assert.deepEqual(clickSplit({ usefulClicks: 0, deadClicks: 0 }), { usefulPct: 0, deadPct: 0 });
  assert.deepEqual(clickSplit(null), { usefulPct: 0, deadPct: 0 });
  const odd = clickSplit({ usefulClicks: 1, deadClicks: 2 });
  assert.ok(Math.abs(odd.usefulPct + odd.deadPct - 100) < 1e-9);
});

test("a page's share of all page views", () => {
  assert.equal(pageShare(250, 1000), 25);
  assert.equal(pageShare(5, 0), 0);
  assert.equal(pageShare(undefined, 100), 0);
});
