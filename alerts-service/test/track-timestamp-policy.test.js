const test = require('node:test');
const assert = require('node:assert/strict');

const { buildIntentMessage } = require('../controllers/trackIntent');
const { normalizeOccurredAt, futureToleranceMs, DEFAULT_FUTURE_TOLERANCE_S } = require('../services/intent/timestampPolicy');
const { validateMessage, serializeMessage } = require('../services/intent/messageContract');

const NOW = new Date('2026-10-05T05:00:00.000Z'); // the instant /track receives the event: 10:30 in Asia/Kolkata
const TZ = 'Asia/Kolkata';
const body = (occurredAt, o = {}) => ({
  brand_id: 'bbb_shop', event_id: 'sh-1', event_name: 'page_viewed', occurred_at: occurredAt, client_id: 'cid-1', visitor_id: null,
  actor_id: 'actor_1', url: 'https://blabliblulife.com/', referrer: null, user_agent: 'UA', session_id: null, data: {}, ...o,
});
const plusSeconds = (s) => new Date(NOW.getTime() + s * 1000).toISOString();

test('the tolerance defaults to 5 minutes and can be overridden', () => {
  assert.equal(DEFAULT_FUTURE_TOLERANCE_S, 300);
  assert.equal(futureToleranceMs({}), 300000);
  assert.equal(futureToleranceMs({ INTENT_FUTURE_TOLERANCE_S: '60' }), 60000);
  assert.throws(() => futureToleranceMs({ INTENT_FUTURE_TOLERANCE_S: 'abc' }));
  assert.throws(() => futureToleranceMs({ INTENT_FUTURE_TOLERANCE_S: '-1' }));
});

test('a client up to the tolerance ahead is accepted as sent; one second more is replaced by the receipt time', () => {
  assert.deepEqual(normalizeOccurredAt(new Date(NOW.getTime() + 300000), NOW, 300000).normalized, false);
  const over = normalizeOccurredAt(new Date(NOW.getTime() + 300001), NOW, 300000);
  assert.equal(over.normalized, true);
  assert.equal(over.effective.getTime(), NOW.getTime());
  assert.equal(normalizeOccurredAt(new Date(NOW.getTime() - 3 * 3600 * 1000), NOW, 300000).normalized, false); // late events are untouched
});

test('a normal event keeps its time and gets the receipt time stamped', () => {
  const m = buildIntentMessage(body(plusSeconds(-2)), 'bbb_shop', TZ, NOW);
  assert.equal(m.occurred_at, '2026-10-05T10:29:58.000Z');         // store-local wall clock, as before
  assert.equal(m.client_occurred_at, m.occurred_at);
  assert.equal(m.received_at, '2026-10-05T10:30:00.000Z');
  assert.deepEqual(validateMessage(m), []);
});

test('a slightly fast device clock is not touched', () => {
  const m = buildIntentMessage(body(plusSeconds(120)), 'bbb_shop', TZ, NOW);
  assert.equal(m.occurred_at, '2026-10-05T10:32:00.000Z');
  assert.equal(m.client_occurred_at, m.occurred_at);
});

test('a clock hours ahead takes the receipt time for sessions and keeps the raw client time', () => {
  const m = buildIntentMessage(body(plusSeconds(13.4 * 3600)), 'bbb_shop', TZ, NOW);
  assert.equal(m.occurred_at, m.received_at);
  assert.equal(m.occurred_at, '2026-10-05T10:30:00.000Z');
  assert.equal(m.client_occurred_at, '2026-10-05T23:54:00.000Z');
  assert.notEqual(m.occurred_at, m.client_occurred_at);
  assert.deepEqual(validateMessage(m), []);
});

test('the year-2040 event cannot become an occurred_at, and nothing is dropped', () => {
  const m = buildIntentMessage(body('2040-01-01T01:05:35.922Z'), 'bbb_shop', TZ, NOW);
  assert.equal(m.occurred_at, '2026-10-05T10:30:00.000Z');
  assert.equal(m.client_occurred_at, '2040-01-01T06:35:35.922Z');
  assert.equal(JSON.parse(serializeMessage(m)).client_occurred_at, '2040-01-01T06:35:35.922Z');
});

test('clicks follow the same rule', () => {
  const click = body(plusSeconds(4 * 3600), {
    event_id: 'shu-1', event_name: 'click',
    data: { click: { x: 1, y: 2, tag_name: 'BUTTON', element_id: 'a', element_name: null, element_type: null, element_value: null, href: null },
            signals: { url_changed: false, cart_changed: true, ui_changed: false, meaningful_scroll: false } },
  });
  const m = buildIntentMessage(click, 'bbb_shop', TZ, NOW);
  assert.equal(m.type, 'click');
  assert.equal(m.occurred_at, m.received_at);
  assert.equal(m.client_occurred_at, '2026-10-05T14:30:00.000Z');
});

test('an invalid timestamp is still rejected, not normalized', () => {
  assert.throws(() => buildIntentMessage(body('not a time'), 'bbb_shop', TZ, NOW), /invalid occurred_at/);
});
