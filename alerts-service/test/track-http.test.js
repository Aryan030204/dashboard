const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cors = require('cors');

const { buildTrackController, INTENT_MODES } = require('../controllers/trackController');
const { createIntentSqsProducer } = require('../services/intent/sqsProducer');
const { readPublisherConfig } = require('../services/intent/sqsPublisher');
const { parseIanaTimezone } = require('../services/intent/timezone');

const SILENT = { info() {}, warn() {}, error() {} };
const QUEUE = 'https://sqs.ap-south-1.amazonaws.com/923233838659/intent-events';
const ORIGIN = 'https://blabliblulife.com';

// Mirrors the middleware order and /track wiring in app.js. The Mongo models are
// stand-ins that record any touch, so a test can prove nothing reached them.
function startTrackServer({ sendRaw, config = {}, sqsMessageLimitBytes, rsCalls, isKnownBrand = (brand) => brand === 'bbb_shop' }) {
  const producer = createIntentSqsProducer({
    getBrandTimezone: () => parseIanaTimezone('Asia/Kolkata'),
    sendRaw,
    queueUrl: QUEUE,
    logger: SILENT,
    config: { ...readPublisherConfig(), ...config },
    sleep: async () => {},
    statsIntervalMs: 0,
    ...(sqsMessageLimitBytes ? { sqsMessageLimitBytes } : {}),
  });
  const RecordingModel = class {
    constructor() {}
    async save() {
      rsCalls.push('save');
    }
    static async findOne() {
      rsCalls.push('findOne');
      return null;
    }
  };
  const controller = buildTrackController({
    OtpVerified: RecordingModel,
    AjrsPurchase: RecordingModel,
    logger: SILENT,
    ingestionMode: INTENT_MODES.SQS,
    intentIngest: async () => {
      throw new Error('mongo intent ingestor must not run in sqs mode');
    },
    intentSqsPublish: producer.publish,
    isKnownBrand,
  });

  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.post('/track', express.json({ limit: '256kb' }), controller.track);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/track`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

const eventBody = (overrides = {}) => ({
  brand_id: 'bbb_shop',
  event_id: 'sh-http-1',
  event_name: 'page_viewed',
  occurred_at: '2026-10-05T05:00:00.000Z',
  client_id: 'cid-1',
  visitor_id: null,
  url: 'https://blabliblulife.com/',
  referrer: null,
  user_agent: 'UA',
  data: {},
  ...overrides,
});

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers, text };
}

test('202 when SendMessage succeeds, with the CORS origin reflected', async () => {
  const rsCalls = [];
  const server = await startTrackServer({ sendRaw: async () => 'msg-1', rsCalls });
  try {
    const res = await post(server.url, eventBody());
    assert.equal(res.status, 202);
    assert.deepEqual(res.json, { message: 'Event accepted', event_id: 'sh-http-1' });
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.deepEqual(rsCalls, []);
  } finally {
    await server.close();
  }
});

test('400 for an invalid payload, with no SQS send and a generic body', async () => {
  let sends = 0;
  const server = await startTrackServer({ sendRaw: async () => (sends += 1, 'x'), rsCalls: [] });
  try {
    const res = await post(server.url, eventBody({ url: 'not a url' }));
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid event payload');
    assert.equal(sends, 0);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  } finally {
    await server.close();
  }
});

test('413 when the raw body is over the 256 KB parser limit', async () => {
  const server = await startTrackServer({ sendRaw: async () => 'x', rsCalls: [] });
  try {
    const big = eventBody({ data: { blob: 'x'.repeat(300 * 1024) } });
    const res = await post(server.url, big);
    assert.equal(res.status, 413);
  } finally {
    await server.close();
  }
});

test('413 with a JSON body when the serialized message exceeds the SQS limit', async () => {
  let sends = 0;
  const server = await startTrackServer({
    sendRaw: async () => (sends += 1, 'x'),
    sqsMessageLimitBytes: 300,
    rsCalls: [],
  });
  try {
    const res = await post(server.url, eventBody({ data: { blob: 'x'.repeat(1000) } }));
    assert.equal(res.status, 413);
    assert.deepEqual(res.json, { error: 'Event payload too large' });
    assert.equal(sends, 0);
  } finally {
    await server.close();
  }
});

test('503 with a generic body when SQS rejects, and no AWS detail in the response', async () => {
  const server = await startTrackServer({
    sendRaw: async () => {
      throw Object.assign(new Error('User: arn:aws:sts::923233838659:assumed-role/x is not authorized'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      });
    },
    rsCalls: [],
  });
  try {
    const res = await post(server.url, eventBody());
    assert.equal(res.status, 503);
    assert.deepEqual(res.json, { error: 'Failed to queue event' });
    assert.equal(res.text.includes('arn:aws'), false, 'AWS identifiers must not reach the browser');
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  } finally {
    await server.close();
  }
});

test('a hung SQS send becomes a 503 within the deadline, and the next request is accepted', async () => {
  let calls = 0;
  const server = await startTrackServer({
    sendRaw: async () => {
      calls += 1;
      if (calls === 1) return new Promise(() => {}); // the hang
      return 'msg-after';
    },
    config: { maxConcurrency: 1, maxAttempts: 1, sendTimeoutMs: 80 },
    rsCalls: [],
  });
  try {
    const started = Date.now();
    const hung = await post(server.url, eventBody({ event_id: 'hang-http' }));
    const elapsed = Date.now() - started;
    assert.equal(hung.status, 503);
    assert.deepEqual(hung.json, { error: 'Failed to queue event' });
    assert.ok(elapsed < 2000, `the hung request must end at the deadline, took ${elapsed} ms`);

    const next = await post(server.url, eventBody({ event_id: 'after-http' }));
    assert.equal(next.status, 202, 'the slot must be free for the next request, with no restart');
  } finally {
    await server.close();
  }
});

test('400 for a brand that is not on the allow-list, with no SQS send', async () => {
  const { createBrandAllowlist } = require('../services/intent/brandAllowlist');
  const allow = createBrandAllowlist({
    INTENT_BRANDS_ALLOWLIST: 'bbb_shop,pts_shop',
    INTENT_BRAND_TIMEZONES: 'bbb_shop=Asia/Kolkata,pts_shop=Asia/Kolkata',
  });
  let sends = 0;
  const server = await startTrackServer({
    sendRaw: async () => (sends += 1, 'x'),
    rsCalls: [],
    isKnownBrand: allow.isKnownBrand,
  });
  try {
    const unknown = await post(server.url, eventBody({ brand_id: 'ghost_shop' }));
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.error, 'unknown or inactive brand_id');

    // Removing a brand from the list makes it inactive: it is rejected the same way.
    const removed = createBrandAllowlist({
      INTENT_BRANDS_ALLOWLIST: 'bbb_shop',
      INTENT_BRAND_TIMEZONES: 'bbb_shop=Asia/Kolkata',
    });
    assert.equal(removed.isKnownBrand('pts_shop'), false);

    const known = await post(server.url, eventBody({ brand_id: 'pts_shop' }));
    assert.equal(known.status, 202);
    assert.equal(sends, 1);
  } finally {
    await server.close();
  }
});

test('202 for an intent event that carries a top-level orderId, and no RS model is touched', async () => {
  const rsCalls = [];
  const server = await startTrackServer({ sendRaw: async () => 'msg-order', rsCalls });
  try {
    const res = await post(server.url, eventBody({ orderId: 'ord-1', event_name: 'checkout_completed' }));
    assert.equal(res.status, 202);
    assert.deepEqual(rsCalls, []);
  } finally {
    await server.close();
  }
});

test('a supplied event_id is echoed back unchanged in the 202 body', async () => {
  const server = await startTrackServer({ sendRaw: async () => 'msg-id', rsCalls: [] });
  try {
    const res = await post(server.url, eventBody({ event_id: 'sh-0b946659-8FA6-480A-9316-785A088D987A' }));
    assert.equal(res.status, 202);
    assert.equal(res.json.event_id, 'sh-0b946659-8FA6-480A-9316-785A088D987A');
  } finally {
    await server.close();
  }
});

test('a null event_id is accepted (202) with a server-generated id in the response', async () => {
  const server = await startTrackServer({ sendRaw: async () => 'msg-null', rsCalls: [] });
  try {
    const res = await post(server.url, eventBody({ event_id: null }));
    assert.equal(res.status, 202);
    assert.match(res.json.event_id, /^srv-/);
  } finally {
    await server.close();
  }
});
