const { normalizeIntentBody, classifyClick } = require("./normalize");
const { toStoreLocalOccurredAt } = require("./timezone");
const { resolveProductId } = require("./productResolution");
const {
  buildEventMessage,
  buildClickMessage,
  validateMessage,
  serializeMessage,
  messageBytes,
} = require("./messageContract");

const SQS_MESSAGE_LIMIT_BYTES = 256 * 1024;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Direct /track → SQS producer for SQS mode. No Mongo, no session state, no
// outbox, no ATC dedupe. Each accepted request yields one contract message.
// Session fields are null here; the session logic moves to the consumer later.
function createIntentSqsProducer({
  getBrandTimezone,
  sendRaw,
  queueUrl,
  sqsMessageLimitBytes = SQS_MESSAGE_LIMIT_BYTES,
  logger,
}) {
  function buildMessage(body, brand) {
    const parsed = normalizeIntentBody(body);
    const { kind, e, when, actorId } = parsed;
    const occurredAt = toStoreLocalOccurredAt(when, getBrandTimezone(brand));
    const common = {
      brand_id: brand,
      event_id: e.event_id,
      event_name: e.event_name,
      actor_id: actorId,
      client_id: e.client_id || null,
      visitor_id: e.visitor_id || null,
      session_id: null,
      occurred_at: occurredAt,
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
    if (e.event_name === "product_added_to_cart") {
      const productId = resolveProductId(brand, null, e);
      raw = { ...(e.data || {}), product_id: productId };
    }
    return buildEventMessage({ ...common, raw });
  }

  async function publish(body, brand) {
    const message = buildMessage(body, brand);

    const problems = validateMessage(message);
    if (problems.length) {
      throw httpError(400, `invalid event payload: ${problems.join("; ")}`);
    }

    const bytes = messageBytes(message);
    if (bytes > sqsMessageLimitBytes) {
      logger?.warn?.(`[intent-sqs] rejected event_id=${message.event_id} brand=${brand}: ${bytes} bytes`);
      throw httpError(413, "Event payload too large");
    }

    const serialized = serializeMessage(message);
    let messageId;
    try {
      messageId = await sendRaw(serialized, { queueUrl });
    } catch (err) {
      logger?.error?.(
        `[intent-sqs] SendMessage failed type=${message.type} event_id=${message.event_id} brand=${brand}: ` +
          `${err?.name || "Error"} ${err?.message || ""}`,
      );
      throw httpError(503, "Failed to queue event");
    }

    logger?.info?.(
      `[intent-sqs] accepted type=${message.type} event_id=${message.event_id} brand=${brand} MessageId=${messageId}`,
    );
    return { event_id: message.event_id, type: message.type, messageId };
  }

  return { publish, buildMessage };
}

module.exports = { createIntentSqsProducer, SQS_MESSAGE_LIMIT_BYTES };
