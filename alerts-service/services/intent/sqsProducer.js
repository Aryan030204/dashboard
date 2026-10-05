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

const {
  readPublisherConfig,
  createSemaphore,
  isRetryableSqsError,
  backoffDelayMs,
  createRateLimitedLogger,
} = require("./sqsPublisher");

const SQS_MESSAGE_LIMIT_BYTES = 256 * 1024;
const STATS_INTERVAL_MS = 60000;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Direct /track → SQS producer for SQS mode. No Mongo, no session state, no
// outbox, no ATC dedupe. Each accepted request yields one contract message.
// Session fields are null here; the session logic moves to the consumer later.
//
// Every SendMessage goes through a bounded publisher: at most maxConcurrency in
// flight, at most maxPending waiting, each waiter gives up after maxWaitMs. A
// send that cannot get a slot in time fails with 503. Retries of transient
// errors run outside the slot and are capped at maxAttempts.
//
// Duplicate possibility: if SendMessage succeeds on SQS but the response is lost,
// the retry sends the same body again. The event_id is unchanged, so downstream
// ON DUPLICATE KEY on event_id absorbs the duplicate. No new dedupe is added here.
function createIntentSqsProducer({
  getBrandTimezone,
  sendRaw,
  queueUrl,
  sqsMessageLimitBytes = SQS_MESSAGE_LIMIT_BYTES,
  logger,
  config = readPublisherConfig(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  statsIntervalMs = STATS_INTERVAL_MS,
}) {
  const semaphore = createSemaphore(config);
  const logError = createRateLimitedLogger(logger, { windowMs: config.logWindowMs });
  const counters = { sent: 0, failed: 0, retries: 0, rejectedSaturated: 0 };

  if (statsIntervalMs > 0) {
    const timer = setInterval(() => {
      logger?.info?.(`[intent-sqs-stats] ${JSON.stringify({ ...counters, ...semaphore.snapshot() })}`);
    }, statsIntervalMs);
    timer.unref?.();
  }

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
    const messageId = await sendWithRetry({ serialized, message, brand, bytes });
    return { event_id: message.event_id, type: message.type, messageId };
  }

  async function sendWithRetry({ serialized, message, brand, bytes }) {
    const started = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      try {
        const messageId = await semaphore.run(() => sendRaw(serialized, { queueUrl }));
        counters.sent += 1;
        logger?.info?.(
          `[intent-sqs] accepted type=${message.type} event_id=${message.event_id} brand=${brand} ` +
            `MessageId=${messageId} attempts=${attempt} latency_ms=${Date.now() - started}`,
        );
        return messageId;
      } catch (err) {
        if (err?.code === "PRODUCER_SATURATED") {
          counters.rejectedSaturated += 1;
          logError("saturated", `[intent-sqs] rejected: producer saturated event_id=${message.event_id} brand=${brand}`);
          throw httpError(503, "Failed to queue event");
        }
        const retryable = isRetryableSqsError(err);
        if (!retryable || attempt >= config.maxAttempts) {
          counters.failed += 1;
          logError(
            `${err?.name}|${err?.code}|${err?.$metadata?.httpStatusCode}`,
            `[intent-sqs] SendMessage failed type=${message.type} event_id=${message.event_id} brand=${brand}: ` +
              `${err?.name || "Error"} ${err?.message || ""} ` +
              JSON.stringify({
                queueUrl,
                region: process.env.AWS_REGION || "ap-south-1",
                messageBytes: bytes,
                attempts: attempt,
                retryable,
                errName: err?.name ?? null,
                errCode: err?.code ?? null,
                errFault: err?.$fault ?? null,
                httpStatusCode: err?.$metadata?.httpStatusCode ?? null,
              }),
          );
          throw httpError(503, "Failed to queue event");
        }
        counters.retries += 1;
        await sleep(backoffDelayMs(attempt, config, random));
      }
    }
  }

  function stats() {
    return { ...counters, ...semaphore.snapshot() };
  }

  return { publish, buildMessage, stats };
}

module.exports = { createIntentSqsProducer, SQS_MESSAGE_LIMIT_BYTES };
