// Real-broker test of /track -> Kafka. Skipped unless KAFKA_INTEGRATION_BROKERS is set
// (e.g. kafka-service:9092, run from a container on pipeline-net). The consumer below
// exists only to read back what /track published; it is not worker code.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Kafka, logLevel } = require('kafkajs');

const { createIntentTrack } = require('../../controllers/trackIntent');
const { createKafkaPublisher } = require('../../services/intent/kafkaProducer');
const { createBrandAllowlist } = require('../../services/intent/brandAllowlist');

const BROKERS = process.env.KAFKA_INTEGRATION_BROKERS;
const SILENT = { info() {}, warn() {}, error() {} };

const ev = (o) => ({
  brand_id: 'bbb_shop', occurred_at: '2026-10-05T05:00:00.000Z', client_id: 'cid-int', visitor_id: null,
  actor_id: 'actor_int', url: 'https://blabliblulife.com/', referrer: null, user_agent: 'UA', session_id: null, data: {}, ...o,
});

test('real Kafka: /track publishes normalized events to the right topic with the right key', { skip: !BROKERS }, async () => {
  const run = Date.now().toString(36);
  const ids = {
    checkout: `it-${run}-checkout`, atc: `it-${run}-atc`, click: `it-${run}-click`, other: `it-${run}-other`,
  };
  const brokers = BROKERS.split(',');
  const kafka = new Kafka({ clientId: 'it-reader', brokers, logLevel: logLevel.NOTHING });
  const consumer = kafka.consumer({ groupId: `it-${run}` });
  const seen = new Map();
  await consumer.connect();
  for (const t of ['intent.checkout', 'intent.atc', 'intent.click', 'intent.other']) {
    await consumer.subscribe({ topic: t, fromBeginning: false });
  }
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const value = JSON.parse(message.value.toString());
      if (Object.values(ids).includes(value.event_id)) {
        seen.set(value.event_id, { topic, partition, key: message.key.toString(), value });
      }
    },
  });
  await new Promise((r) => setTimeout(r, 3000)); // let the group join before publishing

  const publisher = createKafkaPublisher({ config: { brokers, clientId: 'it-track', sendTimeoutMs: 8000, maxInFlight: 50, connectionTimeoutMs: 5000 }, logger: SILENT });
  const allow = createBrandAllowlist({ INTENT_BRANDS_ALLOWLIST: 'bbb_shop', INTENT_BRAND_TIMEZONES: 'bbb_shop=Asia/Kolkata' });
  const app = express();
  app.use(express.json());
  app.post('/track', createIntentTrack({ publisher, brandAllowlist: allow, logger: SILENT }));
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const url = `http://127.0.0.1:${server.address().port}/track`;
  const post = (b) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

  try {
    const sends = [
      ev({ event_id: ids.checkout, event_name: 'checkout_started' }),
      ev({ event_id: ids.atc, event_name: 'product_added_to_cart', data: { product_id: 'gid://shopify/Product/42' } }),
      ev({ event_id: ids.click, event_name: 'click', data: {
        click: { x: 1, y: 2, tag_name: 'A', element_id: null, element_name: null, element_type: null, element_value: null, href: null },
        signals: { url_changed: true, cart_changed: false, ui_changed: false, meaningful_scroll: false } } }),
      ev({ event_id: ids.other, event_name: 'page_viewed' }),
    ];
    for (const b of sends) assert.equal((await post(b)).status, 202, b.event_name);

    const deadline = Date.now() + 20000;
    while (seen.size < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    assert.equal(seen.size, 4, 'all four events must be readable from Kafka');

    const expected = { [ids.checkout]: 'intent.checkout', [ids.atc]: 'intent.atc', [ids.click]: 'intent.click', [ids.other]: 'intent.other' };
    for (const [id, topic] of Object.entries(expected)) {
      const got = seen.get(id);
      assert.equal(got.topic, topic);
      assert.equal(got.key, 'bbb_shop:actor_int');
      assert.equal(got.value.event_id, id, 'event_id must arrive unchanged');
      assert.equal(got.value.schema_version, 1);
      assert.equal(got.value.brand_id, 'bbb_shop');
      assert.equal(got.value.occurred_at, '2026-10-05T10:30:00.000Z');
    }
    assert.equal(seen.get(ids.atc).value.raw.product_id, 'Product:42');
    assert.equal(seen.get(ids.click).value.click_bucket, 'useful_click');
    // Same actor key -> same partition within a topic.
    assert.equal(typeof seen.get(ids.click).partition, 'number');
  } finally {
    server.close();
    await publisher.shutdown();
    await consumer.disconnect();
  }
});
