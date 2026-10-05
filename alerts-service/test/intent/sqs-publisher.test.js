const test = require('node:test');
const assert = require('node:assert/strict');

const { createIntentSqsProducer } = require('../../services/intent/sqsProducer');
const {
  readPublisherConfig,
  createSemaphore,
  isRetryableSqsError,
  backoffDelayMs,
  createRateLimitedLogger,
  DEFAULTS,
} = require('../../services/intent/sqsPublisher');
const { parseIanaTimezone } = require('../../services/intent/timezone');
const { getClient, buildHttpsAgent } = require('../../services/intentEventQueue');

const BRAND = 'bbb_shop';
const WHEN = '2026-10-05T05:00:00.000Z';
const QUEUE = 'https://sqs.ap-south-1.amazonaws.com/923233838659/intent-events';
const SILENT = { info() {}, warn() {}, error() {} };
const NO_SLEEP = async () => {};

function eventBody(overrides = {}) {
  return {
    brand_id: BRAND,
    event_id: 'sh-1',
    event_name: 'product_viewed',
    occurred_at: WHEN,
    client_id: 'cid-1',
    visitor_id: 'vid-1',
    actor_id: 'actor-1',
    url: 'https://blabliblulife.com/products/x',
    referrer: null,
    user_agent: 'UA',
    data: { product_id: 'gid://shopify/Product/9', variant_id: '77', price: 499, currency: 'INR' },
    ...overrides,
  };
}

function awsError(name, extra = {}) {
  return Object.assign(new Error(`${name} happened`), { name, ...extra });
}

function makeProducer({ sendRaw, config = {}, sleep = NO_SLEEP, random = () => 0.5 } = {}) {
  return createIntentSqsProducer({
    getBrandTimezone: () => parseIanaTimezone('Asia/Kolkata'),
    sendRaw,
    queueUrl: QUEUE,
    logger: SILENT,
    config: { ...readPublisherConfig(), ...config },
    sleep,
    random,
    statsIntervalMs: 0,
  });
}

// --- client and agent lifecycle ---

test('the SQS client is a singleton', () => {
  assert.equal(getClient(), getClient());
});

test('the HTTPS agent is a singleton with keepAlive and a socket cap above the default concurrency', () => {
  const agent = buildHttpsAgent();
  assert.equal(agent, buildHttpsAgent());
  assert.equal(agent.keepAlive, true);
  assert.equal(agent.maxSockets, 64);
  assert.equal(agent.maxFreeSockets, 32);
  assert.ok(agent.maxSockets > DEFAULTS.maxConcurrency, 'sockets must exceed the app concurrency so requests never queue for one');
});

// --- concurrency and pending limits ---

test('concurrency never exceeds the configured maximum under a burst far above the limit', async () => {
  let active = 0;
  let peak = 0;
  const producer = makeProducer({
    config: { maxConcurrency: 5, maxPending: 1000, maxWaitMs: 60000 },
    sendRaw: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return 'mid';
    },
  });

  const results = await Promise.all(
    Array.from({ length: 200 }, (_, i) => producer.publish(eventBody({ event_id: `sh-${i}` }), BRAND)),
  );

  assert.equal(results.length, 200);
  assert.ok(peak <= 5, `peak concurrency ${peak} exceeded the limit of 5`);
  assert.equal(producer.stats().sent, 200);
  assert.equal(producer.stats().inFlight, 0);
  assert.equal(producer.stats().pending, 0);
});

test('the pending queue has a hard maximum: requests beyond it fail fast with 503', async () => {
  const release = [];
  const producer = makeProducer({
    config: { maxConcurrency: 1, maxPending: 2, maxWaitMs: 60000 },
    sendRaw: () => new Promise((resolve) => release.push(() => resolve('mid'))),
  });

  const inFlight = producer.publish(eventBody({ event_id: 'a' }), BRAND);
  const pendingOne = producer.publish(eventBody({ event_id: 'b' }), BRAND);
  const pendingTwo = producer.publish(eventBody({ event_id: 'c' }), BRAND);
  assert.equal(producer.stats().pending, 2);

  await assert.rejects(producer.publish(eventBody({ event_id: 'd' }), BRAND), (err) => err.status === 503);
  assert.equal(producer.stats().rejectedSaturated, 1);
  assert.equal(producer.stats().pending, 2, 'the rejected request must not join the queue');

  // Each release lets the next queued send take the slot, so yield between releases.
  for (let i = 0; i < 3; i += 1) {
    release.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all([inFlight, pendingOne, pendingTwo]);
});

test('a waiter that gets no slot within maxWaitMs is rejected with 503 and leaves the queue', async () => {
  const producer = makeProducer({
    config: { maxConcurrency: 1, maxPending: 10, maxWaitMs: 20 },
    sendRaw: () => new Promise(() => {}), // never resolves: the slot is held forever
  });

  producer.publish(eventBody({ event_id: 'holder' }), BRAND).catch(() => {});
  await assert.rejects(producer.publish(eventBody({ event_id: 'waiter' }), BRAND), (err) => err.status === 503);
  assert.equal(producer.stats().pending, 0);
  assert.equal(producer.stats().rejectedWaitTimeout, 1);
});

test('a successful send resolves with its MessageId only after SendMessage succeeded', async () => {
  const producer = makeProducer({ sendRaw: async () => 'msg-42' });
  const result = await producer.publish(eventBody(), BRAND);
  assert.equal(result.messageId, 'msg-42');
  assert.equal(result.event_id, 'sh-1');
});

test('a slot is released after a failed send, so the limit does not leak', async () => {
  const producer = makeProducer({
    config: { maxConcurrency: 1, maxAttempts: 1 },
    sendRaw: async () => {
      throw awsError('AccessDenied');
    },
  });
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(producer.publish(eventBody({ event_id: `x${i}` }), BRAND), (err) => err.status === 503);
  }
  assert.equal(producer.stats().inFlight, 0);
});

// --- retry behavior ---

test('a transient network error retries and then succeeds, with the same event_id and body', async () => {
  const bodies = [];
  let calls = 0;
  const producer = makeProducer({
    config: { maxAttempts: 2 },
    sendRaw: async (body) => {
      bodies.push(body);
      calls += 1;
      if (calls === 1) throw awsError('TimeoutError');
      return 'msg-ok';
    },
  });

  const result = await producer.publish(eventBody(), BRAND);

  assert.equal(calls, 2);
  assert.equal(result.messageId, 'msg-ok');
  assert.equal(bodies[0], bodies[1], 'the retry must send the identical body, so the event_id is unchanged');
  assert.equal(producer.stats().retries, 1);
});

test('retries are bounded by maxAttempts, then the request fails with 503', async () => {
  let calls = 0;
  const producer = makeProducer({
    config: { maxAttempts: 3 },
    sendRaw: async () => {
      calls += 1;
      throw awsError('TimeoutError');
    },
  });
  await assert.rejects(producer.publish(eventBody(), BRAND), (err) => err.status === 503);
  assert.equal(calls, 3);
});

test('a non-retryable error is not retried', async () => {
  let calls = 0;
  const producer = makeProducer({
    config: { maxAttempts: 3 },
    sendRaw: async () => {
      calls += 1;
      throw awsError('AccessDenied', { $metadata: { httpStatusCode: 403 } });
    },
  });
  await assert.rejects(producer.publish(eventBody(), BRAND), (err) => err.status === 503);
  assert.equal(calls, 1);
});

test('retry backoff waits outside the concurrency slot, with jittered delays', async () => {
  const delays = [];
  let calls = 0;
  const producer = makeProducer({
    config: { maxConcurrency: 1, maxAttempts: 3 },
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0.5,
    sendRaw: async () => {
      calls += 1;
      if (calls < 3) throw awsError('TimeoutError');
      return 'ok';
    },
  });

  await producer.publish(eventBody(), BRAND);

  assert.equal(delays.length, 2);
  assert.equal(delays[0], 50); // attempt 1: 0.5 * min(1000, 100 * 2^0)
  assert.equal(delays[1], 100); // attempt 2: 0.5 * min(1000, 100 * 2^1)
  assert.equal(producer.stats().inFlight, 0);
});

test('isRetryableSqsError: transient errors yes, authorization and invalid requests no', () => {
  assert.equal(isRetryableSqsError(awsError('TimeoutError')), true);
  assert.equal(isRetryableSqsError(awsError('ThrottlingException')), true);
  assert.equal(isRetryableSqsError(awsError('ServiceUnavailable')), true);
  assert.equal(isRetryableSqsError(awsError('Whatever', { $metadata: { httpStatusCode: 500 } })), true);
  assert.equal(isRetryableSqsError(awsError('Whatever', { $metadata: { httpStatusCode: 429 } })), true);
  assert.equal(isRetryableSqsError(awsError('Whatever', { code: 'ECONNRESET' })), true);

  assert.equal(isRetryableSqsError(awsError('AccessDenied', { $metadata: { httpStatusCode: 403 } })), false);
  assert.equal(isRetryableSqsError(awsError('InvalidAddress')), false);
  assert.equal(isRetryableSqsError(awsError('QueueDoesNotExist', { $metadata: { httpStatusCode: 400 } })), false);
  assert.equal(isRetryableSqsError(Object.assign(new Error('x'), { code: 'PRODUCER_SATURATED' })), false);
  assert.equal(isRetryableSqsError(null), false);
});

test('backoffDelayMs grows exponentially, caps at maxDelayMs, and stays within the jitter window', () => {
  const cfg = { baseDelayMs: 100, maxDelayMs: 1000 };
  assert.equal(backoffDelayMs(1, cfg, () => 0.999), 99);
  assert.equal(backoffDelayMs(2, cfg, () => 0.999), 199);
  assert.equal(backoffDelayMs(3, cfg, () => 0.999), 399);
  assert.equal(backoffDelayMs(10, cfg, () => 0.999), 999, 'the ceiling is capped');
  assert.equal(backoffDelayMs(5, cfg, () => 0), 0);
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const delay = backoffDelayMs(attempt, cfg, Math.random);
    assert.ok(delay >= 0 && delay <= cfg.maxDelayMs);
  }
});

// --- producer-generated ids and contract ---

test('the producer never generates a new event_id: every send carries the request event_id', async () => {
  const seen = [];
  const producer = makeProducer({
    config: { maxAttempts: 2 },
    sendRaw: async (body) => {
      seen.push(JSON.parse(body).event_id);
      if (seen.length === 1) throw awsError('TimeoutError');
      return 'ok';
    },
  });
  await producer.publish(eventBody({ event_id: 'stable-id' }), BRAND);
  assert.deepEqual(seen, ['stable-id', 'stable-id']);
});

// --- observability ---

test('rate-limited logger: repeats inside the window are counted, then reported once', () => {
  const lines = [];
  let clock = 0;
  const logger = createRateLimitedLogger({ error: (line) => lines.push(line) }, { windowMs: 1000, now: () => clock });

  for (let i = 0; i < 5; i += 1) logger('same-key', 'failure');
  assert.equal(lines.length, 1);

  clock = 1500;
  logger('same-key', 'failure');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /suppressed=4/);

  logger('other-key', 'other');
  assert.equal(lines.length, 3, 'a different key is logged independently');
});

test('the failure log has the AWS fields, the queue URL and no event body', async () => {
  const lines = [];
  const producer = createIntentSqsProducer({
    getBrandTimezone: () => parseIanaTimezone('Asia/Kolkata'),
    sendRaw: async () => {
      throw awsError('AccessDenied', { $metadata: { httpStatusCode: 403 } });
    },
    queueUrl: QUEUE,
    logger: { info() {}, warn() {}, error: (line) => lines.push(line) },
    config: { ...readPublisherConfig(), maxAttempts: 1 },
    sleep: NO_SLEEP,
    statsIntervalMs: 0,
  });

  await assert.rejects(producer.publish(eventBody({ data: { product_id: 'secret-marker-123' } }), BRAND));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /AccessDenied/);
  assert.match(lines[0], /"httpStatusCode":403/);
  assert.match(lines[0], /"queueUrl":"https:\/\/sqs\.ap-south-1\.amazonaws\.com/);
  assert.equal(lines[0].includes('secret-marker-123'), false, 'the event payload must not be logged');
});

test('readPublisherConfig reads the documented environment variables and falls back on bad values', () => {
  const keys = ['INTENT_SQS_MAX_CONCURRENCY', 'INTENT_SQS_MAX_PENDING', 'INTENT_SQS_MAX_ATTEMPTS'];
  const saved = keys.map((k) => process.env[k]);
  try {
    process.env.INTENT_SQS_MAX_CONCURRENCY = '12';
    process.env.INTENT_SQS_MAX_PENDING = 'not-a-number';
    process.env.INTENT_SQS_MAX_ATTEMPTS = '0';
    const cfg = readPublisherConfig();
    assert.equal(cfg.maxConcurrency, 12);
    assert.equal(cfg.maxPending, DEFAULTS.maxPending);
    assert.equal(cfg.maxAttempts, DEFAULTS.maxAttempts);
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
});

test('createSemaphore rejects a waiter with PRODUCER_SATURATED when pending is full', async () => {
  const semaphore = createSemaphore({ maxConcurrency: 1, maxPending: 0, maxWaitMs: 1000 });
  let release;
  const holder = semaphore.run(() => new Promise((resolve) => (release = resolve)));
  await assert.rejects(semaphore.run(async () => 'x'), (err) => err.code === 'PRODUCER_SATURATED');
  release();
  await holder;
});
