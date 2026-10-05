const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeIntentBody, resolveEventId, IntentValidationError } = require('../../services/intent/normalize');
const { createIntentSqsProducer } = require('../../services/intent/sqsProducer');
const { parseIanaTimezone } = require('../../services/intent/timezone');

const SILENT = { info() {}, warn() {}, error() {} };
const QUEUE = 'https://sqs.ap-south-1.amazonaws.com/923233838659/intent-events';
const SRV_ID = /^srv-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function pageView(overrides = {}) {
  return {
    brand_id: 'bbb_shop',
    event_name: 'page_viewed',
    occurred_at: '2026-10-05T05:00:00.000Z',
    client_id: 'cid-1',
    visitor_id: null,
    url: 'https://blabliblulife.com/',
    referrer: null,
    user_agent: 'UA',
    data: {},
    ...overrides,
  };
}

test('a supplied valid event_id is kept unchanged', () => {
  const { e } = normalizeIntentBody(pageView({ event_id: 'sh-0b946659-8FA6-480A-9316-785A088D987A' }));
  assert.equal(e.event_id, 'sh-0b946659-8FA6-480A-9316-785A088D987A');
});

test('a null event_id is replaced by a server-generated id', () => {
  const { e } = normalizeIntentBody(pageView({ event_id: null }));
  assert.match(e.event_id, SRV_ID);
});

test('a missing event_id is replaced by a server-generated id', () => {
  const body = pageView();
  delete body.event_id;
  const { e } = normalizeIntentBody(body);
  assert.match(e.event_id, SRV_ID);
});

test('a blank event_id is treated as missing', () => {
  const { e } = normalizeIntentBody(pageView({ event_id: '   ' }));
  assert.match(e.event_id, SRV_ID);
});

test('click events get the same treatment for a null event_id', () => {
  const body = pageView({
    event_name: 'click',
    event_id: null,
    session_id: null,
    data: {
      click: { x: 1, y: 2, tag_name: 'BUTTON', element_id: null, element_name: null, element_type: null, element_value: null, href: null },
      signals: { url_changed: false, cart_changed: true, ui_changed: false, meaningful_scroll: false },
    },
  });
  const { kind, e } = normalizeIntentBody(body);
  assert.equal(kind, 'click');
  assert.match(e.event_id, SRV_ID);
});

test('invalid event_id values are still rejected', () => {
  assert.throws(() => normalizeIntentBody(pageView({ event_id: 12345 })), IntentValidationError);
  assert.throws(() => normalizeIntentBody(pageView({ event_id: { id: 'x' } })), IntentValidationError);
  assert.throws(() => normalizeIntentBody(pageView({ event_id: 'x'.repeat(201) })), IntentValidationError);
});

test('resolveEventId generates a new id on each call when none is supplied', () => {
  assert.notEqual(resolveEventId(null), resolveEventId(null));
});

test('retries reuse the generated event_id: every SQS attempt carries the same id', async () => {
  const seen = [];
  let calls = 0;
  const producer = createIntentSqsProducer({
    getBrandTimezone: () => parseIanaTimezone('Asia/Kolkata'),
    queueUrl: QUEUE,
    logger: SILENT,
    config: { maxConcurrency: 4, maxPending: 10, maxWaitMs: 1000, maxAttempts: 2, sendTimeoutMs: 1000, baseDelayMs: 1, maxDelayMs: 1, logWindowMs: 1000 },
    sleep: async () => {},
    statsIntervalMs: 0,
    sendRaw: async (body) => {
      seen.push(JSON.parse(body).event_id);
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      }
      return 'msg-ok';
    },
  });

  const result = await producer.publish(pageView({ event_id: null }), 'bbb_shop');

  assert.equal(seen.length, 2);
  assert.match(seen[0], SRV_ID);
  assert.equal(seen[0], seen[1], 'the retry must reuse the generated event_id');
  assert.equal(result.event_id, seen[0]);
});

test('two requests with null event_id get two different generated ids', async () => {
  const seen = [];
  const producer = createIntentSqsProducer({
    getBrandTimezone: () => parseIanaTimezone('Asia/Kolkata'),
    queueUrl: QUEUE,
    logger: SILENT,
    statsIntervalMs: 0,
    sendRaw: async (body) => {
      seen.push(JSON.parse(body).event_id);
      return 'ok';
    },
  });
  await producer.publish(pageView({ event_id: null }), 'bbb_shop');
  await producer.publish(pageView({ event_id: null }), 'bbb_shop');
  assert.notEqual(seen[0], seen[1]);
});

// The shared normalizer is used by the Mongo and outbox paths too, so it keeps accepting
// these ids. The SQS publish path enforces the worker's VARCHAR(100) limit.
test('the shared normalizer still accepts a 101-char event_id and client_id (Mongo/outbox unchanged)', () => {
  const { e } = normalizeIntentBody(pageView({ event_id: 'x'.repeat(101), client_id: 'c'.repeat(101) }));
  assert.equal(e.event_id.length, 101);
});

test('SQS publish rejects an id over 100 chars with 400 and sends nothing; 100 chars is accepted', async () => {
  const sent = [];
  const producer = createIntentSqsProducer({
    getBrandTimezone: () => parseIanaTimezone('Asia/Kolkata'),
    sendRaw: async (body) => { sent.push(body); return 'mid-1'; },
    queueUrl: QUEUE,
    logger: SILENT,
  });
  await assert.rejects(producer.publish(pageView({ event_id: 'x'.repeat(101) }), 'bbb_shop'), { status: 400 });
  await assert.rejects(producer.publish(pageView({ event_id: 'e-ok', client_id: 'c'.repeat(101) }), 'bbb_shop'), { status: 400 });
  assert.equal(sent.length, 0);
  await producer.publish(pageView({ event_id: 'x'.repeat(100) }), 'bbb_shop');
  assert.equal(sent.length, 1);
});
