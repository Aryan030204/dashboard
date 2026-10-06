const dns = require("dns");
const { monitorEventLoopDelay } = require("perf_hooks");
const { Kafka, logLevel, CompressionTypes } = require("kafkajs");

// One shared Kafka producer for alerts-service. /track success means Kafka acknowledged
// the message (acks=all). There is no application queue: at most maxInFlight sends are
// outstanding, and anything beyond that fails immediately, so memory cannot grow while
// Kafka is slow or down. Every send also has a hard deadline, so a hung broker cannot
// hold a request open.

const DEFAULTS = Object.freeze({
  brokers: "kafka-service:9092",
  clientId: "alerts-service",
  sendTimeoutMs: 5000,
  maxInFlight: 500,
  connectionTimeoutMs: 3000,
});

function intFromEnv(env, name, fallback) {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readKafkaConfig(env = process.env) {
  const brokers = (env.KAFKA_BOOTSTRAP_SERVERS || DEFAULTS.brokers)
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
  return {
    brokers,
    clientId: (env.KAFKA_CLIENT_ID || DEFAULTS.clientId).trim(),
    sendTimeoutMs: intFromEnv(env, "INTENT_KAFKA_SEND_TIMEOUT_MS", DEFAULTS.sendTimeoutMs),
    maxInFlight: intFromEnv(env, "INTENT_KAFKA_MAX_INFLIGHT", DEFAULTS.maxInFlight),
    connectionTimeoutMs: DEFAULTS.connectionTimeoutMs,
  };
}

class KafkaPublishError extends Error {
  constructor(category, message) {
    super(message);
    this.name = "KafkaPublishError";
    this.category = category; // saturated | timeout | unavailable | rejected
  }
}

function categorize(err) {
  const name = err?.name || "";
  if (name === "KafkaJSNumberOfRetriesExceeded" || name === "KafkaJSConnectionError") return "unavailable";
  if (name === "KafkaJSRequestTimeoutError" || name === "KafkaJSTimeout") return "timeout";
  if (name === "KafkaJSProtocolError" || name === "KafkaJSNonRetriableError") return "rejected";
  return "unavailable";
}

// `kafka` and `sleep` are injectable for tests. The default builds a kafkajs client.
function createKafkaPublisher({ config = readKafkaConfig(), logger, kafka, statsIntervalMs = 60000, resetMinIntervalMs = 5000 } = {}) {
  const client =
    kafka ||
    new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
      logLevel: logLevel.NOTHING,
      connectionTimeout: config.connectionTimeoutMs,
      requestTimeout: config.sendTimeoutMs,
      retry: { initialRetryTime: 100, maxRetryTime: 1000, retries: 2 },
    });

  let producer = client.producer({ allowAutoTopicCreation: false });
  let connected = false;
  let lastReset = 0;
  let connecting = null;
  let inFlight = 0;
  let closing = false;
  const counters = { published: 0, failed: 0, rejectedSaturated: 0, resets: 0 };

  function watch(p) {
    p.on?.(p.events?.DISCONNECT ?? "producer.disconnect", () => {
      if (p === producer) connected = false;
    });
  }
  watch(producer);

  // Throws the producer away and builds a new one. Used when connects keep failing, so a
  // wedged client state can never outlive the outage that caused it. The old producer is
  // disconnected in the background and never awaited.
  function resetProducer(reason) {
    const now = Date.now();
    if (closing || now - lastReset < resetMinIntervalMs) return;
    lastReset = now;
    const old = producer;
    producer = client.producer({ allowAutoTopicCreation: false });
    watch(producer);
    connected = false;
    connecting = null;
    counters.resets += 1;
    logger?.warn?.(`[kafka] producer rebuilt after repeated failures (${reason})`);
    Promise.resolve(old.disconnect()).catch(() => {});
  }

  function connect() {
    if (connected) return Promise.resolve();
    if (!connecting) {
      connecting = producer
        .connect()
        .then(() => {
          connected = true;
          logger?.info?.(`[kafka] producer connected brokers=${config.brokers.join(",")}`);
        })
        .finally(() => {
          connecting = null;
        });
    }
    return connecting;
  }

  // Non-blocking at startup: tries once, then keeps retrying in the background until it
  // connects. Requests that arrive before that connect on demand (and fail with 5xx).
  function start() {
    const attempt = (delayMs) => {
      connect().catch((err) => {
        logger?.error?.(`[kafka] initial connect failed, retrying in ${delayMs} ms: ${err.message}`);
        if (closing) return;
        const timer = setTimeout(() => attempt(Math.min(delayMs * 2, 15000)), delayMs);
        timer.unref?.();
      });
    };
    attempt(1000);
  }

  function withDeadline(promise, ms) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new KafkaPublishError("timeout", `Kafka send exceeded ${ms} ms`)), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
  }

  // Resolves with { partition, offset } once Kafka has acknowledged the message.
  async function publish({ topic, key, value }) {
    if (closing) throw new KafkaPublishError("unavailable", "producer is shutting down");
    if (inFlight >= config.maxInFlight) {
      counters.rejectedSaturated += 1;
      throw new KafkaPublishError("saturated", "too many in-flight Kafka sends");
    }
    inFlight += 1;
    try {
      const results = await withDeadline(
        (async () => {
          await connect();
          return producer.send({
            topic,
            acks: -1,
            timeout: config.sendTimeoutMs,
            compression: CompressionTypes.None,
            messages: [{ key, value }],
          });
        })(),
        config.sendTimeoutMs,
      );
      counters.published += 1;
      const first = results?.[0] || {};
      return { partition: first.partition ?? null, offset: first.baseOffset ?? first.offset ?? null };
    } catch (err) {
      counters.failed += 1;
      const failure = err instanceof KafkaPublishError ? err : new KafkaPublishError(categorize(err), err?.message || "Kafka publish failed");
      if (failure.category === "unavailable" || failure.category === "timeout") resetProducer(failure.category);
      throw failure;
    } finally {
      inFlight -= 1;
    }
  }

  async function shutdown() {
    closing = true;
    try {
      await producer.disconnect();
    } catch (err) {
      logger?.warn?.(`[kafka] producer disconnect failed: ${err.message}`);
    }
    connected = false;
  }

  function stats() {
    return { ...counters, inFlight, connected };
  }

  // Every statsIntervalMs: counters, event-loop lag since the last tick, and the time one
  // DNS lookup of the broker host takes inside THIS process. A blocked event loop or a
  // saturated DNS threadpool would make every connect time out; this shows whether it is.
  if (statsIntervalMs > 0) {
    const loop = monitorEventLoopDelay({ resolution: 20 });
    loop.enable();
    const timer = setInterval(() => {
      const host = config.brokers[0].split(":")[0];
      const t = Date.now();
      dns.lookup(host, (err) => {
        logger?.info?.(
          `[kafka-stats] ${JSON.stringify({
            ...stats(),
            loop_lag_p99_ms: Math.round(loop.percentile(99) / 1e6),
            loop_lag_max_ms: Math.round(loop.max / 1e6),
            dns_ms: Date.now() - t,
            dns_error: err ? err.code : null,
          })}`,
        );
        loop.reset();
      });
    }, statsIntervalMs);
    timer.unref?.();
  }

  return { start, publish, shutdown, stats };
}

module.exports = { createKafkaPublisher, readKafkaConfig, KafkaPublishError, DEFAULTS };
