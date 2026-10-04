const test = require('node:test');
const assert = require('node:assert/strict');

const { createIntentIngestor } = require('../../services/intent/ingest');
const { normalizeIntentBody, IntentValidationError } = require('../../services/intent/normalize');
const { toStoreLocalOccurredAt, parseIanaTimezone } = require('../../services/intent/timezone');
const { withActorLock, _actorLocks } = require('../../services/intent/actorLock');

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const NEGATIVE_GAP = 30 * 1000;
const BRAND = 'bbb_shop';
const T0 = Date.parse('2026-09-19T05:00:00.000Z');

function get(obj, path) {
  return path.split('.').reduce((a, p) => a?.[p], obj);
}
function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => get(doc, k) === v);
}

// In-memory stand-in for the subset of Mongoose used by the intent path.
function fakeCollection({ failInsert = false } = {}) {
  const docs = [];
  return {
    docs,
    async updateOne(filter, update, opts = {}) {
      const hit = docs.find((d) => matches(d, filter));
      if (update.$setOnInsert) {
        if (failInsert) throw new Error('insert failed');
        if (hit) return { upsertedCount: 0, matchedCount: 1 };
        if (opts.upsert) {
          docs.push({ ...update.$setOnInsert });
          return { upsertedCount: 1, matchedCount: 0 };
        }
        return { upsertedCount: 0, matchedCount: 0 };
      }
      if (update.$set) {
        if (hit) {
          Object.assign(hit, update.$set);
          return { upsertedCount: 0, matchedCount: 1 };
        }
        if (opts.upsert) {
          docs.push({ ...filter, ...update.$set });
          return { upsertedCount: 1, matchedCount: 0 };
        }
      }
      return { upsertedCount: 0, matchedCount: 0 };
    },
    findOne(filter) {
      const hit = docs.find((d) => matches(d, filter)) ?? null;
      return { lean: async () => (hit ? structuredClone(hit) : null) };
    },
    async create(doc) {
      docs.push({ ...doc });
      return doc;
    },
    findById(id) {
      const hit = docs.find((d) => d._id === id) ?? null;
      return { lean: () => Promise.resolve(hit) };
    },
  };
}

function makeModels({ failEventInsert = false, failCursorUpdate = false } = {}) {
  const Event = fakeCollection({ failInsert: failEventInsert });
  const ClickEvent = fakeCollection();
  const ActorCursor = fakeCollection();
  const SessionHistory = fakeCollection();
  const SlugCache = fakeCollection();
  if (failCursorUpdate) {
    const original = ActorCursor.updateOne;
    ActorCursor.updateOne = async (...args) => {
      if (args[2]?.upsert) throw new Error('cursor write failed');
      return original(...args);
    };
  }
  return { Event, ClickEvent, ActorCursor, SessionHistory, SlugCache };
}

const silent = { info() {}, warn() {}, error() {} };

function buildIngest(models, { tz = 'Asia/Kolkata', logger = silent } = {}) {
  return createIntentIngestor({
    getModels: () => models,
    getBrandTimezone: () => tz,
    sessionTimeoutMs: SESSION_TIMEOUT_MS,
    negativeGapToleranceMs: NEGATIVE_GAP,
    logger,
  });
}

function pageView(id, tsMs, overrides = {}) {
  return {
    event_id: id,
    event_name: 'page_viewed',
    occurred_at: new Date(tsMs).toISOString(),
    brand_id: BRAND,
    client_id: 'client-1',
    visitor_id: null,
    session_id: null,
    url: 'https://shop.example/',
    referrer: null,
    user_agent: 'UA',
    data: {},
    ...overrides,
  };
}

function click(id, tsMs) {
  return {
    event_id: id,
    event_name: 'click',
    occurred_at: new Date(tsMs).toISOString(),
    brand_id: BRAND,
    client_id: 'client-1',
    visitor_id: null,
    session_id: null,
    url: 'https://shop.example/products/x',
    referrer: null,
    user_agent: 'UA',
    data: {
      click: { x: 1, y: 2, tag_name: 'BUTTON', element_id: 'add', element_name: null, element_type: 'button', element_value: null, href: null },
      signals: { url_changed: false, cart_changed: true, ui_changed: false, meaningful_scroll: false },
    },
  };
}

// ---------- normalization ----------

test('normalize: invalid occurred_at and bad schema both throw IntentValidationError (400)', () => {
  assert.throws(
    () => normalizeIntentBody(pageView('e1', T0, { occurred_at: 'nope' })),
    (err) => err instanceof IntentValidationError && err.status === 400,
  );
  assert.throws(
    () => normalizeIntentBody({ event_name: 'click', event_id: 'x' }),
    (err) => err instanceof IntentValidationError && err.status === 400,
  );
});

test('normalize: actor_id falls back to client_id; click branch selected by event_name', () => {
  const ev = normalizeIntentBody(pageView('e1', T0, { client_id: 'c9' }));
  assert.equal(ev.kind, 'event');
  assert.equal(ev.actorId, 'c9');
  const ck = normalizeIntentBody(click('k1', T0));
  assert.equal(ck.kind, 'click');
});

test('timezone: parses IANA name and shifts display value only', () => {
  assert.equal(parseIanaTimezone('(GMT+05:30) Asia/Kolkata'), 'Asia/Kolkata');
  const real = new Date('2026-09-17T08:40:40.402Z');
  assert.equal(toStoreLocalOccurredAt(real, 'Asia/Kolkata').toISOString(), '2026-09-17T14:10:40.402Z');
  assert.equal(toStoreLocalOccurredAt(real, 'America/Los_Angeles').toISOString(), '2026-09-17T01:40:40.402Z');
  assert.equal(toStoreLocalOccurredAt(real, null).getTime(), real.getTime());
});

test('actor lock: serializes work for the same key', async () => {
  const order = [];
  const a = withActorLock('k', async () => {
    await new Promise((r) => setTimeout(r, 20));
    order.push('a');
  });
  const b = withActorLock('k', async () => order.push('b'));
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(_actorLocks.size, 0);
});

// ---------- state machine ----------

test('same actor within timeout: one session, events_seq grows, session_start fixed', async () => {
  const models = makeModels();
  const ingest = buildIngest(models);
  await ingest(pageView('e1', T0), BRAND);
  await ingest(pageView('e2', T0 + 1000), BRAND);
  await ingest(pageView('e3', T0 + 2000), BRAND);

  const cursor = models.ActorCursor.docs[0];
  assert.equal(models.ActorCursor.docs.length, 1);
  assert.equal(Object.keys(cursor.events_seq).length, 3);
  assert.equal(cursor.events_seq['3'].event_id, 'e3');
  assert.equal(cursor.session_start.getTime(), T0);
  assert.equal(cursor.last_event_at.getTime(), T0 + 2000);

  const e1 = models.Event.docs.find((d) => d.event_id === 'e1');
  assert.equal(e1.session_end, null);
  assert.equal(e1.session_time_spent, null);
  assert.equal(e1.session_start.getTime(), T0);
  assert.equal(models.SessionHistory.docs.length, 0);
});

test('gap beyond timeout splits session: previous last doc closed, session_history written', async () => {
  const models = makeModels();
  const ingest = buildIngest(models);
  await ingest(pageView('e1', T0), BRAND);
  await ingest(pageView('e2', T0 + 2000), BRAND);
  await ingest(pageView('e3', T0 + SESSION_TIMEOUT_MS + 5000), BRAND);

  const e2 = models.Event.docs.find((d) => d.event_id === 'e2');
  assert.equal(e2.session_time_spent, 2000);
  assert.equal(models.SessionHistory.docs.length, 1);
  const hist = models.SessionHistory.docs[0];
  assert.equal(hist.session_time_spent, 2000);
  assert.equal(Object.keys(hist.events_seq).length, 2);

  const cursor = models.ActorCursor.docs[0];
  assert.equal(Object.keys(cursor.events_seq).length, 1);
  assert.equal(cursor.events_seq['1'].event_id, 'e3');
  assert.notEqual(cursor.session_id, hist.session_id);
});

test('negative gap within tolerance stays in session and never regresses last_event_at', async () => {
  const models = makeModels();
  const ingest = buildIngest(models);
  await ingest(pageView('e1', T0 + 10000), BRAND);
  await ingest(pageView('e2', T0 + 9000), BRAND);

  const cursor = models.ActorCursor.docs[0];
  assert.equal(models.SessionHistory.docs.length, 0);
  assert.equal(cursor.last_event_at.getTime(), T0 + 10000);
  assert.equal(cursor.last_ref.event_id, 'e1');
});

test('duplicate event_id: no second document, no cursor change', async () => {
  const models = makeModels();
  const ingest = buildIngest(models);
  const first = await ingest(pageView('e1', T0), BRAND);
  const second = await ingest(pageView('e1', T0 + 1000), BRAND);

  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(models.Event.docs.length, 1);
  assert.equal(Object.keys(models.ActorCursor.docs[0].events_seq).length, 1);
});

test('insert failure: cursor does not advance', async () => {
  const models = makeModels({ failEventInsert: true });
  const ingest = buildIngest(models);
  await assert.rejects(() => ingest(pageView('e1', T0), BRAND), /insert failed/);
  assert.equal(models.ActorCursor.docs.length, 0);
});

test('cursor commit failure after insert: event kept, logged, resolves inserted', async () => {
  const errors = [];
  const models = makeModels({ failCursorUpdate: true });
  const ingest = buildIngest(models, { logger: { ...silent, error: (m) => errors.push(m) } });
  const res = await ingest(pageView('e1', T0), BRAND);
  assert.equal(res.inserted, true);
  assert.equal(models.Event.docs.length, 1);
  assert.ok(errors.some((m) => m.includes('failed to update actor cursor')));
});

test('concurrent events for one actor are serialized: no lost events_seq entries', async () => {
  const models = makeModels();
  const ingest = buildIngest(models);
  await Promise.all([
    ingest(pageView('c1', T0), BRAND),
    ingest(pageView('c2', T0 + 1), BRAND),
    ingest(pageView('c3', T0 + 2), BRAND),
  ]);
  const cursor = models.ActorCursor.docs[0];
  assert.equal(Object.keys(cursor.events_seq).length, 3);
});

test('click goes to click_events with click_bucket and session fields, and advances the cursor', async () => {
  const models = makeModels();
  const ingest = buildIngest(models);
  await ingest(pageView('e1', T0), BRAND);
  await ingest(click('k1', T0 + 1000), BRAND);

  const doc = models.ClickEvent.docs[0];
  assert.equal(doc.click_bucket, 'useful_click');
  assert.equal(doc.session_start.getTime(), T0);
  assert.equal(models.Event.docs.length, 1);
  assert.equal(models.ActorCursor.docs[0].last_ref.collection, 'click_events');
});

test('display occurred_at is shifted to store timezone; session timing uses true instant', async () => {
  const models = makeModels();
  const ingest = buildIngest(models, { tz: 'Asia/Kolkata' });
  await ingest(pageView('e1', T0), BRAND);
  const doc = models.Event.docs[0];
  assert.equal(doc.occurred_at.toISOString(), '2026-09-19T10:30:00.000Z');
  assert.equal(doc.session_start.getTime(), T0);
});

test('product_added_to_cart dedupes per session+product via the compound key', async () => {
  const models = makeModels();
  const ingest = buildIngest(models);
  const atc = (id, ts) =>
    pageView(id, ts, { event_name: 'product_added_to_cart', data: { product_id: 'gid://shopify/Product/9' } });
  await ingest(pageView('e1', T0), BRAND);
  const a = await ingest(atc('a1', T0 + 1000), BRAND);
  const b = await ingest(atc('a2', T0 + 2000), BRAND);
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, false);
  const atcDocs = models.Event.docs.filter((d) => d.event_name === 'product_added_to_cart');
  assert.equal(atcDocs.length, 1);
  assert.equal(atcDocs[0].raw.product_id, 'Product:9');
});
