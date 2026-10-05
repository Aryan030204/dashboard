// Real MongoDB integration test for the intent outbox transaction (Step A) and
// the outbox relay (Step B). Runs only against a dedicated test database on a
// replica set. Skipped unless INTENT_TEST_MONGO_URI is set.
//
//   INTENT_TEST_MONGO_URI=mongodb://127.0.0.1:27017/intent_sessions_sqs_test?replicaSet=rs0
//
// Safety guards: refuses to run if the database is not an *_test database, and
// refuses to run if the URI equals INTENT_MONGO_URI (the production intent URI).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mongoose = require('mongoose');

const TEST_URI = (process.env.INTENT_TEST_MONGO_URI || '').trim();
const PRODUCTION_URI = (process.env.INTENT_MONGO_URI || '').trim();
const SKIP = !TEST_URI ? 'INTENT_TEST_MONGO_URI not set' : false;

function dbNameOf(uri) {
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/);
  return m ? decodeURIComponent(m[1]) : '';
}

const { createOutboxIngestor } = require('../../services/intent/outboxIngest');
const { createOutboxRelay } = require('../../services/intent/outboxRelay');
const { parseIanaTimezone } = require('../../services/intent/timezone');
const schemas = require('../../models/intent/schemas');

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const T0 = Date.parse('2026-10-05T05:00:00.000Z');
const RUN = crypto.randomBytes(4).toString('hex');
const SILENT = { info() {}, warn() {}, error() {} };

let conn;
let models;

function refuseUnsafeTarget() {
  const dbName = dbNameOf(TEST_URI);
  if (!dbName.endsWith('_test')) {
    throw new Error(`refusing to run: database "${dbName}" is not a *_test database`);
  }
  if (dbName === 'intent_sessions' || (PRODUCTION_URI && TEST_URI === PRODUCTION_URI)) {
    throw new Error('refusing to run: target is the production intent database');
  }
}

before(async () => {
  if (SKIP) return;
  refuseUnsafeTarget();
  conn = mongoose.createConnection(TEST_URI, { serverSelectionTimeoutMS: 15000 });
  await conn.asPromise();
  models = {
    Event: conn.model('Event', schemas.eventSchema),
    ClickEvent: conn.model('ClickEvent', schemas.clickEventSchema),
    ActorCursor: conn.model('ActorCursor', schemas.actorCursorSchema),
    SessionHistory: conn.model('SessionHistory', schemas.sessionHistorySchema),
    SlugCache: conn.model('SlugCache', schemas.slugCacheSchema),
    IntentOutbox: conn.model('IntentOutbox', schemas.intentOutboxSchema),
  };
  await Promise.all(Object.values(models).map((m) => m.init()));
});

after(async () => {
  if (conn) {
    await conn.db.dropDatabase();
    await conn.close();
  }
});

function ingestor(overrides = {}) {
  return createOutboxIngestor({
    getModels: () => models,
    getBrandTimezone: () => parseIanaTimezone('Asia/Kolkata'),
    sessionTimeoutMs: SESSION_TIMEOUT_MS,
    negativeGapToleranceMs: 30 * 1000,
    logger: SILENT,
    now: overrides.now || (() => new Date()),
    ...overrides,
  });
}

function ids(label) {
  const n = crypto.randomBytes(3).toString('hex');
  return {
    brand: `bbb_it_${RUN}_${label}`,
    actor: `actor-${RUN}-${label}-${n}`,
    tag: `${label}-${n}`,
  };
}

function eventBody({ brand, actor, tag, at = T0, eventId, name = 'product_viewed', data }) {
  return {
    brand_id: brand,
    event_id: eventId || `ev-${tag}`,
    event_name: name,
    occurred_at: new Date(at).toISOString(),
    client_id: `cid-${tag}`,
    visitor_id: `vid-${tag}`,
    actor_id: actor,
    url: 'https://blabliblulife.com/products/x',
    referrer: null,
    user_agent: 'UA',
    data: data || { product_id: 'gid://shopify/Product/9', variant_id: '77', price: 499, currency: 'INR' },
  };
}

function clickBody({ brand, actor, tag, at = T0 }) {
  return {
    brand_id: brand,
    event_id: `clk-${tag}`,
    event_name: 'click',
    occurred_at: new Date(at).toISOString(),
    client_id: `cid-${tag}`,
    visitor_id: `vid-${tag}`,
    session_id: null,
    actor_id: actor,
    url: 'https://blabliblulife.com/cart',
    referrer: 'https://instagram.com/',
    user_agent: 'UA',
    data: {
      click: { x: 266, y: 598, tag_name: 'BUTTON', element_id: 'add', element_name: null, element_type: 'submit', element_value: null, href: null },
      signals: { url_changed: false, cart_changed: true, ui_changed: false, meaningful_scroll: false },
    },
  };
}

async function snapshotState(brand) {
  const [events, clicks, cursors, history, outbox] = await Promise.all([
    models.Event.find({ brand_id: brand }).lean(),
    models.ClickEvent.find({ brand_id: brand }).lean(),
    models.ActorCursor.find({ brand_id: brand }).lean(),
    models.SessionHistory.find({ brand_id: brand }).lean(),
    models.IntentOutbox.find({ brand_id: brand }).sort({ created_at: 1 }).lean(),
  ]);
  return { events, clicks, cursors, history, outbox };
}

// ---------- Part 3: successful transaction ----------

test('successful transaction writes event state, cursor and one outbox message', { skip: SKIP }, async () => {
  const { brand, actor, tag } = ids('ok');
  const result = await ingestor()(eventBody({ brand, actor, tag }), brand);

  const s = await snapshotState(brand);
  assert.equal(result.status, 'accepted');
  assert.equal(s.events.length, 1);
  assert.equal(s.cursors.length, 1);
  assert.equal(s.outbox.length, 1);
  assert.equal(s.outbox[0].message_id, `event:ev-${tag}`);
  assert.equal(s.outbox[0].status, 'pending');
  assert.equal(s.outbox[0].attempts, 0);
  assert.equal(s.outbox[0].schema_version, 1);
});

test('click transaction writes click_events and a click outbox message', { skip: SKIP }, async () => {
  const { brand, actor, tag } = ids('click');
  await ingestor()(clickBody({ brand, actor, tag }), brand);

  const s = await snapshotState(brand);
  assert.equal(s.clicks.length, 1);
  assert.equal(s.events.length, 0);
  assert.equal(s.outbox.length, 1);
  assert.equal(s.outbox[0].type, 'click');
  assert.equal(s.outbox[0].payload.click_bucket, 'useful_click');
});

test('stored payload passes the Python contract parser (intent_sqs_contract.parse_message)', { skip: SKIP }, async () => {
  const { brand, actor, tag } = ids('parity');
  await ingestor()(eventBody({ brand, actor, tag }), brand);
  await ingestor()(clickBody({ brand, actor, tag: `${tag}-c`, at: T0 + 1000 }), brand);
  const s = await snapshotState(brand);

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
  const bodies = s.outbox.map((r) => JSON.stringify(r.payload));
  const run = spawnSync('python', ['-c', code], {
    cwd: pipelineRoot,
    input: JSON.stringify(bodies),
    encoding: 'utf8',
  });
  if (run.error && run.error.code === 'ENOENT') return; // python not installed here
  assert.equal(run.status, 0, `python contract parse failed: ${run.stderr}`);
  assert.equal(run.stdout.trim(), String(bodies.length));
});

// ---------- Part 4: rollback ----------

test('rollback: failure after state writes but before commit leaves no trace', { skip: SKIP }, async () => {
  const { brand, actor, tag } = ids('rollback');
  // Establish an earlier event so the cursor exists and has a known value.
  await ingestor()(eventBody({ brand, actor, tag: `${tag}-a`, at: T0 }), brand);
  const before = await snapshotState(brand);

  const failingModels = {
    ...models,
    IntentOutbox: {
      insertMany: async () => {
        throw new Error('forced failure before commit');
      },
    },
  };
  const failing = createOutboxIngestor({
    getModels: () => failingModels,
    getBrandTimezone: () => parseIanaTimezone('Asia/Kolkata'),
    sessionTimeoutMs: SESSION_TIMEOUT_MS,
    negativeGapToleranceMs: 30 * 1000,
    logger: SILENT,
  });

  // Rollover: this write also closes the previous session and writes session_history
  // before the forced outbox failure aborts everything.
  await assert.rejects(
    failing(eventBody({ brand, actor, tag: `${tag}-b`, at: T0 + 60 * 60 * 1000, eventId: `ev-${tag}-b` }), brand),
    /forced failure before commit/,
  );

  const after = await snapshotState(brand);
  assert.deepEqual(after.events.map((e) => e.event_id), before.events.map((e) => e.event_id), 'no new event');
  assert.equal(after.clicks.length, 0, 'no click event');
  assert.deepEqual(after.cursors, before.cursors, 'actor cursor unchanged');
  assert.equal(after.history.length, 0, 'no session_history from the aborted rollover');
  assert.deepEqual(after.outbox.map((r) => r.message_id), before.outbox.map((r) => r.message_id), 'no new outbox row');
  const closed = await models.Event.findOne({ brand_id: brand, event_id: `ev-${tag}-a` }).lean();
  assert.equal(closed.session_end, null, 'previous session was not closed by the aborted write');
});

// ---------- Part 5: duplicate ----------

test('duplicate event_id: second call is a duplicate with no new outbox row and no cursor move', { skip: SKIP }, async () => {
  const { brand, actor, tag } = ids('dup');
  const ing = ingestor();
  const first = await ing(eventBody({ brand, actor, tag }), brand);
  const before = await snapshotState(brand);

  const second = await ing(eventBody({ brand, actor, tag }), brand);
  const after = await snapshotState(brand);

  assert.equal(first.status, 'accepted');
  assert.equal(second.status, 'duplicate');
  assert.equal(after.events.length, 1);
  assert.equal(after.outbox.length, 1, 'no second outbox message');
  assert.deepEqual(after.cursors, before.cursors, 'cursor did not advance');
});

// ---------- Part 6: ATC dedupe ----------

test('ATC dedupe: same brand, session and product yields one event and one outbox message', { skip: SKIP }, async () => {
  const { brand, actor, tag } = ids('atc');
  const atc = (eventId, at) =>
    eventBody({
      brand,
      actor,
      tag,
      at,
      eventId,
      name: 'product_added_to_cart',
      data: { product_id: 'gid://shopify/Product/42', variant_id: '7', quantity: 1, price: 250 },
    });
  const ing = ingestor();
  const first = await ing(atc(`atc-1-${tag}`, T0), brand);
  const second = await ing(atc(`atc-2-${tag}`, T0 + 5000), brand);

  const s = await snapshotState(brand);
  assert.equal(first.status, 'accepted');
  assert.equal(second.status, 'duplicate');
  assert.equal(s.events.filter((e) => e.event_name === 'product_added_to_cart').length, 1);
  assert.equal(s.outbox.length, 1);
});

// ---------- Part 7: session rollover ----------

test('rollover: session A closes, history and snapshot are written, new event starts session B', { skip: SKIP }, async () => {
  const { brand, actor, tag } = ids('roll');
  const ing = ingestor();
  await ing(eventBody({ brand, actor, tag: `${tag}-1`, at: T0, eventId: `r1-${tag}` }), brand);
  const sessionA = (await models.ActorCursor.findOne({ brand_id: brand, actor_id: actor }).lean()).session_id;

  await ing(eventBody({ brand, actor, tag: `${tag}-2`, at: T0 + 60 * 60 * 1000, eventId: `r2-${tag}` }), brand);
  const s = await snapshotState(brand);

  const closed = s.events.find((e) => e.event_id === `r1-${tag}`);
  const fresh = s.events.find((e) => e.event_id === `r2-${tag}`);
  assert.ok(closed.session_end instanceof Date, 'session A closed on its last event');
  assert.equal(closed.session_time_spent, 0, 'single-event session A has zero time spent');
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].session_id, sessionA);
  assert.notEqual(fresh.session_id, sessionA, 'new event belongs to session B');
  const snap = s.outbox.find((r) => r.type === 'session_snapshot');
  assert.ok(snap, 'session_snapshot in outbox');
  assert.equal(snap.payload.session_id, sessionA);
  assert.equal(snap.payload.events_seq['1'].event_id, `r1-${tag}`);
});

// ---------- Part 8 & 9: relay against the real collection ----------

test('relay setup: clear leftover outbox rows from the ingest tests in this isolated database', { skip: SKIP }, async () => {
  await models.IntentOutbox.deleteMany({});
  assert.equal(await models.IntentOutbox.countDocuments({}), 0);
});

async function seedPending(prefix, count, brand) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${i}`;
    rows.push({
      message_id: `event:${id}`,
      brand_id: brand,
      type: 'event',
      schema_version: 1,
      payload: {
        schema_version: 1,
        type: 'event',
        message_key: id,
        brand_id: brand,
        event_id: id,
        event_name: 'product_viewed',
        actor_id: 'a',
        client_id: 'c',
        visitor_id: 'v',
        session_id: 's',
        occurred_at: new Date(T0 + i * 1000).toISOString(),
        url: null,
        referrer: null,
        user_agent: null,
        session_start: new Date(T0).toISOString(),
        session_end: null,
        session_time_spent: null,
        raw: { product_id: 'p' },
      },
      status: 'pending',
      attempts: 0,
      created_at: new Date(T0 + i * 1000),
      updated_at: new Date(T0 + i * 1000),
    });
  }
  await models.IntentOutbox.insertMany(rows);
  return rows;
}

function relayWith(sendMessage, workerId = 'it-relay-a', now = () => new Date()) {
  return createOutboxRelay({
    IntentOutbox: models.IntentOutbox,
    sendMessage,
    workerId,
    batchSize: 10,
    claimTimeoutMs: 60000,
    retryBaseMs: 1000,
    retryMaxMs: 300000,
    now,
    logger: SILENT,
  });
}

test('relay: pending rows are claimed, sent with sqs_message_id, and attempts increments', { skip: SKIP }, async () => {
  const brand = `bbb_it_${RUN}_relay1`;
  await seedPending(`rl1-${RUN}`, 3, brand);
  const seen = [];
  const relay = relayWith(async (body) => {
    seen.push(body);
    return `sqs-${seen.length}`;
  });

  const summary = await relay.processOnce();

  const rows = await models.IntentOutbox.find({ brand_id: brand }).sort({ created_at: 1 }).lean();
  assert.deepEqual(summary, { claimed: 3, sent: 3, failed: 0 });
  assert.ok(rows.every((r) => r.status === 'sent'));
  assert.deepEqual(rows.map((r) => r.sqs_message_id), ['sqs-1', 'sqs-2', 'sqs-3']);
  assert.ok(rows.every((r) => r.attempts === 1));
  assert.ok(rows.every((r) => r.claimed_by === null && r.claimed_until === null));
  assert.ok(rows.every((r) => r.sent_at instanceof Date));
});

test('relay: failed send returns the row to pending with attempts and next_attempt_at', { skip: SKIP }, async () => {
  const brand = `bbb_it_${RUN}_relay2`;
  await seedPending(`rl2-${RUN}`, 1, brand);
  const relay = relayWith(async () => {
    throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
  });

  await relay.processOnce();

  const row = await models.IntentOutbox.findOne({ brand_id: brand }).lean();
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.ok(row.next_attempt_at instanceof Date, 'next_attempt_at populated');
  assert.match(row.last_error, /ThrottlingException: throttled/);
  assert.equal(row.claimed_by, null);
  assert.equal(row.sent_at, null);
});

test('relay: expired claim is reclaimed; active claim is not stolen', { skip: SKIP }, async () => {
  const brand = `bbb_it_${RUN}_relay3`;
  const [expiredRow, activeRow] = await seedPending(`rl3-${RUN}`, 2, brand);
  const past = new Date(Date.now() - 120000);
  const future = new Date(Date.now() + 600000);
  await models.IntentOutbox.collection.updateOne(
    { message_id: expiredRow.message_id },
    { $set: { status: 'claimed', claimed_by: 'crashed', claimed_until: past, attempts: 1 } },
  );
  await models.IntentOutbox.collection.updateOne(
    { message_id: activeRow.message_id },
    { $set: { status: 'claimed', claimed_by: 'live-relay', claimed_until: future, attempts: 1 } },
  );

  const sent = [];
  const relay = relayWith(async (body) => {
    sent.push(JSON.parse(body).event_id);
    return 'sqs-r';
  }, 'it-relay-b');
  const summary = await relay.processOnce();

  const expired = await models.IntentOutbox.findOne({ message_id: expiredRow.message_id }).lean();
  const active = await models.IntentOutbox.findOne({ message_id: activeRow.message_id }).lean();
  assert.equal(summary.sent, 1);
  assert.deepEqual(sent, [`rl3-${RUN}-0`]);
  assert.equal(expired.status, 'sent');
  assert.equal(expired.attempts, 2, 'reclaim incremented attempts');
  assert.equal(active.status, 'claimed', 'active claim untouched');
  assert.equal(active.claimed_by, 'live-relay');
});

test('relay: MessageBody is byte-identical to the stored payload serialization; no ingested_at added', { skip: SKIP }, async () => {
  const brand = `bbb_it_${RUN}_exact`;
  await ingestor()(eventBody({ brand, actor: `a-${RUN}-exact`, tag: `exact-${RUN}` }), brand);
  const stored = await models.IntentOutbox.findOne({ brand_id: brand }).lean();
  const bodies = [];
  const relay = relayWith(async (body) => {
    bodies.push(body);
    return 'sqs-x';
  }, 'it-relay-exact');

  await relay.processOnce();

  const storedSerialization = JSON.stringify(stored.payload);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0], storedSerialization, 'MessageBody equals the stored payload serialization byte-for-byte');
  assert.equal('ingested_at' in JSON.parse(bodies[0]), false);
});

// ---------- Part 10: index inspection ----------

test('index inspection: claim query plan and existing indexes on intent_outbox', { skip: SKIP }, async () => {
  const at = new Date();
  const claimFilter = {
    $and: [
      { $or: [{ status: 'pending' }, { status: 'claimed', claimed_until: { $lt: at } }] },
      { next_attempt_at: { $not: { $gt: at } } },
    ],
  };
  const explain = await models.IntentOutbox.collection
    .find(claimFilter)
    .sort({ created_at: 1 })
    .limit(1)
    .explain('queryPlanner');
  const indexes = await models.IntentOutbox.collection.indexes();
  const plan = JSON.stringify(explain.queryPlanner.winningPlan);
  console.log('[index-inspection] intent_outbox indexes:', indexes.map((i) => i.name).join(', '));
  console.log('[index-inspection] claim query winning plan:', plan);
  assert.ok(indexes.some((i) => i.name === 'message_id_1'), 'unique message_id index exists');
});
