const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createIntentTrack, buildIntentMessage } = require('../controllers/trackIntent');
const {
  classifyClick,
  classifyClickSignals,
  normalizeResponseSignals,
  normalizeIntentBody,
  IntentValidationError,
} = require('../services/intent/normalize');
const { validateMessage } = require('../services/intent/messageContract');
const { createBrandAllowlist } = require('../services/intent/brandAllowlist');

const SILENT = { info() {}, warn() {}, error() {} };
const ALLOW = createBrandAllowlist({ INTENT_BRANDS_ALLOWLIST: 'bbb_shop', INTENT_BRAND_TIMEZONES: 'bbb_shop=Asia/Kolkata' });

const NONE = { url_changed: false, cart_changed: false, ui_changed: false, meaningful_scroll: false };
const resp = (event_name, category = 'other', occurred_at = '2026-11-04T05:00:01.000Z') => ({ event_name, category, occurred_at });

const click = (signals, extra = {}) => ({
  brand_id: 'bbb_shop',
  event_id: 'ck-1',
  event_name: 'click',
  occurred_at: '2026-11-04T05:00:00.000Z',
  client_id: 'cid-1',
  visitor_id: 'cid-1',
  actor_id: 'actor_1',
  url: null,
  referrer: null,
  user_agent: null,
  session_id: null,
  data: {
    click: { x: 1, y: 2, page_x: 1, page_y: 2, tag_name: 'BUTTON', element_id: 'b', element_name: null, element_type: null, element_value: null, href: null },
    signals,
    observation_window_ms: 1250,
  },
  ...extra,
});
const bucket = (signals) => buildIntentMessage(click(signals), 'bbb_shop', 'Asia/Kolkata').click_bucket;

// ---- the four old booleans (legacy contract) -------------------------------------------------------------------

test('1. legacy: all four booleans false -> dead', () => {
  assert.equal(bucket(NONE), 'dead_click');
});

for (const field of ['url_changed', 'cart_changed', 'ui_changed', 'meaningful_scroll']) {
  test(`2-5. legacy: ${field} true -> useful`, () => {
    assert.equal(bucket({ ...NONE, [field]: true }), 'useful_click');
  });
}

// ---- response_signals -----------------------------------------------------------------------------------------

test('6. new contract: response_signals [] and all booleans false -> dead', () => {
  assert.equal(bucket({ ...NONE, response_signals: [] }), 'dead_click');
});

test('7. new contract: one response signal -> useful', () => {
  assert.equal(bucket({ ...NONE, response_signals: [resp('product_viewed', 'product')] }), 'useful_click');
});

test('8. several response signals are still ONE click and ONE bucket', () => {
  const message = buildIntentMessage(
    click({ ...NONE, response_signals: [resp('product_viewed', 'product'), resp('collection_viewed', 'collection'), resp('page_viewed', 'navigation')] }),
    'bbb_shop',
    null,
  );
  assert.equal(message.type, 'click');
  assert.equal(message.click_bucket, 'useful_click');
  assert.equal(message.signals.response_signals.length, 3);
  assert.deepEqual(message.signals.response_categories, ['product', 'collection', 'navigation']);
});

test('9. an unknown response signal is still a response -> useful, category other', () => {
  const c = classifyClickSignals({ ...NONE, response_signals: [resp('some_future_shopify_event', 'other')] });
  assert.equal(c.useful_click, true);
  assert.deepEqual(c.response_signals.map((r) => [r.event_name, r.category]), [['some_future_shopify_event', 'other']]);
});

test('10. missing response_signals behaves like the legacy contract', () => {
  assert.equal(bucket(NONE), 'dead_click');
  assert.equal(bucket({ ...NONE, url_changed: true }), 'useful_click');
  const c = classifyClickSignals(NONE);
  assert.deepEqual(c.response_signals, []);
  assert.equal(c.contract_version, 1);
});

test('11. null response_signals behaves like the legacy contract', () => {
  assert.equal(bucket({ ...NONE, response_signals: null }), 'dead_click');
  assert.equal(bucket({ ...NONE, cart_changed: true, response_signals: null }), 'useful_click');
  assert.equal(classifyClickSignals({ ...NONE, response_signals: null }).contract_version, 1);
});

test('12. the pixel says useful_click=false but there is a response signal -> useful', () => {
  assert.equal(bucket({ ...NONE, useful_click: false, dead_click: true, response_signals: [resp('cart_viewed', 'cart')] }), 'useful_click');
});

test('13. the pixel says useful_click=true but nothing was observed -> dead', () => {
  assert.equal(bucket({ ...NONE, useful_click: true, dead_click: false, response_signals: [] }), 'dead_click');
});

test('13b. the client classification is not carried into the message, only the server one', () => {
  const m = buildIntentMessage(click({ ...NONE, useful_click: true, dead_click: false, response_signals: [] }), 'bbb_shop', null);
  assert.equal(m.signals.useful_click, false);
  assert.equal(m.signals.dead_click, true);
});

test('14. category is normalised from the event name, not trusted from the pixel', () => {
  const expected = {
    page_viewed: 'navigation',
    product_viewed: 'product',
    product_added_to_cart: 'cart',
    product_removed_from_cart: 'cart',
    cart_viewed: 'cart',
    collection_viewed: 'collection',
    search_submitted: 'search',
    checkout_started: 'checkout',
    checkout_contact_info_submitted: 'checkout',
    checkout_address_info_submitted: 'checkout',
    checkout_shipping_info_submitted: 'checkout',
    payment_info_submitted: 'checkout',
    checkout_completed: 'checkout',
    Started_Checkout_GK: 'checkout',
    input_focused: 'form',
    input_changed: 'form',
    form_submitted: 'form',
    alert_displayed: 'alert',
    scroll_depth: 'scroll',
  };
  for (const [name, category] of Object.entries(expected)) {
    // the pixel claims a wrong category for every one of them
    assert.equal(normalizeResponseSignals([resp(name, 'product')])[0].category, category, name);
  }
  assert.equal(normalizeResponseSignals([resp('started_checkout_gk', 'other')])[0].category, 'checkout'); // case-insensitive
  assert.equal(normalizeResponseSignals([resp('brand_new_event', 'product')])[0].category, 'other');
});

test('15. the same response signal sent twice does not duplicate anything', () => {
  const c = classifyClickSignals({ ...NONE, response_signals: [resp('product_viewed'), resp('product_viewed'), resp('page_viewed')] });
  assert.deepEqual(c.response_signals.map((r) => r.event_name), ['product_viewed', 'page_viewed']);
  const m = buildIntentMessage(click({ ...NONE, response_signals: [resp('product_viewed'), resp('product_viewed')] }), 'bbb_shop', null);
  assert.equal(m.click_bucket, 'useful_click'); // one click, one bucket
});

test('16. an old-shape payload (no response_signals, no client flags) still validates and classifies', () => {
  const legacyBody = click(NONE);
  delete legacyBody.data.observation_window_ms;
  delete legacyBody.data.click.page_x;
  delete legacyBody.data.click.page_y;
  const message = buildIntentMessage(legacyBody, 'bbb_shop', null);
  assert.deepEqual(validateMessage(message), []);
  assert.equal(message.click_bucket, 'dead_click');
  assert.equal(message.click.page_x, null);
});

test('17. a scroll response only marks the click: it creates no scroll event and no scroll counter field', () => {
  const m = buildIntentMessage(click({ ...NONE, meaningful_scroll: true, response_signals: [resp('scroll_depth', 'scroll')] }), 'bbb_shop', null);
  assert.equal(m.type, 'click');
  assert.equal(m.event_name, 'click');
  assert.equal(m.click_bucket, 'useful_click');
  assert.equal('scroll_percent' in m, false);
  assert.equal(m.signals.response_signals[0].category, 'scroll');
});

// ---- tolerance of odd input -------------------------------------------------------------------------------------

test('malformed response_signals never reject the click', () => {
  for (const odd of ['text', 5, {}, [null, 3, 'x', [], {}, { event_name: '' }, { event_name: 7 }, { category: 'product' }]]) {
    const message = buildIntentMessage(click({ ...NONE, response_signals: odd }), 'bbb_shop', null);
    assert.equal(message.click_bucket, 'dead_click', JSON.stringify(odd));
    assert.deepEqual(message.signals.response_signals, []);
  }
});

test('response signals are bounded: long names are clipped, at most 30 entries, bad timestamps become null', () => {
  const many = Array.from({ length: 50 }, (_, i) => resp(`event_${i}`));
  assert.equal(normalizeResponseSignals(many).length, 30);
  assert.equal(normalizeResponseSignals([resp('x'.repeat(200))])[0].event_name.length, 64);
  assert.equal(normalizeResponseSignals([{ event_name: 'page_viewed', occurred_at: 'not a date' }])[0].occurred_at, null);
});

test('the four booleans are still required: a missing one is rejected as before', () => {
  const body = click({ url_changed: true, cart_changed: false, ui_changed: false, response_signals: [resp('page_viewed')] });
  assert.throws(() => normalizeIntentBody(body), IntentValidationError);
});

test('classifyClick keeps returning the bucket name for existing callers', () => {
  assert.equal(classifyClick(NONE), 'dead_click');
  assert.equal(classifyClick({ ...NONE, response_signals: [resp('page_viewed')] }), 'useful_click');
  assert.equal(classifyClick(undefined), 'dead_click');
});

// ---- through the real /track handler ----------------------------------------------------------------------------

test('POST /track publishes the cleaned signals and the server bucket on intent.click', async () => {
  const sent = [];
  const publisher = { publish: async (m) => (sent.push(m), { partition: 0, offset: '1' }) };
  const app = express();
  app.use(express.json());
  app.post('/track', createIntentTrack({ publisher, brandAllowlist: ALLOW, logger: SILENT }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/track`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(click({ ...NONE, useful_click: false, dead_click: true, response_signals: [resp('product_viewed', 'product')] })),
    });
    assert.equal(res.status, 202);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].topic, 'intent.click');
    const message = JSON.parse(sent[0].value);
    assert.equal(message.click_bucket, 'useful_click');
    assert.equal(message.signals.useful_click, true);
    assert.equal(message.signals.contract_version, 2);
    assert.deepEqual(message.signals.response_signals.map((r) => r.event_name), ['product_viewed']);
    assert.equal(message.click.page_x, 1);
  } finally {
    server.close();
  }
});

// ---- brand: body brand_id, or the X-Brand header the Click Signal V2 pixel sends --------------------------------

async function postTrack(body, headers = {}) {
  const sent = [];
  const publisher = { publish: async (m) => (sent.push(m), { partition: 0, offset: '1' }) };
  const app = express();
  app.use(express.json());
  app.post('/track', createIntentTrack({ publisher, brandAllowlist: ALLOW, logger: SILENT }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/track`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json(), sent };
  } finally {
    server.close();
  }
}

test('the new pixel sends no brand_id in the body, only X-Brand: the click is accepted for that brand', async () => {
  const body = click({ ...NONE, response_signals: [resp('page_viewed')] });
  delete body.brand_id;
  const out = await postTrack(body, { 'X-Brand': 'bbb_shop' });
  assert.equal(out.status, 202);
  assert.equal(JSON.parse(out.sent[0].value).brand_id, 'bbb_shop');
});

test('a brand_id in the body wins over the header', async () => {
  const out = await postTrack(click(NONE), { 'X-Brand': 'ghost_shop' });
  assert.equal(out.status, 202);
  assert.equal(JSON.parse(out.sent[0].value).brand_id, 'bbb_shop');
});

test('no brand at all, a blank one, or a brand not on the allow-list is still refused with 400', async () => {
  const noBrand = click(NONE);
  delete noBrand.brand_id;
  assert.equal((await postTrack(noBrand)).status, 400);
  assert.equal((await postTrack(noBrand, { 'X-Brand': '   ' })).status, 400);
  const unlisted = await postTrack(noBrand, { 'X-Brand': 'ghost_shop' });
  assert.equal(unlisted.status, 400);
  assert.equal(unlisted.json.error, 'unknown or inactive brand_id');
  assert.equal(unlisted.sent.length, 0);
});

test('the header works for every intent event, not only clicks (page_viewed here)', async () => {
  const out = await postTrack(
    { event_id: 'pv-1', event_name: 'page_viewed', occurred_at: '2026-11-04T05:00:00.000Z', client_id: 'c', visitor_id: 'c', actor_id: 'a', url: 'https://x.com/', referrer: null, user_agent: null, session_id: null, data: {} },
    { 'X-Brand': 'bbb_shop' },
  );
  assert.equal(out.status, 202);
});
