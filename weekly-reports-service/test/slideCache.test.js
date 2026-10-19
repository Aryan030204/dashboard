const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSlideCache } = require("../src/services/slideCache");

test("the slide cache evicts the least recently used entry", () => {
  const c = buildSlideCache(2);
  c.set("a", 1); c.set("b", 2); c.get("a"); c.set("c", 3);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  assert.equal(c.size, 2);
});
