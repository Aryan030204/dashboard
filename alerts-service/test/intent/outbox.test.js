const test = require('node:test');
const assert = require('node:assert/strict');

const { createOutboxIngestor } = require('../../services/intent/outboxIngest');
const { IntentValidationError } = require('../../services/intent/normalize');
const { parseIanaTimezone } = require('../../services/intent/timezone');
const { validateMessage, SCHEMA_VERSION } = require('../../services/intent/messageContract');

const BRAND = 'bbb_shop';
const T0 = Date.parse('2026-10-04T05:00:00.000Z');
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

function get(obj, path) {
  return path.split('.').reduce((a, p) => a?.[p], obj);
}
function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => get(doc, k) === v);
}

// Minimal in-memory stand-in for Mongo transactions on the intent connection.
// A transaction snapshots every collection and restores the snapshot if the
// callback throws, which is the all-or-nothing guarantee the outbox relies on.
function createFakeIntentDb({ failOutboxInsert = false } = {}) {
  const collections = {};
  let failOutbox = failOutboxInsert;

  function collection(name) {
    if (!collections[name]) collections[name] = { docs: [] };
    return collections[name];
  }

  function snapshot() {
    return Object.fromEntries(
      Object.entries(collections).map(([name, c]) => [name, structuredClone(c.docs)]),
    );
  }
  function restore(snap) {
    for (const name of Object.keys(collections)) {
      collections[name].docs.splice(0, collections[name].docs.length, ...(snap[name] || []));
    }
  }

  function startSession() {
    return {
      async withTransaction(fn) {
        const snap = snapshot();
        try {
          return await fn();
        } catch (err) {
          restore(snap);
          throw err;
        }
      },
      async endSession() {},
    };
  }

  function upsert(name, filter, update, opts = {}) {
    const c = collection(name);
    const hit = c.docs.find((d) => matches(d, filter));
    if (update.$setOnInsert) {
      if (hit) return { upsertedCount: 0, matchedCount: 1 };
      if (opts.upsert) {
        c.docs.push(structuredClone({ ...update.$setOnInsert }));
        return { upsertedCount: 1, matchedCount: 0 };
      }
      return { upsertedCount: 0, matchedCount: 0 };
    }
    if (update.$set) {
      if (hit) {
        Object.assign(hit, structuredClone(update.$set));
        return { upsertedCount: 0, matchedCount: 1 };
      }
      if (opts.upsert) {
        c.docs.push(structuredClone({ ...filter, ...update.$set }));
        return { upsertedCount: 1, matchedCount: 0 };
      }
    }
    return { upsertedCount: 0, matchedCount: 0 };
  }

  const db = { startSession };

  const models = {
    Event: {
      db,
      updateOne: async (f, u, o) => upsert('events', f, u, o),
    },
    ClickEvent: {
      updateOne: async (f, u, o) => upsert('click_events', f, u, o),
    },
    ActorCursor: {
      findOne(filter) {
        const q = {
          session() {
            return q;
          },
          lean: async () => {
            const hit = collection('actor_cursors').docs.find((d) => matches(d, filter));
            return hit ? structuredClone(hit) : null;
          },
        };
        return q;
      },
      updateOne: async (f, u, o) => upsert('actor_cursors', f, u, o),
    },
    SessionHistory: {
      create: async (docOrArray) => {
        const list = Array.isArray(docOrArray) ? docOrArray : [docOrArray];
        for (const d of list) collection('session_history').docs.push(structuredClone(d));
        return docOrArray;
      },
    },
    SlugCache: {
      findById: () => ({ lean: () => Promise.resolve(null) }),
    },
    IntentOutbox: {
      insertMany: async (rows) => {
        if (failOutbox) throw new Error('outbox insert failed');
        const c = collection('intent_outbox');
        for (const row of rows) {
          if (c.docs.some((d) => d.message_id === row.message_id)) {
            throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
          }
        }
        for (const row of rows) c.docs.push(structuredClone(row));
        return rows;
      },
    },
  };

  return {
    models,
    collection,
    setOutboxFailure(value) {
      failOutbox = value;
    },
  };
}

function makeIngestor(fake, { now = () => new Date(T0), sqsMessageLimitBytes } = {}) {
  return createOutboxIngestor({
    getModels: () => fake.models,
    getBrandTimezone: () => parseIanaTimezone('Asia/Kolkata'),
    sessionTimeoutMs: SESSION_TIMEOUT_MS,
    negativeGapToleranceMs: 30 * 1000,
    logger: { info() {}, warn() {}, error() {} },
    now,
    ...(sqsMessageLimitBytes ? { sqsMessageLimitBytes } : {}),
  });
}

function eventBody(overrides = {}) {
  return {
    brand_id: BRAND,
    event_id: 'sh-1',
    event_name: 'product_viewed',
    occurred_at: new Date(T0).toISOString(),
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
    occurred_at: new Date(T0).toISOString(),
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

function outboxRows(fake) {
  return fake.collection('intent_outbox').docs;
}

test('valid event is recorded with state and one contract message in one transaction', async () => {
  const fake = createFakeIntentDb();
  const ingest = makeIngestor(fake);

  const result = await ingest(eventBody(), BRAND);

  assert.equal(result.status, 'accepted');
  assert.equal(fake.collection('events').docs.length, 1);
  assert.equal(fake.collection('actor_cursors').docs.length, 1);
  assert.equal(outboxRows(fake).length, 1);
  assert.deepEqual(result.outbox, ['event:sh-1']);
});

test('outbox row has the approved shape and a contract-valid payload', async () => {
  const fake = createFakeIntentDb();
  await makeIngestor(fake)(eventBody(), BRAND);

  const row = outboxRows(fake)[0];
  assert.equal(row.message_id, 'event:sh-1');
  assert.equal(row.brand_id, BRAND);
  assert.equal(row.type, 'event');
  assert.equal(row.schema_version, SCHEMA_VERSION);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0);
  assert.ok(row.created_at instanceof Date);
  assert.ok(row.updated_at instanceof Date);
  assert.equal(row.payload.type, 'event');
  assert.equal(row.payload.event_id, 'sh-1');
  assert.equal(row.payload.event_name, 'product_viewed');
  assert.equal(row.payload.session_id, fake.collection('events').docs[0].session_id);
  assert.deepEqual(validateMessage(row.payload), []);
});

test('click produces a click message with click_bucket and signals', async () => {
  const fake = createFakeIntentDb();
  await makeIngestor(fake)(clickBody(), BRAND);

  const row = outboxRows(fake)[0];
  assert.equal(row.type, 'click');
  assert.equal(row.message_id, 'click:shu-1');
  assert.equal(row.payload.click_bucket, 'useful_click');
  assert.equal(row.payload.signals.cart_changed, true);
  assert.equal(fake.collection('click_events').docs.length, 1);
  assert.deepEqual(validateMessage(row.payload), []);
});

test('duplicate event_id: second call changes nothing and reports duplicate', async () => {
  const fake = createFakeIntentDb();
  const ingest = makeIngestor(fake);
  await ingest(eventBody(), BRAND);
  const cursorBefore = structuredClone(fake.collection('actor_cursors').docs);

  const second = await ingest(eventBody(), BRAND);

  assert.equal(second.status, 'duplicate');
  assert.equal(fake.collection('events').docs.length, 1);
  assert.equal(outboxRows(fake).length, 1);
  assert.deepEqual(fake.collection('actor_cursors').docs, cursorBefore);
});

test('ATC dedupe: same product added twice in one session is recorded once', async () => {
  const fake = createFakeIntentDb();
  const ingest = makeIngestor(fake);
  const atc = (eventId) =>
    eventBody({ event_id: eventId, event_name: 'product_added_to_cart', data: { product_id: 'gid://shopify/Product/9', variant_id: '77', quantity: 1, price: 499 } });

  const first = await ingest(atc('atc-1'), BRAND);
  const second = await ingest(atc('atc-2'), BRAND);

  assert.equal(first.status, 'accepted');
  assert.equal(second.status, 'duplicate');
  assert.equal(outboxRows(fake).length, 1);
  assert.equal(fake.collection('events').docs.length, 1);
});

test('session rollover: the closed session produces a session_snapshot message', async () => {
  const fake = createFakeIntentDb();
  const clock = { t: T0 };
  const ingest = makeIngestor(fake, { now: () => new Date(clock.t) });

  await ingest(eventBody({ event_id: 'p1' }), BRAND);
  clock.t = T0 + 60 * 60 * 1000;
  const second = await ingest(eventBody({ event_id: 'p2', occurred_at: new Date(clock.t).toISOString() }), BRAND);

  assert.deepEqual(second.outbox, ['event:p2', 'session_snapshot:session:' + fake.collection('events').docs[0].session_id]);
  const snapshot = outboxRows(fake).find((r) => r.type === 'session_snapshot');
  assert.ok(snapshot, 'snapshot row written');
  assert.equal(snapshot.payload.session_id, fake.collection('events').docs[0].session_id);
  assert.equal(snapshot.payload.session_time_spent, 0);
  assert.equal(snapshot.payload.events_seq['1'].event_id, 'p1');
  assert.deepEqual(validateMessage(snapshot.payload), []);
  assert.equal(fake.collection('session_history').docs.length, 1);
  const closedEvent = fake.collection('events').docs.find((d) => d.event_id === 'p1');
  assert.ok(closedEvent.session_end instanceof Date, 'previous session closed on the stored event');
});

test('rollback: if the outbox write fails, no state from that event is kept', async () => {
  const fake = createFakeIntentDb();
  const clock = { t: T0 };
  const ingest = makeIngestor(fake, { now: () => new Date(clock.t) });
  await ingest(eventBody({ event_id: 'p1' }), BRAND);
  const before = {
    events: structuredClone(fake.collection('events').docs),
    cursors: structuredClone(fake.collection('actor_cursors').docs),
    history: structuredClone(fake.collection('session_history').docs),
    outbox: structuredClone(outboxRows(fake)),
  };

  fake.setOutboxFailure(true);
  clock.t = T0 + 60 * 60 * 1000;
  await assert.rejects(ingest(eventBody({ event_id: 'p2', occurred_at: new Date(clock.t).toISOString() }), BRAND), /outbox insert failed/);

  assert.deepEqual(fake.collection('events').docs, before.events, 'no new event and no session close');
  assert.deepEqual(fake.collection('actor_cursors').docs, before.cursors, 'cursor not advanced');
  assert.deepEqual(fake.collection('session_history').docs, before.history, 'no session_history written');
  assert.deepEqual(outboxRows(fake), before.outbox, 'no outbox rows');
});

test('no idempotency_key is needed: event_id alone is accepted', async () => {
  const fake = createFakeIntentDb();
  const result = await makeIngestor(fake)(eventBody({ idempotency_key: undefined }), BRAND);
  assert.equal(result.status, 'accepted');
});

test('anonymous event (no actor id) is recorded without a cursor and still yields an outbox message', async () => {
  const fake = createFakeIntentDb();
  const body = eventBody({ actor_id: null, client_id: null });
  const result = await makeIngestor(fake)(body, BRAND);

  assert.equal(result.status, 'accepted');
  assert.equal(fake.collection('actor_cursors').docs.length, 0);
  assert.equal(outboxRows(fake)[0].payload.actor_id, null);
});

test('malformed input is rejected as 400 with no writes', async () => {
  const fake = createFakeIntentDb();
  const ingest = makeIngestor(fake);

  await assert.rejects(ingest(eventBody({ event_id: undefined }), BRAND), (err) => {
    assert.ok(err instanceof IntentValidationError);
    assert.equal(err.status, 400);
    return true;
  });
  await assert.rejects(ingest(eventBody({ occurred_at: 'not a date' }), BRAND), (err) => err.status === 400);

  assert.equal(fake.collection('events').docs.length, 0);
  assert.equal(outboxRows(fake).length, 0);
});

test('oversize contract message is rejected as 413 and nothing is written', async () => {
  const fake = createFakeIntentDb();
  const ingest = makeIngestor(fake, { sqsMessageLimitBytes: 200 });

  await assert.rejects(ingest(eventBody({ data: { blob: 'x'.repeat(500) } }), BRAND), (err) => err.status === 413);

  assert.equal(fake.collection('events').docs.length, 0);
  assert.equal(outboxRows(fake).length, 0);
});

test('payload field names match intent_sqs_contract.py expectations', async () => {
  const fake = createFakeIntentDb();
  await makeIngestor(fake)(eventBody(), BRAND);
  const payload = outboxRows(fake)[0].payload;

  for (const key of ['schema_version', 'type', 'message_key', 'brand_id', 'event_id', 'event_name', 'occurred_at', 'session_id', 'actor_id']) {
    assert.ok(key in payload, `missing ${key}`);
  }
});
