// Bounded publisher for SQS SendMessage calls. Limits in-flight sends, caps the
// number of waiting sends, and gives each waiter a maximum wait. Retries run
// outside the concurrency slot, so a backing-off send never holds capacity.

const DEFAULTS = Object.freeze({
  maxConcurrency: 32,
  maxPending: 200,
  maxWaitMs: 3000,
  maxAttempts: 2,
  // Hard deadline for one SendMessage attempt, enforced by the publisher even if
  // the SDK never settles the promise. Must stay below the gateway proxy timeout.
  sendTimeoutMs: 8000,
  baseDelayMs: 100,
  maxDelayMs: 1000,
  logWindowMs: 10000,
});

function intFromEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPublisherConfig() {
  return {
    maxConcurrency: intFromEnv("INTENT_SQS_MAX_CONCURRENCY", DEFAULTS.maxConcurrency),
    maxPending: intFromEnv("INTENT_SQS_MAX_PENDING", DEFAULTS.maxPending),
    maxWaitMs: intFromEnv("INTENT_SQS_MAX_WAIT_MS", DEFAULTS.maxWaitMs),
    maxAttempts: intFromEnv("INTENT_SQS_MAX_ATTEMPTS", DEFAULTS.maxAttempts),
    sendTimeoutMs: intFromEnv("INTENT_SQS_SEND_TIMEOUT_MS", DEFAULTS.sendTimeoutMs),
    baseDelayMs: DEFAULTS.baseDelayMs,
    maxDelayMs: DEFAULTS.maxDelayMs,
    logWindowMs: DEFAULTS.logWindowMs,
  };
}

function saturatedError() {
  return Object.assign(new Error("producer saturated"), { code: "PRODUCER_SATURATED" });
}

// Rejects after timeoutMs. The name is TimeoutError so the retry policy treats it
// as transient.
function sendDeadlineError(timeoutMs) {
  return Object.assign(new Error(`SendMessage exceeded the ${timeoutMs} ms publisher deadline`), {
    name: "TimeoutError",
  });
}

// Concurrency limiter with a hard cap on waiters. A waiter that is not granted a
// slot within maxWaitMs is rejected, so the queue cannot grow without bound.
function createSemaphore({ maxConcurrency, maxPending, maxWaitMs }) {
  let inFlight = 0;
  const waiters = [];
  const counters = { rejectedSaturated: 0, rejectedWaitTimeout: 0 };

  function release() {
    const next = waiters.shift();
    if (next) {
      next.grant(); // hand the slot straight to the next waiter; inFlight is unchanged
    } else {
      inFlight -= 1;
    }
  }

  function acquire() {
    if (inFlight < maxConcurrency) {
      inFlight += 1;
      return Promise.resolve();
    }
    if (waiters.length >= maxPending) {
      counters.rejectedSaturated += 1;
      return Promise.reject(saturatedError());
    }
    return new Promise((resolve, reject) => {
      const waiter = { grant: null, timer: null };
      waiter.grant = () => {
        clearTimeout(waiter.timer);
        resolve();
      };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        counters.rejectedWaitTimeout += 1;
        reject(saturatedError());
      }, maxWaitMs);
      waiters.push(waiter);
    });
  }

  // Runs task while holding one slot. The slot is released when the task settles
  // or when the deadline passes, whichever comes first. A task that never settles
  // therefore cannot hold a slot forever. Its late result is ignored.
  async function run(task, timeoutMs = DEFAULTS.sendTimeoutMs) {
    await acquire();
    let timer = null;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(sendDeadlineError(timeoutMs)), timeoutMs);
      });
      return await Promise.race([task(), deadline]);
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  function snapshot() {
    return { inFlight, pending: waiters.length, ...counters };
  }

  return { run, snapshot };
}

// Transient failures only: connection-level errors, SDK timeouts, throttling and
// 5xx responses. Authorization, invalid addresses and malformed requests are not
// retried, so they fail on the first attempt.
const RETRYABLE_NAMES = new Set([
  "TimeoutError",
  // Raised by the AbortSignal that bounds each SendMessage attempt: a timeout, not a user cancel.
  "AbortError",
  "ThrottlingException",
  "RequestThrottled",
  "OverLimit",
  "ServiceUnavailable",
  "InternalFailure",
  "InternalError",
  "RequestTimeout",
]);
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

function isRetryableSqsError(err) {
  if (!err) return false;
  const status = err.$metadata?.httpStatusCode;
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  if (RETRYABLE_NAMES.has(err.name)) return true;
  if (RETRYABLE_CODES.has(err.code)) return true;
  return false;
}

// Full jitter: a random delay between 0 and the exponential ceiling.
function backoffDelayMs(attempt, { baseDelayMs, maxDelayMs }, random = Math.random) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

// Logs at most one line per key per window. Suppressed repeats are counted and
// reported on the next line for that key, so an outage cannot flood the logs.
function createRateLimitedLogger(logger, { windowMs, now = Date.now } = {}) {
  const lastByKey = new Map();
  return function logError(key, line) {
    const at = now();
    const entry = lastByKey.get(key);
    if (entry && at - entry.at < windowMs) {
      entry.suppressed += 1;
      return;
    }
    const suppressed = entry?.suppressed ?? 0;
    lastByKey.set(key, { at, suppressed: 0 });
    logger?.error?.(suppressed ? `${line} suppressed=${suppressed}` : line);
  };
}

module.exports = {
  DEFAULTS,
  intFromEnv,
  readPublisherConfig,
  createSemaphore,
  isRetryableSqsError,
  backoffDelayMs,
  createRateLimitedLogger,
  saturatedError,
};
