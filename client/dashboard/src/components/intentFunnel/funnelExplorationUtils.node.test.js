import test from "node:test";
import assert from "node:assert/strict";
import {
  FUNNEL_STEPS,
  PRODUCT_COLORS,
  computeFunnelLayout,
  selectTopProducts,
  stepRate,
} from "./funnelExplorationUtils.js";

const products = [
  { id: "1", name: "Build Your Own Small Box", views: 3070, addToCart: 120, checkouts: 148 },
  { id: "2", name: "Founder's Pick", views: 1423, addToCart: 467, checkouts: 170 },
  { id: "3", name: "Bestseller Combo", views: 1057, addToCart: 192, checkouts: 86 },
  { id: "4", name: "Perfume Gift Set", views: 769, addToCart: 156, checkouts: 85 },
  { id: "5", name: "Never Viewed", views: 0, addToCart: 5, checkouts: 1 },
];

test("selectTopProducts ranks by views, drops unviewed products and assigns stable colours", () => {
  const top = selectTopProducts(products, 3);
  assert.deepEqual(top.map((p) => p.id), ["1", "2", "3"]);
  assert.deepEqual(top.map((p) => p.color), PRODUCT_COLORS.slice(0, 3));
  assert.equal(selectTopProducts(products, 10).length, 4);
  assert.equal(selectTopProducts(products, 0).length, 0);
  assert.deepEqual(selectTopProducts(null, 5), []);
});

test("selectTopProducts breaks ties by name and tolerates bad numbers", () => {
  const top = selectTopProducts(
    [
      { id: "b", name: "B", views: 10, addToCart: "x", checkouts: null },
      { id: "a", name: "A", views: 10, addToCart: -3, checkouts: 2 },
    ],
    5,
  );
  assert.deepEqual(top.map((p) => p.id), ["a", "b"]);
  assert.equal(top[1].addToCart, 0);
  assert.equal(top[0].addToCart, 0);
});

test("stepRate is the share of the previous step, and null with nothing to compare", () => {
  assert.equal(stepRate(200, 50), 25);
  assert.equal(stepRate(0, 10), null);
  assert.equal(stepRate(undefined, 10), null);
});

test("layout puts one node per product and step, stacked without overlap", () => {
  const layout = computeFunnelLayout(selectTopProducts(products, 4));
  assert.equal(layout.nodes.length, 4 * FUNNEL_STEPS.length);
  FUNNEL_STEPS.forEach((_, stepIndex) => {
    const column = layout.nodes.filter((node) => node.stepIndex === stepIndex);
    for (let i = 1; i < column.length; i += 1) {
      assert.ok(column[i].y >= column[i - 1].y + column[i - 1].height, `step ${stepIndex}, row ${i}`);
    }
  });
});

test("node heights share one scale, and a non-zero value is never thinner than the minimum", () => {
  const layout = computeFunnelLayout(selectTopProducts(products, 4), { minNode: 16 });
  const stepOne = layout.nodes.filter((node) => node.stepIndex === 0);
  // the 1st step is the tallest column; two nodes that are both above the minimum scale linearly
  const [a, b] = stepOne;
  const ratioHeights = a.height / b.height;
  const ratioValues = a.value / b.value;
  assert.ok(Math.abs(ratioHeights - ratioValues) < 0.001);
  layout.nodes.forEach((node) => assert.ok(node.height >= 16));
});

test("every ribbon connects the same product between neighbouring steps", () => {
  const layout = computeFunnelLayout(selectTopProducts(products, 4));
  assert.equal(layout.links.length, 4 * (FUNNEL_STEPS.length - 1));
  layout.links.forEach((link) => {
    assert.equal(link.toStep, link.fromStep + 1);
    assert.match(link.d, /^M .+ Z$/);
    assert.ok(!link.d.includes("NaN"));
  });
});

test("a product with no add to cart has no ribbon past its first step", () => {
  const layout = computeFunnelLayout(
    selectTopProducts([{ id: "9", name: "Solo", views: 50, addToCart: 0, checkouts: 3 }], 5),
  );
  assert.equal(layout.nodes.filter((n) => n.stepIndex === 1).length, 0);
  assert.equal(layout.links.length, 0);
});

test("the drawing is tall enough for its tallest column and handles no products", () => {
  const layout = computeFunnelLayout(selectTopProducts(products, 4));
  const bottom = Math.max(...layout.nodes.map((node) => node.y + node.height));
  assert.ok(layout.height >= bottom);
  const empty = computeFunnelLayout([]);
  assert.equal(empty.nodes.length, 0);
  assert.ok(Number.isFinite(empty.height));
});
