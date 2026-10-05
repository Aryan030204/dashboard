const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createIntentSqsProducer } = require('../../services/intent/sqsProducer');
const { toStoreLocalOccurredAt, parseIanaTimezone } = require('../../services/intent/timezone');
const { validateMessage, SCHEMA_VERSION } = require('../../services/intent/messageContract');

const BRAND = 'bbb_shop';
const WHEN = '2026-10-05T05:00:00.000Z';
const QUEUE = 'https://sqs.ap-south-1.amazonaws.com/923233838659/intent-events';
const SILENT = { info() {}, warn() {}, error() {} };

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

function clickBody(overrides = {}) {
  return {
    brand_id: BRAND,
    event_id: 'shu-1',
    event_name: 'click',
    occurred_at: WHEN,
    client_id: 'cid-1',
    visitor_id: 'vid-1',
    session_id: null,
    actor_id: 'actor-1',
    url: 'https://blabliblulife.com/cart',
    referrer: 'https://instagram.com/',
    user_agent: 'UA',
    data: {
      click: { x: 266, y: 598, tag_name: 'BUTTON', element_id: 'add', element_name: null, element_type: 'submit', element_value: null, href: null },
      signals: { url_changed: false, cart_changed: true, ui_changed: false, meaningful_scroll: false },
    },
    ...overrides,
  };
}

function makeProducer({ sendRaw, sqsMessageLimitBytes } = {}) {
  const sent = [];
  const sendFn =
    sendRaw ||
    (async (body, opts) => {
      sent.push({ body, opts });
      return `mid-${sent.length}`;
    });
  const producer = createIntentSqsProducer({
    getBrandTimezone: () => parseIanaTimezone('Asia/Kolkata'),
    sendRaw: sendFn,
    queueUrl: QUEUE,
    logger: SILENT,
    ...(sqsMessageLimitBytes ? { sqsMessageLimitBytes } : {}),
  });
  return { producer, sent };
}

test('valid event: exactly one SendMessage, to the configured queue, with a schema_version 1 event message', async () => {
  const { producer, sent } = makeProducer();

  const result = await producer.publish(eventBody(), BRAND);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].opts.queueUrl, QUEUE);
  const message = JSON.parse(sent[0].body);
  assert.equal(message.schema_version, SCHEMA_VERSION);
  assert.equal(message.type, 'event');
  assert.equal(message.message_key, 'sh-1');
  assert.equal(message.event_id, 'sh-1');
  assert.equal(message.event_name, 'product_viewed');
  assert.deepEqual(validateMessage(message), []);
  assert.equal(result.messageId, 'mid-1');
  assert.equal(result.type, 'event');
});

test('the SQS body carries no session fields and no ingested_at', async () => {
  const { producer, sent } = makeProducer();
  await producer.publish(eventBody(), BRAND);
  const message = JSON.parse(sent[0].body);

  assert.equal(message.session_id, null);
  assert.equal(message.session_start, null);
  assert.equal(message.session_end, null);
  assert.equal(message.session_time_spent, null);
  assert.equal('ingested_at' in message, false);
  assert.equal('events_seq' in message, false);
});

test('occurred_at uses the store-local display value, as the Mongo path did', async () => {
  const { producer, sent } = makeProducer();
  await producer.publish(eventBody(), BRAND);
  const message = JSON.parse(sent[0].body);

  const expected = toStoreLocalOccurredAt(new Date(WHEN), parseIanaTimezone('Asia/Kolkata'));
  assert.equal(message.occurred_at, expected.toISOString());
});

test('click: one click message with click_bucket, click and signals', async () => {
  const { producer, sent } = makeProducer();
  const result = await producer.publish(clickBody(), BRAND);
  const message = JSON.parse(sent[0].body);

  assert.equal(result.type, 'click');
  assert.equal(message.type, 'click');
  assert.equal(message.click_bucket, 'useful_click');
  assert.equal(message.click.tag_name, 'BUTTON');
  assert.equal(message.signals.cart_changed, true);
  assert.deepEqual(validateMessage(message), []);
});

test('add-to-cart: product id is resolved into raw.product_id, as the Mongo path did', async () => {
  const { producer, sent } = makeProducer();
  await producer.publish(
    eventBody({ event_id: 'atc-1', event_name: 'product_added_to_cart', data: { product_id: 'gid://shopify/Product/42', quantity: 1 } }),
    BRAND,
  );
  const message = JSON.parse(sent[0].body);
  assert.equal(message.raw.product_id, 'Product:42');
});

test('duplicate requests are not deduplicated: every accepted request is sent', async () => {
  const { producer, sent } = makeProducer();
  await producer.publish(eventBody(), BRAND);
  await producer.publish(eventBody(), BRAND);
  await producer.publish(eventBody({ event_name: 'product_added_to_cart', event_id: 'atc-a' }), BRAND);
  await producer.publish(eventBody({ event_name: 'product_added_to_cart', event_id: 'atc-b' }), BRAND);

  assert.equal(sent.length, 4);
});

test('malformed input: 400 from normalization, nothing sent', async () => {
  const { producer, sent } = makeProducer();
  // A missing event_id is now generated server-side (see event-id.test.js); a non-string one is still rejected.
  await assert.rejects(producer.publish(eventBody({ event_id: 12345 }), BRAND), (err) => err.status === 400);
  await assert.rejects(producer.publish(eventBody({ occurred_at: 'not a date' }), BRAND), (err) => err.status === 400);
  assert.equal(sent.length, 0);
});

test('oversize message: 413, nothing sent', async () => {
  const { producer, sent } = makeProducer({ sqsMessageLimitBytes: 300 });
  await assert.rejects(
    producer.publish(eventBody({ data: { blob: 'x'.repeat(1000) } }), BRAND),
    (err) => err.status === 413,
  );
  assert.equal(sent.length, 0);
});

test('SQS SendMessage failure: 503, never resolves as success', async () => {
  const { producer } = makeProducer({
    sendRaw: async () => {
      throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    },
  });
  await assert.rejects(producer.publish(eventBody(), BRAND), (err) => {
    assert.equal(err.status, 503);
    return true;
  });
});

test('producer module has no Mongo or outbox dependency', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'services', 'intent', 'sqsProducer.js'),
    'utf8',
  );
  assert.equal(/mongoose|models\/intent|outboxIngest|IntentOutbox|ActorCursor|SessionHistory|sessionState|ingest\b/.test(source), false);
});

test('no AWS access keys are read by the producer path', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'services', 'intent', 'sqsProducer.js'),
    'utf8',
  );
  assert.equal(source.includes('AWS_ACCESS_KEY_ID'), false);
  assert.equal(source.includes('AWS_SECRET_ACCESS_KEY'), false);
});

test('parity: the Python consumer parses the produced event and click bodies', async () => {
  const { producer, sent } = makeProducer();
  await producer.publish(eventBody(), BRAND);
  await producer.publish(clickBody(), BRAND);
  const bodies = sent.map((s) => s.body);

  const pipelineRoot = path.resolve(__dirname, '..', '..', '..', 'intent-pipeline');
  const code = [
    'import json, sys',
    'from pipeline.intent_sqs_contract import parse_message, to_event_doc, to_click_doc',
    'rows = json.load(sys.stdin)',
    'for body in rows:',
    '    msg = parse_message(body)',
    '    if msg["type"] == "event": to_event_doc(msg)',
    '    elif msg["type"] == "click": to_click_doc(msg)',
    'print(len(rows))',
  ].join('\n');
  const run = spawnSync('python', ['-c', code], { cwd: pipelineRoot, input: JSON.stringify(bodies), encoding: 'utf8' });
  if (run.error && run.error.code === 'ENOENT') return; // python not installed here
  assert.equal(run.status, 0, `python parse failed: ${run.stderr}`);
  assert.equal(run.stdout.trim(), '2');
});
