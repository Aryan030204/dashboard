const dns = require("dns");
const { monitorEventLoopDelay } = require("perf_hooks");
const { Kafka, logLevel, CompressionTypes } = require("kafkajs");
const { createSocketFactory } = require("./kafkaDns");

// One shared Kafka producer for alerts-service. /track success means Kafka acknowledged
// the message (acks=all).
//
// Connection management is separate from the request path:
//   - A background loop owns connecting. It has its own timeout and backoff, builds a
//     fresh producer after each failed attempt, and keeps going until Kafka is reachable.
//     Requests never start, wait on, or cancel a connect, so a slow Kafka boot (after a
//     host or container restart) cannot be aborted by request deadlines.
//   - publish() is fast. If the producer is not connected it waits at most connectWaitMs
//     for the loop, then fails with "unavailable" (503). It never queues.
//   - After failureThreshold consecutive connection-type send failures the producer is
//     marked disconnected, and the loop rebuilds and reconnects it.
// There is no application queue: at most maxInFlight sends are outstanding, and anything
// beyond that fails immediately, so memory cannot grow. Every send has a hard deadline.

const DEFAULTS = Object.freeze({
  brokers: "kafka-service:9092",
  clientId: "alerts-service",
  sendTimeoutMs: 5000,
  maxInFlight: 500,
  connectionTimeoutMs: 3000,
  connectTimeoutMs: 15000, // hard limit for one producer.connect() attempt
  connectWaitMs: 1000, // how long a request waits for an in-progress connect
  failureThreshold: 3,
  backoffInitialMs: 500,
  backoffMaxMs: 10000,
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
    connectTimeoutMs: DEFAULTS.connectTimeoutMs,
    connectWaitMs: DEFAULTS.connectWaitMs,
    failureThreshold: DEFAULTS.failureThreshold,
    backoffInitialMs: DEFAULTS.backoffInitialMs,
    backoffMaxMs: DEFAULTS.backoffMaxMs,
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

function withDeadline(promise, ms, makeError) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// `kafka` is injectable for tests. The default builds a kafkajs client.
function createKafkaPublisher({ config: given = readKafkaConfig(), logger, kafka, statsIntervalMs = 60000 } = {}) {
  const config = { ...readKafkaConfig({}), ...given };
  const client =
    kafka ||
    new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
      logLevel: logLevel.NOTHING,
      socketFactory: createSocketFactory(),
      connectionTimeout: config.connectionTimeoutMs,
      requestTimeout: config.sendTimeoutMs,
      retry: { initialRetryTime: 100, maxRetryTime: 1000, retries: 2 },
    });

  let producer = null;
  let connected = false;
  let looping = false;
  let loopWake = null; // resolves the current backoff sleep early
  let consecutiveFailures = 0;
  let inFlight = 0;
  let closing = false;
  const waiters = new Set(); // requests waiting briefly for a connect
  const counters = { published: 0, failed: 0, rejectedSaturated: 0, rebuilds: 0, connects: 0 };

  function buildProducer() {
    const p = client.producer({ allowAutoTopicCreation: false });
    p.on?.(p.events?.DISCONNECT ?? "producer.disconnect", () => {
      if (p === producer) connected = false;
    });
    return p;
  }

  function discard(old) {
    if (old) Promise.resolve(old.disconnect()).catch(() => {});
  }

  function notifyConnected() {
    for (const resolve of waiters) resolve(true);
    waiters.clear();
  }

  // The connect loop. Runs until connected; restarted by markDisconnected(). Each failed
  // attempt discards the producer and builds a new one, then backs off (500 ms doubling to
  // 10 s). Logs are limited to the first failure and every 10th after it.
  async function connectLoop() {
    if (looping || closing) return;
    looping = true;
    let delay = config.backoffInitialMs;
    let failures = 0;
    try {
      while (!closing && !connected) {
        if (!producer) producer = buildProducer();
        const attempt = producer;
        try {
          await withDeadline(
            attempt.connect(),
            config.connectTimeoutMs,
            () => new KafkaPublishError("timeout", `connect exceeded ${config.connectTimeoutMs} ms`),
          );
          if (attempt === producer) {
            connected = true;
            consecutiveFailures = 0;
            counters.connects += 1;
            logger?.info?.(`[kafka] producer connected brokers=${config.brokers.join(",")} after ${failures} failed attempt(s)`);
            notifyConnected();
          }
        } catch (err) {
          failures += 1;
          if (failures === 1 || failures % 10 === 0) {
            logger?.error?.(`[kafka] connect attempt ${failures} failed, retrying in ${delay} ms: ${err.message}`);
          }
          counters.rebuilds += 1;
          producer = null;
          discard(attempt);
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, delay);
            timer.unref?.();
            loopWake = () => (clearTimeout(timer), resolve());
          });
          loopWake = null;
          delay = Math.min(delay * 2, config.backoffMaxMs);
        }
      }
    } finally {
      looping = false;
      if (!closing && !connected) setImmediate(connectLoop);
    }
  }

  function markDisconnected(reason) {
    if (closing || !connected) return;
    connected = false;
    consecutiveFailures = 0;
    const old = producer;
    producer = null;
    counters.rebuilds += 1;
    logger?.warn?.(`[kafka] marking producer disconnected and rebuilding (${reason})`);
    discard(old);
    connectLoop();
  }

  function start() {
    connectLoop();
  }

  function waitForConnect(ms) {
    return new Promise((resolve) => {
      const done = (value) => (clearTimeout(timer), waiters.delete(done), resolve(value));
      const timer = setTimeout(() => done(false), ms);
      timer.unref?.();
      waiters.add(done);
    });
  }

  // Resolves with { partition, offset } once Kafka has acknowledged the message.
  async function publish({ topic, key, value }) {
    if (closing) throw new KafkaPublishError("unavailable", "producer is shutting down");
    if (!connected) {
      connectLoop(); // no-op if already running
      if (!(await waitForConnect(config.connectWaitMs))) {
        counters.failed += 1;
        throw new KafkaPublishError("unavailable", "kafka producer is not connected");
      }
    }
    if (inFlight >= config.maxInFlight) {
      counters.rejectedSaturated += 1;
      throw new KafkaPublishError("saturated", "too many in-flight Kafka sends");
    }
    inFlight += 1;
    const sending = producer;
    try {
      const results = await withDeadline(
        sending.send({
          topic,
          acks: -1,
          timeout: config.sendTimeoutMs,
          compression: CompressionTypes.None,
          messages: [{ key, value }],
        }),
        config.sendTimeoutMs,
        () => new KafkaPublishError("timeout", `Kafka send exceeded ${config.sendTimeoutMs} ms`),
      );
      counters.published += 1;
      consecutiveFailures = 0;
      const first = results?.[0] || {};
      return { partition: first.partition ?? null, offset: first.baseOffset ?? first.offset ?? null };
    } catch (err) {
      counters.failed += 1;
      const failure =
        err instanceof KafkaPublishError ? err : new KafkaPublishError(categorize(err), err?.message || "Kafka publish failed");
      if ((failure.category === "unavailable" || failure.category === "timeout") && sending === producer) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= config.failureThreshold) markDisconnected(failure.category);
      }
      throw failure;
    } finally {
      inFlight -= 1;
    }
  }

  async function shutdown() {
    closing = true;
    loopWake?.();
    notifyConnected();
    const old = producer;
    producer = null;
    connected = false;
    try {
      if (old) await old.disconnect();
    } catch (err) {
      logger?.warn?.(`[kafka] producer disconnect failed: ${err.message}`);
    }
  }

  function stats() {
    return { ...counters, inFlight, connected, consecutiveFailures };
  }

  // Every statsIntervalMs: counters, event-loop lag since the last tick, and the time one
  // DNS lookup of the broker host takes inside THIS process.
  if (statsIntervalMs > 0) {
    const loop = monitorEventLoopDelay({ resolution: 20 });
    loop.enable();
    const timer = setInterval(() => {
      const host = config.brokers[0].split(":")[0];
      const t = Date.now();
      let dnsMs = null; // stays null if the lookup has not returned when the line prints
      let dnsError = null;
      dns.lookup(host, (err) => {
        dnsMs = Date.now() - t;
        dnsError = err ? err.code : null;
      });
      // Printed after 1 s whether or not the lookup finished, so a stuck lookup shows up
      // as dns_ms=null instead of silencing the line.
      const printer = setTimeout(() => {
        logger?.info?.(
          `[kafka-stats] ${JSON.stringify({
            ...stats(),
            loop_lag_p99_ms: Math.round(loop.percentile(99) / 1e6),
            loop_lag_max_ms: Math.round(loop.max / 1e6),
            dns_ms: dnsMs,
            dns_error: dnsError,
          })}`,
        );
        loop.reset();
      }, 1000);
      printer.unref?.();
    }, statsIntervalMs);
    timer.unref?.();
  }

  return { start, publish, shutdown, stats };
}

module.exports = { createKafkaPublisher, readKafkaConfig, KafkaPublishError, DEFAULTS };
