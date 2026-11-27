import test from "node:test";
import assert from "node:assert/strict";
import { blockedFilters, changedFilters } from "./mobileFilters.js";

const ALL = { id: "", label: "All products" };
const none = {
  product: [ALL],
  utm: { source: [], medium: [], campaign: [], term: [], content: [] },
  salesChannel: [],
  city: [],
  deviceType: [],
  productType: [],
  discountCode: "",
};
const pick = (extra) => ({ ...none, ...extra });

test("choosing only a discount code applies only the discount code", () => {
  assert.deepEqual(changedFilters(pick({ discountCode: "SAVE10" }), none), ["discountCode"]);
});

test("nothing changed means nothing is applied, whatever shape 'not set' takes", () => {
  const sameButWrittenDifferently = pick({ product: ALL, salesChannel: "", utm: { source: "", medium: "", campaign: "" } });
  assert.deepEqual(changedFilters(sameButWrittenDifferently, none), []);
  const applied = pick({ product: [{ id: "7" }], city: ["Pune", "Delhi"] });
  assert.deepEqual(changedFilters(pick({ product: { id: "7" }, city: ["Delhi", "Pune"] }), applied), []);
});

test("the discount code is applied after the filters it replaces", () => {
  assert.deepEqual(changedFilters(pick({ discountCode: "X" }), pick({ city: ["Pune"] })), ["city", "discountCode"]);
});

test("each exclusive filter locks out all the others but not itself", () => {
  const cases = {
    discountCode: "X",
    salesChannel: "web",
    city: ["Pune"],
    deviceType: ["Mobile"],
    productType: ["Perfume"],
  };
  for (const [key, value] of Object.entries(cases)) {
    const blocked = blockedFilters(pick({ [key]: value }));
    assert.equal(blocked[key], false, key);
    for (const other of Object.keys(cases).filter((k) => k !== key)) assert.equal(blocked[other], true, `${key}/${other}`);
    assert.ok(blocked.product && blocked.utm, key);
  }
});

test("product and UTM follow the sync permission", () => {
  const product = pick({ product: [{ id: "7" }] });
  assert.equal(blockedFilters(product).utm, true);
  assert.equal(blockedFilters(product, { canSync: true }).utm, false);
  assert.equal(blockedFilters(product, { canSync: true }).utmMediumCampaign, true);
  const source = pick({ utm: { source: ["google"] } });
  assert.equal(blockedFilters(source).product, true);
  assert.equal(blockedFilters(source, { canSync: true }).product, false);
  assert.equal(blockedFilters(source, { canSync: true }).discountCode, true);
  assert.ok(Object.values(blockedFilters(none)).every((value) => value === false));
});
