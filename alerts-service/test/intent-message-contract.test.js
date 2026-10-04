const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SCHEMA_VERSION,
  MESSAGE_TYPES,
  buildEventMessage,
  buildClickMessage,
  buildSessionSnapshotMessage,
  compactEventsSeq,
  validateMessage,
  serializeMessage,
  messageBytes,
} = require('../services/intent/messageContract');

const when = new Date('2026-10-04T06:07:53.497Z');

function eventDoc(overrides = {}) {
  return {
    brand_id: 'bbb_shop',
    event_id: 'sh-1',
    session_id: 'sess-1',
    actor_id: 'actor-1',
    event_name: 'product_viewed',
    occurred_at: when,
    url: 'https://blabliblulife.com/products/x',
    referrer: null,
    user_agent: 'UA',
    client_id: 'cid-1',
    visitor_id: 'vid-1',
    session_start: new Date('2026-10-04T06:00:00.000Z'),
    session_end: null,
    session_time_spent: null,
    raw: { product_id: 'gid://shopify/Product/9', variant_id: '77', price: 499 },
    ...overrides,
  };
}

function clickDoc(overrides = {}) {
  return {
    brand_id: 'bbb_shop',
    event_id: 'shu-1',
    event_name: 'click',
    occurred_at: when,
    ingested_at: new Date(),
    client_id: 'cid-1',
    visitor_id: 'vid-1',
    session_id: 'sess-1',
    actor_id: 'actor-1',
    session_start: new Date('2026-10-04T06:00:00.000Z'),
    session_end: null,
    session_time_spent: null,
    url: 'https://blabliblulife.com/cart',
    referrer: 'https://instagram.com/',
    user_agent: 'UA',
    click: { x: 266, y: 598, tag_name: 'BUTTON', element_id: 'add', element_name: null, element_type: 'submit', element_value: null, href: null },
    signals: { url_changed: false, cart_changed: true, ui_changed: false, meaningful_scroll: false },
    click_bucket: 'useful_click',
    raw: { event_id: 'shu-1' },
    ...overrides,
  };
}

test('event message keeps every field the pipeline reads, with dates as ISO strings', () => {
  const msg = buildEventMessage(eventDoc());

  assert.equal(msg.schema_version, SCHEMA_VERSION);
  assert.equal(msg.type, MESSAGE_TYPES.EVENT);
  assert.equal(msg.message_key, 'sh-1');
  assert.equal(msg.brand_id, 'bbb_shop');
  assert.equal(msg.event_id, 'sh-1');
  assert.equal(msg.event_name, 'product_viewed');
  assert.equal(msg.actor_id, 'actor-1');
  assert.equal(msg.client_id, 'cid-1');
  assert.equal(msg.visitor_id, 'vid-1');
  assert.equal(msg.session_id, 'sess-1');
  assert.equal(msg.occurred_at, '2026-10-04T06:07:53.497Z');
  assert.equal(msg.url, 'https://blabliblulife.com/products/x');
  assert.equal(msg.referrer, null);
  assert.equal(msg.user_agent, 'UA');
  assert.equal(msg.session_start, '2026-10-04T06:00:00.000Z');
  assert.deepEqual(msg.raw, { product_id: 'gid://shopify/Product/9', variant_id: '77', price: 499 });
});

test('occurred_at is preserved exactly: no timezone shift is applied', () => {
  const stored = new Date('2026-10-04T11:37:53.497Z');
  const msg = buildEventMessage(eventDoc({ occurred_at: stored }));
  assert.equal(new Date(msg.occurred_at).getTime(), stored.getTime());
});

test('event message requires brand_id, event_id and event_name', () => {
  assert.throws(() => buildEventMessage(eventDoc({ event_id: undefined })), /event_id/);
  assert.throws(() => buildEventMessage(eventDoc({ event_name: '' })), /event_name/);
  assert.throws(() => buildEventMessage(eventDoc({ brand_id: undefined })), /brand_id/);
});

test('click message carries click, signals and click_bucket for the pipeline', () => {
  const msg = buildClickMessage(clickDoc());

  assert.equal(msg.type, MESSAGE_TYPES.CLICK);
  assert.equal(msg.event_name, 'click');
  assert.equal(msg.click_bucket, 'useful_click');
  assert.deepEqual(msg.click, clickDoc().click);
  assert.deepEqual(msg.signals, clickDoc().signals);
  assert.equal(msg.session_start, '2026-10-04T06:00:00.000Z');
  assert.equal(msg.occurred_at, '2026-10-04T06:07:53.497Z');
  assert.equal(validateMessage(msg).length, 0);
});

test('session snapshot compacts events_seq to the fields the rollup reads', () => {
  const seq = {
    1: { event_name: 'page_viewed', event_id: 'p1', client_id: 'c', visitor_id: 'v', url: 'x', raw: { big: 'payload' } },
    2: { event_name: 'click', event_id: 'k1', click_bucket: 'dead_click', client_id: 'c', visitor_id: 'v', click: { x: 1 } },
  };
  assert.deepEqual(compactEventsSeq(seq), {
    1: { event_name: 'page_viewed', event_id: 'p1', click_bucket: null, client_id: 'c', visitor_id: 'v' },
    2: { event_name: 'click', event_id: 'k1', click_bucket: 'dead_click', client_id: 'c', visitor_id: 'v' },
  });
});

test('session snapshot carries rollup timing, compact sequence and a source version', () => {
  const sessionDoc = {
    brand_id: 'bbb_shop',
    session_id: 'sess-9',
    actor_id: 'actor-9',
    session_start: new Date('2026-10-04T06:00:00.000Z'),
    session_end: new Date('2026-10-04T06:10:00.000Z'),
    session_time_spent: 600000,
    occurred_at: new Date('2026-10-04T06:00:00.000Z'),
    events_seq: { 1: { event_name: 'page_viewed', event_id: 'p1', client_id: 'c', visitor_id: 'v' } },
    last_ref: { collection: 'events', event_id: 'p1' },
  };
  const msg = buildSessionSnapshotMessage(sessionDoc, { sourceUpdatedAt: new Date('2026-10-04T06:10:00.001Z') });

  assert.equal(msg.type, MESSAGE_TYPES.SESSION_SNAPSHOT);
  assert.equal(msg.message_key, 'session:sess-9');
  assert.equal(msg.session_end, '2026-10-04T06:10:00.000Z');
  assert.equal(msg.session_time_spent, 600000);
  assert.equal(msg.source_updated_at, '2026-10-04T06:10:00.001Z');
  assert.equal(msg.last_ref, undefined, 'producer-only cursor pointer must not leak into the contract');
  assert.equal(validateMessage(msg).length, 0);
});

test('session snapshot requires a source version for the stale-snapshot guard', () => {
  assert.throws(
    () => buildSessionSnapshotMessage({ brand_id: 'b', session_id: 's', actor_id: 'a', events_seq: {} }),
    /sourceUpdatedAt/,
  );
});

test('validateMessage rejects wrong schema version, unknown type and bad buckets', () => {
  const good = buildClickMessage(clickDoc());
  assert.deepEqual(validateMessage({ ...good, schema_version: 2 }).length > 0, true);
  assert.deepEqual(validateMessage({ ...good, type: 'mystery' }).length > 0, true);
  assert.deepEqual(validateMessage({ ...good, click_bucket: 'maybe' }).length > 0, true);
  assert.deepEqual(validateMessage({ ...good, occurred_at: 'not a date' }).length > 0, true);
});

test('serializeMessage refuses to produce an invalid message', () => {
  assert.throws(() => serializeMessage({ schema_version: 1, type: 'event' }), /invalid intent message/);
});

test('round trip through JSON preserves the message exactly', () => {
  const msg = buildEventMessage(eventDoc());
  const parsed = JSON.parse(serializeMessage(msg));
  assert.deepEqual(parsed, msg);
});

test('builders never mutate their input documents', () => {
  const doc = eventDoc();
  const snapshot = JSON.stringify(doc);
  buildEventMessage(doc);
  assert.equal(JSON.stringify(doc), snapshot);
});

test('messageBytes reports the serialized size used for the SQS 256 KB limit', () => {
  const msg = buildEventMessage(eventDoc());
  assert.equal(messageBytes(msg), Buffer.byteLength(JSON.stringify(msg), 'utf8'));
});
