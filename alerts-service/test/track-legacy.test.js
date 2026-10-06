const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const { createLegacyTrack } = require('../controllers/trackLegacy');

const SILENT = { info() {}, warn() {}, error() {} };

function fakeSession({ existing = null, saveError = null } = {}) {
  const saved = [];
  const finds = [];
  class Session {
    constructor(doc) { this.doc = doc; }
    async save() { if (saveError) throw saveError; saved.push(this.doc); }
    static async findOne(q) { finds.push(q); return existing; }
  }
  return { Session, saved, finds };
}

async function call(Session, body) {
  const app = express();
  app.use(express.json());
  app.post('/track', createLegacyTrack({ Session, logger: SILENT }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/track`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally { server.closeAllConnections?.(); server.close(); }
}

const ci = (o = {}) => ({ event_id: 'e1', idempotency_key: 'idem-1', event_type: 'product_viewed', shop_name: 'bbb', session_id: 's', data: {}, ...o });

test('CI payload is saved as a Session and returns 201', async () => {
  const f = fakeSession();
  const r = await call(f.Session, ci());
  assert.equal(r.status, 201);
  assert.deepEqual(r.json, { message: 'Session tracked successfully' });
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].idempotency_key, 'idem-1');
  assert.deepEqual(f.finds, [{ idempotency_key: 'idem-1' }]);
});

test('duplicate idempotency_key returns 200 and saves nothing', async () => {
  const f = fakeSession({ existing: { idempotency_key: 'idem-1' } });
  const r = await call(f.Session, ci());
  assert.equal(r.status, 200);
  assert.equal(r.json.message, 'Event already processed');
  assert.equal(f.saved.length, 0);
});

test('missing idempotency_key returns 400 and touches nothing, including former RS shapes', async () => {
  for (const b of [{ event_type: 'x' }, { orderId: 'ord-1' }, { tags: 'RS_Cinema_KP', customer_id: 'c' }]) {
    const f = fakeSession();
    const r = await call(f.Session, b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal(r.json.error, 'idempotency_key is required');
    assert.equal(f.saved.length + f.finds.length, 0);
  }
});

test('a save failure returns 500 with a generic body', async () => {
  const f = fakeSession({ saveError: new Error('mongo down at 10.0.0.1') });
  const r = await call(f.Session, ci());
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: 'Failed to track alert' });
});

test('RS handling is gone from the live code and kept only in deadCode.js, which nothing imports', () => {
  const root = path.join(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const live = ['app.js', 'controllers/trackLegacy.js', 'controllers/trackIntent.js'];
  for (const f of live) {
    assert.equal(/OtpVerified|AjrsPurchase|RS_Cinema_KP/.test(read(f)), false, f);
    assert.equal(/deadCode/.test(read(f)), false, `${f} must not import deadCode`);
  }
  assert.match(read('deadCode.js'), /RS_Cinema_KP/);
});
