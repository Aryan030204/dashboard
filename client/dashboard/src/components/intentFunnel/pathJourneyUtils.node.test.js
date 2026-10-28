import test from "node:test";
import assert from "node:assert/strict";
import { highlightJourney, linkShare } from "./pathJourneyUtils.js";

// 0 -> 2, 1 -> 2, 2 -> 3, 2 -> 4, and a separate 5 -> 6
const links = [
  { source: 0, target: 2 },
  { source: 1, target: 2 },
  { source: 2, target: 3 },
  { source: 2, target: 4 },
  { source: 5, target: 6 },
];

const sorted = (set) => [...set].sort((a, b) => a - b);

test("nothing hovered means nothing is dimmed", () => {
  assert.equal(highlightJourney(links, null), null);
  assert.equal(highlightJourney(null, { type: "node", index: 1 }), null);
});

test("a node highlights every path into it and every path on from it, and nothing unrelated", () => {
  const journey = highlightJourney(links, { type: "node", index: 2 });
  assert.deepEqual(sorted(journey.nodes), [0, 1, 2, 3, 4]);
  assert.deepEqual(sorted(journey.links), [0, 1, 2, 3]);
});

test("a node at the end only highlights the paths that lead to it", () => {
  const journey = highlightJourney(links, { type: "node", index: 3 });
  assert.deepEqual(sorted(journey.nodes), [0, 1, 2, 3]);
  // the sibling branch 2 -> 4 is not part of the journey to node 3
  assert.deepEqual(sorted(journey.links), [0, 1, 2]);
});

test("a node at the start only highlights what follows it", () => {
  const journey = highlightJourney(links, { type: "node", index: 0 });
  assert.deepEqual(sorted(journey.nodes), [0, 2, 3, 4]);
  assert.deepEqual(sorted(journey.links), [0, 2, 3]);
});

test("a link highlights the paths into its source, itself, and the paths on from its target", () => {
  const journey = highlightJourney(links, { type: "link", index: 3 }); // 2 -> 4
  assert.deepEqual(sorted(journey.nodes), [0, 1, 2, 4]);
  assert.deepEqual(sorted(journey.links), [0, 1, 3]);
});

test("a separate journey is never highlighted together with another", () => {
  const journey = highlightJourney(links, { type: "node", index: 5 });
  assert.deepEqual(sorted(journey.nodes), [5, 6]);
  assert.deepEqual(sorted(journey.links), [4]);
});

test("an unknown link or an isolated node is handled", () => {
  assert.equal(highlightJourney(links, { type: "link", index: 99 }), null);
  const lone = highlightJourney(links, { type: "node", index: 42 });
  assert.deepEqual(sorted(lone.nodes), [42]);
  assert.deepEqual(sorted(lone.links), []);
});

test("linkShare is the share of the source's sessions, capped at 100, null without a base", () => {
  assert.equal(linkShare({ source: { value: 200 }, value: 50 }), 25);
  assert.equal(linkShare({ source: { value: 10 }, value: 50 }), 100);
  assert.equal(linkShare({ source: { value: 0 }, value: 5 }), null);
  assert.equal(linkShare({ value: 5 }), null);
});
