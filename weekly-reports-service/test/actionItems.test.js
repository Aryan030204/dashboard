// Fireflies returns summary.action_items as one text block; each line becomes one raw pointer.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseActionItems, MAX_ITEMS } = require("../src/services/actionItems");

test("a bulleted block becomes one item per line, kept verbatim", () => {
  const items = parseActionItems("- Follow up with the client about pricing\n- Send the updated deck (12:30)\n");
  assert.deepEqual(items.map((i) => i.originalText), ["Follow up with the client about pricing", "Send the updated deck (12:30)"]);
});

test("numbered and unicode bullets are stripped, blank lines and CRLF are handled", () => {
  const items = parseActionItems("1. First thing\r\n\r\n2) Second thing\r\n• Third thing\r\n* Fourth thing");
  assert.deepEqual(items.map((i) => i.originalText), ["First thing", "Second thing", "Third thing", "Fourth thing"]);
});

test("bold group headings (one per person) are not treated as items", () => {
  const items = parseActionItems("**Alice**\nSend the report (00:12)\nBook the venue (05:30)\n\n**Bob:**\nReview the budget (07:01)");
  assert.deepEqual(items.map((i) => i.originalText), ["Send the report (00:12)", "Book the venue (05:30)", "Review the budget (07:01)"]);
});

test("an empty, missing or non-text value gives no items", () => {
  for (const value of ["", "   \n  ", null, undefined, 42, [], {}]) assert.deepEqual(parseActionItems(value), []);
});

test("source keys are stable and unique, even when two items have the same text", () => {
  const text = "- Call Sam\n- Call Sam\n- Email Priya";
  const first = parseActionItems(text);
  const again = parseActionItems(text);
  assert.deepEqual(first.map((i) => i.sourceKey), again.map((i) => i.sourceKey));
  assert.equal(new Set(first.map((i) => i.sourceKey)).size, 3);
  assert.ok(first.every((i) => i.sourceKey.length <= 64));
});

test("the original text is not rewritten: punctuation, case and inner markdown stay as they are", () => {
  const [item] = parseActionItems("- follow up w/ **Acme** re: Q4 pricing!!");
  assert.equal(item.originalText, "follow up w/ **Acme** re: Q4 pricing!!");
});

test("the number of items is capped", () => {
  const many = Array.from({ length: MAX_ITEMS + 50 }, (_, i) => `- item ${i}`).join("\n");
  assert.equal(parseActionItems(many).length, MAX_ITEMS);
});
