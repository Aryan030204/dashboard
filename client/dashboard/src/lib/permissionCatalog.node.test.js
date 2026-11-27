import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ALL_OPTIONS,
  GROUPS,
  RETIRED,
  optionHint,
  optionLabel,
  optionState,
  permissionNames,
  selectedOptions,
  toggleOption,
} from "./permissionCatalog.js";

const source = readFileSync(new URL("../../../../api-gateway/src/constants/permissions.js", import.meta.url), "utf8");
const SERVER_IDS = [...source.slice(source.indexOf("["), source.indexOf("]")).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const [summary, funnel] = GROUPS;

test("every permission the server knows has a name and a way to be given, or is retired", () => {
  assert.ok(SERVER_IDS.length > 40);
  const grouped = GROUPS.flatMap((group) => group.members);
  for (const id of SERVER_IDS) {
    const places = [ALL_OPTIONS.includes(id), grouped.includes(id), RETIRED.includes(id)].filter(Boolean).length;
    assert.equal(places, 1, `${id} is offered ${places} times`);
    assert.notEqual(optionLabel(id), id, `${id} has no name`);
  }
  // and nothing is offered that the server would reject
  for (const id of [...grouped, ...ALL_OPTIONS.filter((o) => !o.startsWith("group:"))]) assert.ok(SERVER_IDS.includes(id), id);
});

test("the groups hold what was agreed", () => {
  assert.equal(summary.members.length, 6);
  assert.equal(funnel.members.length, 14);
  assert.ok(!funnel.members.includes("product_conversion"), "the page itself stays a separate tick");
});

test("a group is off, partial or full, and one click gives all, the next removes all", () => {
  const partial = ["utm_filter", "traffic_split"];
  assert.equal(optionState(summary.key, ["utm_filter"]), "off");
  assert.equal(optionState(summary.key, partial), "partial");
  const full = toggleOption(summary.key, partial);
  assert.equal(optionState(summary.key, full), "full");
  assert.equal(new Set(full).size, full.length);
  assert.deepEqual(toggleOption(summary.key, full), ["utm_filter"]);
  assert.deepEqual(toggleOption("utm_filter", partial), ["traffic_split"]);
});

test("display collapses a group into one entry and leaves the stored ids alone", () => {
  const permissions = ["product_conversion", "product_conversion:drr", "ci_events", "product_conversion:doh", "intent_metrics", "mystery"];
  const before = [...permissions];
  assert.deepEqual(selectedOptions(permissions), [
    "product_conversion", funnel.key, summary.key, "intent_metrics", "mystery",
  ]);
  assert.deepEqual(permissionNames(permissions), [
    "Product Conversion Dashboard",
    "Filters for Product Funnel (partial)",
    "Summary Extras (partial)",
    "Intent Metrics (retired)",
    "mystery",
  ]);
  assert.equal(optionHint(funnel.key, permissions), "Has only: DRR, DOH");
  assert.deepEqual(permissions, before);
  assert.deepEqual(permissionNames(summary.members), ["Summary Extras"]);
});
