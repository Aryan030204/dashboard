// Single place that maps an intent event to a Kafka topic (an event category, not one
// topic per event name) and to its Kafka message key. To route a new event name to an
// existing category, add it to KAFKA_EVENTS. Topics themselves are created by
// kafka-service/topics.conf, never from /track.

const TOPICS = Object.freeze({
  CHECKOUT: "intent.checkout",
  ATC: "intent.atc",
  CLICK: "intent.click",
  OTHER: "intent.other",
});

// Events that go to Kafka (the Shopify web pixel standard events). Anything not listed
// here, such as checkout_initiated, buy_now and add_to_cart, stays on the legacy Mongo
// path in /track.
const KAFKA_EVENTS = new Set([
  "checkout_started",
  "product_added_to_cart",
  "click",
  "product_viewed",
  "collection_viewed",
  "checkout_completed",
  "page_viewed",
  "product_removed_from_cart",
  "scroll_depth",
]);

function isKafkaEvent(eventName) {
  return typeof eventName === "string" && KAFKA_EVENTS.has(eventName);
}

// Bucketing by name, first match wins:
//   contains "checkout"                      -> intent.checkout
//   contains "add_to_cart" or "added_to_cart" -> intent.atc
//   contains "click"                         -> intent.click
//   everything else                          -> intent.other
function topicForEvent(eventName) {
  const name = String(eventName || "");
  if (name.includes("checkout")) return TOPICS.CHECKOUT;
  if (name.includes("add_to_cart") || name.includes("added_to_cart")) return TOPICS.ATC;
  if (name.includes("click")) return TOPICS.CLICK;
  return TOPICS.OTHER;
}

// Kafka hashes the key to pick a partition, so the same actor always lands on the same
// partition (ordering per actor) without a partition per actor. Actor identity is the
// existing rule, actor_id || client_id. With neither, the key falls back to the
// event_id: deterministic for that event, and spread evenly across partitions.
function messageKey(message) {
  const identity = message.actor_id || message.client_id;
  if (identity) return `${message.brand_id}:${identity}`;
  return `${message.brand_id}:event:${message.event_id}`;
}

module.exports = { TOPICS, KAFKA_EVENTS, isKafkaEvent, topicForEvent, messageKey };
