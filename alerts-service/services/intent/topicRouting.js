// Single place that maps an intent event to a Kafka topic (an event category, not one
// topic per event name) and to its Kafka message key. To route a new event name to an
// existing category, add it to EVENT_TOPICS. Topics themselves are created by
// kafka-service/topics.conf, never from /track.

const TOPICS = Object.freeze({
  CHECKOUT: "intent.checkout",
  ATC: "intent.atc",
  CLICK: "intent.click",
  OTHER: "intent.other",
});

const EVENT_TOPICS = Object.freeze({
  checkout_started: TOPICS.CHECKOUT,
  product_added_to_cart: TOPICS.ATC,
  add_to_cart: TOPICS.ATC,
  click: TOPICS.CLICK,
});

function topicForEvent(eventName) {
  return EVENT_TOPICS[eventName] || TOPICS.OTHER;
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

module.exports = { TOPICS, EVENT_TOPICS, topicForEvent, messageKey };
