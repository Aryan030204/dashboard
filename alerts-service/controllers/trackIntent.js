const { normalizeIntentBody, classifyClick } = require("../services/intent/normalize");
const { toStoreLocalOccurredAt } = require("../services/intent/timezone");
const { resolveProductId } = require("../services/intent/productResolution");
const {
  buildEventMessage,
  buildClickMessage,
  validateMessage,
  serializeMessage,
  messageBytes,
} = require("../services/intent/messageContract");
const { TOPICS, isKafkaEvent, topicForEvent, messageKey } = require("../services/intent/topicRouting");

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_ID_LENGTH = 100;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Only payloads whose event_name is on the Kafka list (topicRouting.KAFKA_EVENTS) take
// the Kafka path. Everything else, including the CI pixel (it sends event_type, not
// event_name) and event names such as checkout_initiated, buy_now and add_to_cart,
// falls through to the legacy Mongo handler.
function isIntentEvent(body) {
  return isKafkaEvent(body?.event_name);
}

// Builds the normalized contract message (schema_version 1). Pure: no I/O.
function buildIntentMessage(body, brand, brandTimezone) {
  const { kind, e, when, actorId } = normalizeIntentBody(body);
  const common = {
    brand_id: brand,
    event_id: e.event_id, // preserved exactly as the pixel sent it
    event_name: e.event_name,
    actor_id: actorId,
    client_id: e.client_id || null,
    visitor_id: e.visitor_id || null,
    session_id: null,
    occurred_at: toStoreLocalOccurredAt(when, brandTimezone),
    url: e.url || null,
    referrer: e.referrer || null,
    user_agent: e.user_agent || null,
    session_start: null,
    session_end: null,
    session_time_spent: null,
  };

  if (kind === "click") {
    return buildClickMessage({
      ...common,
      click: e.data.click,
      signals: e.data.signals,
      click_bucket: classifyClick(e.data.signals),
      raw: e,
    });
  }

  let raw = e.data ?? null;
  if (topicForEvent(e.event_name) === TOPICS.ATC) {
    raw = { ...(e.data || {}), product_id: resolveProductId(brand, null, e) };
  }
  return buildEventMessage({ ...common, raw });
}

// Express middleware for POST /track. Handles intent events and calls next() for
// everything else.
function createIntentTrack({ publisher, brandAllowlist, logger }) {
  async function handle(req, res) {
    const body = req.body || {};
    const brand = typeof body.brand_id === "string" ? body.brand_id : null;
    const ctx = { event_id: body.event_id ?? null, brand, event_name: body.event_name };

    if (!brandAllowlist) {
      logger.error("[track] intent ingestion is not configured (brand allow-list invalid)");
      return res.status(503).json({ error: "Failed to queue event" });
    }
    if (!brand || !brandAllowlist.isKnownBrand(brand)) {
      return res.status(400).json({ error: "unknown or inactive brand_id" });
    }

    let message;
    try {
      message = buildIntentMessage(body, brand, brandAllowlist.getBrand(brand)?.store_timezone_iana ?? null);
      const problems = validateMessage(message);
      if (problems.length) throw httpError(400, problems.join("; "));
      const longIds = ["actor_id", "client_id"].filter(
        (f) => typeof message[f] === "string" && message[f].length > MAX_ID_LENGTH,
      );
      if (longIds.length) throw httpError(400, `${longIds.join(", ")} longer than ${MAX_ID_LENGTH} characters`);
      if (messageBytes(message) > MAX_MESSAGE_BYTES) throw httpError(413, "Event payload too large");
    } catch (err) {
      if (err?.status === 413) return res.status(413).json({ error: "Event payload too large" });
      if (err?.status === 400) {
        logger.warn(
          `[track] rejected intent event event_id=${ctx.event_id} brand=${brand} event_name=${ctx.event_name}: ${err.message}`,
        );
        return res.status(400).json({ error: "invalid event payload" });
      }
      throw err;
    }

    const topic = topicForEvent(message.event_name);
    try {
      const ack = await publisher.publish({
        topic,
        key: messageKey(message),
        value: serializeMessage(message),
      });
      logger.info(
        `[track] kafka ack event_id=${message.event_id} brand=${brand} event_name=${message.event_name} ` +
          `topic=${topic} partition=${ack.partition} offset=${ack.offset}`,
      );
      return res.status(202).json({ message: "Event accepted", event_id: message.event_id });
    } catch (err) {
      logger.error(
        `[track] kafka publish failed event_id=${message.event_id} brand=${brand} event_name=${message.event_name} ` +
          `topic=${topic} category=${err?.category || "unknown"}: ${err?.message}`,
      );
      return res.status(503).json({ error: "Failed to queue event" });
    }
  }

  return function intentTrack(req, res, next) {
    if (!isIntentEvent(req.body)) return next();
    handle(req, res).catch((err) => {
      logger.error("[track] unexpected intent error:", err);
      if (!res.headersSent) res.status(500).json({ error: "Failed to track alert" });
    });
  };
}

module.exports = { createIntentTrack, buildIntentMessage, isIntentEvent };
