const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createIntentTrack, buildIntentMessage } = require('../controllers/trackIntent');
const { classifyClick, normalizeIntentBody, IntentValidationError } = require('../services/intent/normalize');
const { validateMessage } = require('../services/intent/messageContract');
const { createBrandAllowlist } = require('../services/intent/brandAllowlist');

const SILENT = { info() {}, warn() {}, error() {} };
const ALLOW = createBrandAllowlist({ INTENT_BRANDS_ALLOWLIST: 'bbb_shop', INTENT_BRAND_TIMEZONES: 'bbb_shop=Asia/Kolkata' });

const NONE = { url_changed: false, cart_changed: false, ui_changed: false, meaningful_scroll: false };

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
  },
  ...extra,
});
const bucket = (signals) => buildIntentMessage(click(signals), 'bbb_shop', 'Asia/Kolkata').click_bucket;

// ---- click classification: the four booleans decide the bucket ----------------------------------------------------

test('all four booleans false -> dead', () => {
  assert.equal(bucket(NONE), 'dead_click');
});

for (const field of ['url_changed', 'cart_changed', 'ui_changed', 'meaningful_scroll']) {
  test(`${field} true -> useful`, () => {
    assert.equal(bucket({ ...NONE, [field]: true }), 'useful_click');
  });
}

test('the four booleans are required: a missing one is rejected', () => {
  const body = click({ url_changed: true, cart_changed: false, ui_changed: false });
  assert.throws(() => normalizeIntentBody(body), IntentValidationError);
});

test('classifyClick returns the bucket name', () => {
  assert.equal(classifyClick(NONE), 'dead_click');
  assert.equal(classifyClick({ ...NONE, ui_changed: true }), 'useful_click');
  assert.equal(classifyClick(undefined), 'dead_click');
});

test('extra signal fields sent by a newer pixel are ignored: only the four booleans decide', () => {
  const extra = { ...NONE, useful_click: true, dead_click: false, response_signals: [{ event_name: 'product_viewed' }] };
  assert.equal(bucket(extra), 'dead_click');
  const m = buildIntentMessage(click(extra), 'bbb_shop', null);
  assert.deepEqual(m.signals, NONE);
});

// ---- page_x / page_y (document-relative coordinates) ---------------------------------------------------------------

test('page_x and page_y pass through, and default to null for a pixel that omits them', () => {
  const full = buildIntentMessage(click(NONE), 'bbb_shop', null);
  assert.equal(full.click.page_x, 1);
  assert.equal(full.click.page_y, 2);
  const legacyBody = click(NONE);
  delete legacyBody.data.click.page_x;
  delete legacyBody.data.click.page_y;
  const legacy = buildIntentMessage(legacyBody, 'bbb_shop', null);
  assert.deepEqual(validateMessage(legacy), []);
  assert.equal(legacy.click.page_x, null);
  assert.equal(legacy.click.page_y, null);
});

// ---- brand: body brand_id, or the X-Brand header ------------------------------------------------------------------

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

test('POST /track publishes the click on intent.click with the four-boolean bucket', async () => {
  const out = await postTrack(click({ ...NONE, url_changed: true }));
  assert.equal(out.status, 202);
  assert.equal(out.sent[0].topic, 'intent.click');
  const message = JSON.parse(out.sent[0].value);
  assert.equal(message.click_bucket, 'useful_click');
  assert.equal(message.click.page_x, 1);
});

test('no brand_id in the body, only X-Brand: the click is accepted for that brand', async () => {
  const body = click(NONE);
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
