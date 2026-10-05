const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

const { createIntentSqsProducer } = require('../../services/intent/sqsProducer');
const { createSemaphore, readPublisherConfig } = require('../../services/intent/sqsPublisher');
const { buildRequestHandler, sendRawMessage, SEND_TIMEOUT_MS } = require('../../services/intentEventQueue');
const { parseIanaTimezone } = require('../../services/intent/timezone');

const SILENT = { info() {}, warn() {}, error() {} };
const QUEUE = 'https://sqs.ap-south-1.amazonaws.com/923233838659/intent-events';
const NO_SLEEP = async () => {};

function eventBody(overrides = {}) {
  return {
    brand_id: 'bbb_shop',
    event_id: 'sh-hang-1',
    event_name: 'product_viewed',
    occurred_at: '2026-10-05T05:00:00.000Z',
    client_id: 'cid-1',
    visitor_id: 'vid-1',
    actor_id: 'actor-1',
    url: 'https://blabliblulife.com/products/x',
    referrer: null,
    user_agent: 'UA',
    data: { product_id: 'gid://shopify/Product/9' },
    ...overrides,
  };
}

// A local TCP server that accepts connections and never responds: the post-connect
// hang that stalled production sends.
function startHungServer() {
  const sockets = new Set();
  const server = http.createServer(() => {
    // never respond
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

test('a request that connects and never gets a response is rejected by the SDK handler', async () => {
  const hung = await startHungServer();
  try {
    const client = new SQSClient({
      region: 'ap-south-1',
      endpoint: hung.url,
      credentials: { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' },
      maxAttempts: 1,
      requestHandler: buildRequestHandler(300),
    });
    const started = Date.now();
    await assert.rejects(
      client.send(new SendMessageCommand({ QueueUrl: `${hung.url}/123456789012/q`, MessageBody: '{}' })),
      (err) => err.name === 'TimeoutError',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `the SDK must reject on its own timeout, took ${elapsed} ms`);
    client.destroy();
  } finally {
    await hung.close();
  }
});

test('the production handler is configured to reject on timeout, with bounded sockets', async () => {
  const handler = buildRequestHandler();
  const config = await handler.configProvider;
  assert.equal(config.throwOnRequestTimeout, true);
  assert.equal(config.requestTimeout, SEND_TIMEOUT_MS);
  assert.equal(config.socketTimeout, SEND_TIMEOUT_MS);
  assert.ok(config.connectionTimeout <= 5000);
});

test('sendRawMessage passes an AbortSignal bounded by the send timeout', async () => {
  let seenOptions = null;
  const fakeSqs = {
    send: async (command, options) => {
      seenOptions = options;
      return { MessageId: 'm-1' };
    },
  };
  await sendRawMessage('{}', { sqs: fakeSqs, queueUrl: QUEUE });
  assert.ok(seenOptions?.abortSignal instanceof AbortSignal);
  assert.equal(seenOptions.abortSignal.aborted, false);
});

test('semaphore: a task that never settles releases its slot at the deadline', async () => {
  const semaphore = createSemaphore({ maxConcurrency: 1, maxPending: 10, maxWaitMs: 1000 });
  await assert.rejects(
    semaphore.run(() => new Promise(() => {}), 30),
    (err) => err.name === 'TimeoutError',
  );
  assert.equal(semaphore.snapshot().inFlight, 0);

  // The slot is free again: the next task gets it at once, with no restart.
  assert.equal(await semaphore.run(async () => 'next'), 'next');
});

test('producer: a hung SendMessage rejects with 503, and the next request acquires the slot', async () => {
  let calls = 0;
  const producer = createIntentSqsProducer({
    getBrandTimezone: () => parseIanaTimezone('Asia/Kolkata'),
    queueUrl: QUEUE,
    logger: SILENT,
    config: { ...readPublisherConfig(), maxConcurrency: 1, maxAttempts: 1, sendTimeoutMs: 40 },
    sleep: NO_SLEEP,
    statsIntervalMs: 0,
    sendRaw: async () => {
      calls += 1;
      if (calls === 1) return new Promise(() => {}); // the hang
      return 'msg-after-hang';
    },
  });

  await assert.rejects(producer.publish(eventBody({ event_id: 'hang-1' }), 'bbb_shop'), (err) => err.status === 503);
  assert.equal(producer.stats().inFlight, 0, 'the hung send must not keep its slot');

  const result = await producer.publish(eventBody({ event_id: 'after-1' }), 'bbb_shop');
  assert.equal(result.messageId, 'msg-after-hang');
  assert.equal(calls, 2);
});

test('producer: a hung first attempt is retried with the same body, and the retry succeeds', async () => {
  const bodies = [];
  let calls = 0;
  const producer = createIntentSqsProducer({
    getBrandTimezone: () => parseIanaTimezone('Asia/Kolkata'),
    queueUrl: QUEUE,
    logger: SILENT,
    config: { ...readPublisherConfig(), maxConcurrency: 1, maxAttempts: 2, sendTimeoutMs: 40 },
    sleep: NO_SLEEP,
    statsIntervalMs: 0,
    sendRaw: async (body) => {
      bodies.push(body);
      calls += 1;
      if (calls === 1) return new Promise(() => {});
      return 'msg-retry';
    },
  });

  const result = await producer.publish(eventBody({ event_id: 'retry-1' }), 'bbb_shop');
  assert.equal(result.messageId, 'msg-retry');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(producer.stats().inFlight, 0);
});

test('an AbortError from the per-send signal (a timeout) is treated as transient and retried', () => {
  const { isRetryableSqsError } = require('../../services/intent/sqsPublisher');
  assert.equal(isRetryableSqsError({ name: 'AbortError' }), true);
});

test('concurrency is still bounded while hung sends occupy slots', async () => {
  // The limit governs publisher slots. Sample the slot count at each send start.
  // A hung send keeps running in the SDK after its slot is released at the deadline,
  // so the raw number of pending sendRaw calls is not the metric here.
  let peak = 0;
  const producer = createIntentSqsProducer({
    getBrandTimezone: () => parseIanaTimezone('Asia/Kolkata'),
    queueUrl: QUEUE,
    logger: SILENT,
    config: { ...readPublisherConfig(), maxConcurrency: 3, maxPending: 5, maxWaitMs: 60000, maxAttempts: 1, sendTimeoutMs: 30 },
    sleep: NO_SLEEP,
    statsIntervalMs: 0,
    sendRaw: async () => {
      peak = Math.max(peak, producer.stats().inFlight);
      await new Promise(() => {}); // every send hangs
    },
  });

  const attempts = Array.from({ length: 12 }, (_, i) =>
    producer.publish(eventBody({ event_id: `burst-${i}` }), 'bbb_shop').then(
      () => 'ok',
      (err) => err.status,
    ),
  );
  const outcomes = await Promise.all(attempts);

  assert.ok(peak <= 3, `peak in-flight ${peak} exceeded the limit of 3`);
  assert.ok(outcomes.every((o) => o === 503 || o === 'ok'));
  assert.equal(producer.stats().inFlight, 0, 'every slot is released after the deadlines pass');
});
