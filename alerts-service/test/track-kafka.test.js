const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cors = require('cors');

const { createIntentTrack, buildIntentMessage, isIntentEvent } = require('../controllers/trackIntent');
const { topicForEvent, messageKey, TOPICS, isKafkaEvent, KAFKA_EVENTS } = require('../services/intent/topicRouting');
const { createKafkaPublisher, readKafkaConfig, KafkaPublishError } = require('../services/intent/kafkaProducer');
const { createBrandAllowlist } = require('../services/intent/brandAllowlist');
const { normalizeIntentBody } = require('../services/intent/normalize');
const { validateMessage } = require('../services/intent/messageContract');

const SILENT = { info() {}, warn() {}, error() {} };
const ALLOW = createBrandAllowlist({
  INTENT_BRANDS_ALLOWLIST: 'bbb_shop,pts_shop',
  INTENT_BRAND_TIMEZONES: 'bbb_shop=Asia/Kolkata,pts_shop=Asia/Kolkata',
});

const body = (o = {}) => ({
  brand_id: 'bbb_shop',
  event_id: 'sh-0b946659-8FA6-480A-9316-785A088D987A',
  event_name: 'page_viewed',
  occurred_at: '2026-10-05T05:00:00.000Z',
  client_id: 'cid-1',
  visitor_id: null,
  actor_id: 'actor_1',
  url: 'https://blabliblulife.com/',
  referrer: null,
  user_agent: 'UA',
  session_id: null,
  data: {},
  ...o,
});
const click = (o = {}) =>
  body({
    event_id: 'shu-1',
    event_name: 'click',
    data: {
      click: { x: 1, y: 2, tag_name: 'BUTTON', element_id: 'add', element_name: null, element_type: null, element_value: null, href: null },
      signals: { url_changed: false, cart_changed: true, ui_changed: false, meaningful_scroll: false },
    },
    ...o,
  });

// Real Express server with the same /track wiring as app.js; the fallback stands in
// for the existing RS/CI handler and records what reaches it.
async function start({ publish, allow = ALLOW } = {}) {
  const sent = [];
  const fallthrough = [];
  const publisher = { publish: publish || (async (m) => (sent.push(m), { partition: 1, offset: '42' })) };
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());
  app.post('/track', createIntentTrack({ publisher, brandAllowlist: allow, logger: SILENT }), (req, res) => {
    fallthrough.push(req.body);
    res.status(201).json({ message: 'Session tracked successfully' });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/track`,
        sent,
        fallthrough,
        close: () => new Promise((d) => (server.closeAllConnections?.(), server.close(d))),
      }),
    );
  });
}
async function post(url, b) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://s.example' }, body: JSON.stringify(b) });
  const t = await r.text();
  let json = null;
  try { json = t ? JSON.parse(t) : null; } catch { json = null; }
  return { status: r.status, json, headers: r.headers };
}

// --- validation and event_id ---
test('valid event accepted with 202, event_id preserved exactly', async () => {
  const s = await start();
  try {
    const r = await post(s.url, body());
    assert.equal(r.status, 202);
    assert.equal(r.json.event_id, 'sh-0b946659-8FA6-480A-9316-785A088D987A');
    assert.equal(JSON.parse(s.sent[0].value).event_id, 'sh-0b946659-8FA6-480A-9316-785A088D987A');
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://s.example');
  } finally { await s.close(); }
});

test('missing, null, blank, non-string and over-long event_id are rejected with 400 and never published', async () => {
  const s = await start();
  try {
    for (const bad of [undefined, null, '', '   ', 123, { a: 1 }, 'x'.repeat(101)]) {
      const b = body({ event_id: bad });
      if (bad === undefined) delete b.event_id;
      const r = await post(s.url, b);
      assert.equal(r.status, 400, `event_id=${JSON.stringify(bad)?.slice(0, 20)}`);
    }
    assert.equal(s.sent.length, 0);
  } finally { await s.close(); }
});

test('event_id is never generated, prefixed or altered', () => {
  const msg = buildIntentMessage(body({ event_id: ' Weird_ID-1 ' }), 'bbb_shop', 'Asia/Kolkata');
  assert.equal(msg.event_id, ' Weird_ID-1 ');
  assert.throws(() => normalizeIntentBody(body({ event_id: null })));
});

test('invalid payloads are rejected with 400: bad url, bad date, unknown brand, missing brand', async () => {
  const s = await start();
  try {
    assert.equal((await post(s.url, body({ url: 'not a url' }))).status, 400);
    assert.equal((await post(s.url, body({ occurred_at: 'nope' }))).status, 400);
    const unknown = await post(s.url, body({ brand_id: 'ghost_shop' }));
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.error, 'unknown or inactive brand_id');
    assert.equal((await post(s.url, body({ brand_id: undefined }))).status, 400);
    assert.equal(s.sent.length, 0);
  } finally { await s.close(); }
});

test('413 when the message exceeds the size limit', async () => {
  const s = await start();
  try {
    // Over the body-parser limit (100 kb default): 413 before the handler runs.
    const r = await post(s.url, body({ data: { blob: 'x'.repeat(300 * 1024) } }));
    assert.equal(r.status, 413);
    assert.equal(s.sent.length, 0);
  } finally { await s.close(); }
});

// --- normalization ---
test('normalized message follows the contract: actor rule, store-local occurred_at, validates', () => {
  const m = buildIntentMessage(body({ actor_id: null }), 'bbb_shop', 'Asia/Kolkata');
  assert.deepEqual(validateMessage(m), []);
  assert.equal(m.schema_version, 1);
  assert.equal(m.type, 'event');
  assert.equal(m.actor_id, 'cid-1'); // actor_id || client_id
  assert.equal(m.occurred_at, '2026-10-05T10:30:00.000Z'); // 05:00Z shown as Kolkata wall time
  assert.equal(m.session_id, null);
  assert.equal('ingested_at' in m, false);
});

test('click is normalized with bucket, click and signals', () => {
  const m = buildIntentMessage(click(), 'bbb_shop', 'Asia/Kolkata');
  assert.equal(m.type, 'click');
  assert.equal(m.click_bucket, 'useful_click');
  assert.equal(m.click.tag_name, 'BUTTON');
  const dead = buildIntentMessage(click({ data: { click: click().data.click, signals: { url_changed: false, cart_changed: false, ui_changed: false, meaningful_scroll: false } } }), 'bbb_shop', null);
  assert.equal(dead.click_bucket, 'dead_click');
});

test('ATC product id is normalized into raw.product_id for both ATC names', () => {
  for (const name of ['product_added_to_cart', 'add_to_cart']) {
    const m = buildIntentMessage(body({ event_name: name, data: { product_id: 'gid://shopify/Product/42', quantity: 1 } }), 'bbb_shop', null);
    assert.equal(m.raw.product_id, 'Product:42');
    assert.equal(m.raw.quantity, 1);
  }
});

// --- topic routing and key ---
test('topic routing', () => {
  assert.equal(topicForEvent('checkout_started'), 'intent.checkout');
  assert.equal(topicForEvent('product_added_to_cart'), 'intent.atc');
  assert.equal(topicForEvent('add_to_cart'), 'intent.atc');
  assert.equal(topicForEvent('click'), 'intent.click');
  for (const other of ['page_viewed', 'product_viewed', 'scroll_depth', 'anything_else']) {
    assert.equal(topicForEvent(other), TOPICS.OTHER);
  }
});

test('published topic and key match the event: checkout, atc, click, other', async () => {
  const s = await start();
  try {
    await post(s.url, body({ event_id: 'e1', event_name: 'checkout_started', data: {} }));
    await post(s.url, body({ event_id: 'e2', event_name: 'product_added_to_cart', data: { product_id: '9' } }));
    await post(s.url, click({ event_id: 'e3' }));
    await post(s.url, body({ event_id: 'e4', event_name: 'scroll_depth', data: { percent: 50 } }));
    assert.deepEqual(s.sent.map((m) => m.topic), ['intent.checkout', 'intent.atc', 'intent.click', 'intent.other']);
    assert.ok(s.sent.every((m) => m.key === 'bbb_shop:actor_1'));
  } finally { await s.close(); }
});

test('kafka key: brand:actor; same actor same key; fallback to client_id, then event_id', () => {
  const a = buildIntentMessage(body({ event_id: 'a' }), 'bbb_shop', null);
  const b = buildIntentMessage(body({ event_id: 'b' }), 'bbb_shop', null);
  assert.equal(messageKey(a), 'bbb_shop:actor_1');
  assert.equal(messageKey(a), messageKey(b));
  const byClient = buildIntentMessage(body({ actor_id: null }), 'bbb_shop', null);
  assert.equal(messageKey(byClient), 'bbb_shop:cid-1');
  const none = buildIntentMessage(body({ actor_id: null, client_id: null, event_id: 'only-id' }), 'bbb_shop', null);
  assert.equal(messageKey(none), 'bbb_shop:event:only-id');
  assert.equal(messageKey(none), messageKey(none));
  assert.notEqual(messageKey(a), messageKey(buildIntentMessage(body({ actor_id: 'actor_2' }), 'bbb_shop', null)));
});

// --- kafka outcome ---
test('Kafka failure returns 503 and never 202; body has no Kafka internals', async () => {
  const s = await start({ publish: async () => { throw new KafkaPublishError('unavailable', 'connect ECONNREFUSED 10.0.0.5:9092'); } });
  try {
    const r = await post(s.url, body());
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { error: 'Failed to queue event' });
  } finally { await s.close(); }
});

test('not-configured brand allow-list answers 503 without crashing', async () => {
  const s = await start({ allow: null });
  try { assert.equal((await post(s.url, body())).status, 503); } finally { await s.close(); }
});

// --- existing behavior ---
test('RS and CI payloads are not intent events and fall through to the existing handler', async () => {
  const s = await start();
  try {
    const ci = { idempotency_key: 'k', event_type: 'product_viewed', shop_name: 'bbb', event_id: 'x' };
    for (const p of [{ orderId: 'ord-1' }, { tags: 'RS_Cinema_KP', customer_id: 'c' }, ci]) {
      assert.equal(isIntentEvent(p), false);
      assert.equal((await post(s.url, p)).status, 201);
    }
    assert.equal(s.fallthrough.length, 3);
    assert.equal(s.sent.length, 0);
  } finally { await s.close(); }
});

test('an intent event carrying a top-level orderId goes to Kafka, not the RS handler', async () => {
  const s = await start();
  try {
    const r = await post(s.url, body({ orderId: 'ord-9', event_name: 'checkout_started' }));
    assert.equal(r.status, 202);
    assert.equal(s.fallthrough.length, 0);
    assert.equal(s.sent[0].topic, 'intent.checkout');
  } finally { await s.close(); }
});

// --- routing by event name (Kafka list vs legacy Mongo) ---
test('the Kafka list is exactly the agreed one', () => {
  const agreed = ['checkout_started', 'product_added_to_cart', 'click', 'product_viewed', 'collection_viewed',
    'checkout_completed', 'page_viewed', 'product_removed_from_cart', 'scroll_depth'];
  assert.deepEqual([...KAFKA_EVENTS].sort(), [...agreed].sort());
  for (const n of agreed) assert.equal(isKafkaEvent(n), true, n);
});

test('legacy names are not Kafka events: checkout_initiated, buy_now, add_to_cart, unknown, non-strings', () => {
  for (const n of ['checkout_initiated', 'buy_now', 'add_to_cart', 'something_else', '', null, undefined, 5]) {
    assert.equal(isKafkaEvent(n), false, String(n));
    assert.equal(isIntentEvent({ event_name: n }), false, String(n));
  }
});

test('bucketing: substring rules, first match wins', () => {
  assert.equal(topicForEvent('checkout_started'), 'intent.checkout');
  assert.equal(topicForEvent('checkout_completed'), 'intent.checkout');
  assert.equal(topicForEvent('foo_checkout_bar'), 'intent.checkout');
  assert.equal(topicForEvent('product_added_to_cart'), 'intent.atc');
  assert.equal(topicForEvent('add_to_cart'), 'intent.atc');
  assert.equal(topicForEvent('click'), 'intent.click');
  for (const other of ['product_viewed', 'collection_viewed', 'page_viewed', 'scroll_depth', 'product_removed_from_cart']) {
    assert.equal(topicForEvent(other), 'intent.other', other);
  }
  assert.equal(topicForEvent('checkout_add_to_cart'), 'intent.checkout');
  assert.equal(topicForEvent('add_to_cart_click'), 'intent.atc');
});

test('each Kafka-list event is published to its bucket topic over HTTP', async () => {
  const s = await start();
  try {
    const expected = {
      checkout_started: 'intent.checkout', checkout_completed: 'intent.checkout',
      product_added_to_cart: 'intent.atc', product_viewed: 'intent.other', collection_viewed: 'intent.other',
      page_viewed: 'intent.other', product_removed_from_cart: 'intent.other', scroll_depth: 'intent.other',
    };
    for (const [name, topic] of Object.entries(expected)) {
      const r = await post(s.url, body({ event_id: `id-${name}`, event_name: name, data: {} }));
      assert.equal(r.status, 202, name);
      assert.equal(s.sent.at(-1).topic, topic, name);
    }
    assert.equal((await post(s.url, click({ event_id: 'id-click' }))).status, 202);
    assert.equal(s.sent.at(-1).topic, 'intent.click');
  } finally { await s.close(); }
});

test('intent-shaped payloads with legacy names fall through to the legacy handler, not Kafka', async () => {
  const s = await start();
  try {
    for (const name of ['checkout_initiated', 'buy_now', 'add_to_cart', 'anything_else']) {
      assert.equal((await post(s.url, body({ event_name: name }))).status, 201, name); // stub legacy answers 201
    }
    assert.equal(s.fallthrough.length, 4);
    assert.equal(s.sent.length, 0);
  } finally { await s.close(); }
});

test('CI payload named like a Kafka event (event_type, no event_name) stays on the legacy handler', async () => {
  const s = await start();
  try {
    for (const t of ['product_added_to_cart', 'product_viewed', 'collection_viewed']) {
      const r = await post(s.url, { event_id: 'x', idempotency_key: 'k', event_type: t, shop_name: 'bbb', session_id: 's', data: {} });
      assert.equal(r.status, 201, t);
    }
    assert.equal(s.fallthrough.length, 3);
    assert.equal(s.sent.length, 0);
  } finally { await s.close(); }
});

// --- producer behaviour with a fake kafkajs ---
function fakeKafka({ send, connect } = {}) {
  const calls = { sends: [], connects: 0 };
  const producer = {
    events: { DISCONNECT: 'producer.disconnect' },
    on() {},
    connect: async () => { calls.connects += 1; if (connect) await connect(calls.connects); },
    disconnect: async () => {},
    send: async (req) => { calls.sends.push(req); return send ? send(req) : [{ partition: 2, baseOffset: '7' }]; },
  };
  return { kafka: { producer: () => producer }, calls };
}
const cfg = (o = {}) => ({ brokers: ['kafka-service:9092'], clientId: 't', sendTimeoutMs: 80, maxInFlight: 2, connectionTimeoutMs: 50, ...o });

test('producer waits for acknowledgement (acks=all) and returns partition and offset', async () => {
  const { kafka, calls } = fakeKafka();
  const pub = createKafkaPublisher({ statsIntervalMs: 0, config: cfg(), logger: SILENT, kafka });
  const ack = await pub.publish({ topic: 'intent.atc', key: 'k', value: '{}' });
  assert.deepEqual(ack, { partition: 2, offset: '7' });
  assert.equal(calls.sends[0].acks, -1);
  assert.equal(calls.sends[0].topic, 'intent.atc');
  assert.equal(calls.sends[0].messages[0].key, 'k');
});

test('one shared producer connection is reused across publishes', async () => {
  const { kafka, calls } = fakeKafka();
  const pub = createKafkaPublisher({ statsIntervalMs: 0, config: cfg({ maxInFlight: 10 }), logger: SILENT, kafka });
  await Promise.all([1, 2, 3].map(() => pub.publish({ topic: 't', key: 'k', value: 'v' })));
  assert.equal(calls.connects, 1);
});

test('in-flight cap: beyond maxInFlight fails at once, nothing is queued', async () => {
  const { kafka } = fakeKafka({ send: () => new Promise(() => {}) });
  const pub = createKafkaPublisher({ statsIntervalMs: 0, config: cfg({ sendTimeoutMs: 500 }), logger: SILENT, kafka });
  const held = [1, 2].map(() => pub.publish({ topic: 't', key: 'k', value: 'v' }).catch((e) => e));
  await new Promise((r) => setImmediate(r));
  await assert.rejects(pub.publish({ topic: 't', key: 'k', value: 'v' }), (e) => e.category === 'saturated');
  assert.equal(pub.stats().rejectedSaturated, 1);
  await Promise.all(held);
  assert.equal(pub.stats().inFlight, 0);
});

test('a hung send hits the deadline, frees its slot, and the next publish succeeds', async () => {
  let n = 0;
  const { kafka } = fakeKafka({ send: () => (++n === 1 ? new Promise(() => {}) : Promise.resolve([{ partition: 0, baseOffset: '1' }])) });
  const pub = createKafkaPublisher({ statsIntervalMs: 0, config: cfg({ maxInFlight: 1 }), logger: SILENT, kafka });
  await assert.rejects(pub.publish({ topic: 't', key: 'k', value: 'v' }), (e) => e.category === 'timeout');
  assert.equal(pub.stats().inFlight, 0);
  assert.equal((await pub.publish({ topic: 't', key: 'k', value: 'v' })).offset, '1');
});

test('send failure rejects with a categorized error; connect failure reconnects later', async () => {
  const { kafka } = fakeKafka({
    connect: async (n) => { if (n === 1) throw new Error('broker down'); },
  });
  const pub = createKafkaPublisher({ statsIntervalMs: 0, config: cfg(), logger: SILENT, kafka });
  await assert.rejects(pub.publish({ topic: 't', key: 'k', value: 'v' }), (e) => e instanceof KafkaPublishError);
  assert.equal((await pub.publish({ topic: 't', key: 'k', value: 'v' })).partition, 2);
  const failing = fakeKafka({ send: async () => { const e = new Error('x'); e.name = 'KafkaJSNumberOfRetriesExceeded'; throw e; } });
  const p2 = createKafkaPublisher({ statsIntervalMs: 0, config: cfg(), logger: SILENT, kafka: failing.kafka });
  await assert.rejects(p2.publish({ topic: 't', key: 'k', value: 'v' }), (e) => e.category === 'unavailable');
});

test('repeated connection failures rebuild the producer; the new one then publishes', async () => {
  let built = 0;
  const makeProducer = (broken) => ({
    events: { DISCONNECT: 'producer.disconnect' },
    on() {},
    connect: async () => { if (broken) throw new Error('Connection timeout'); },
    disconnect: async () => {},
    send: async () => [{ partition: 0, baseOffset: '9' }],
  });
  const kafka = { producer: () => makeProducer(++built === 1) }; // first producer is wedged
  const pub = createKafkaPublisher({ statsIntervalMs: 0, resetMinIntervalMs: 0, config: cfg(), logger: SILENT, kafka });
  await assert.rejects(pub.publish({ topic: 't', key: 'k', value: 'v' }), (e) => e.category === 'unavailable');
  assert.equal(pub.stats().resets, 1);
  assert.equal((await pub.publish({ topic: 't', key: 'k', value: 'v' })).offset, '9');
  assert.equal(built, 2);
});

test('rebuilds are rate-limited so a long outage does not churn producers', async () => {
  let built = 0;
  const kafka = { producer: () => (built++, { events: {}, on() {}, connect: async () => { throw new Error('Connection timeout'); }, disconnect: async () => {}, send: async () => [] }) };
  const pub = createKafkaPublisher({ statsIntervalMs: 0, resetMinIntervalMs: 60000, config: cfg(), logger: SILENT, kafka });
  for (let i = 0; i < 5; i++) await pub.publish({ topic: 't', key: 'k', value: 'v' }).catch(() => {});
  assert.ok(built <= 2, `built ${built}`);
});

test('config reads KAFKA_BOOTSTRAP_SERVERS with the kafka-service default', () => {
  assert.deepEqual(readKafkaConfig({}).brokers, ['kafka-service:9092']);
  assert.deepEqual(readKafkaConfig({ KAFKA_BOOTSTRAP_SERVERS: 'a:1, b:2' }).brokers, ['a:1', 'b:2']);
});

test('no SQS, Mongo or MySQL code in the intent /track path', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const files = ['controllers/trackIntent.js', 'services/intent/kafkaProducer.js', 'services/intent/topicRouting.js', 'services/intent/normalize.js', 'services/intent/messageContract.js', 'services/intent/productResolution.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.equal(/sqs|mongoose|mysql|SendMessage|models\//i.test(src), false, f);
  }
});
