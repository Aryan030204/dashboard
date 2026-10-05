// Step D: two independent relay processes against a real MongoDB replica set.
// Skipped unless INTENT_TEST_MONGO_URI points at a *_test database.
//
//   INTENT_TEST_MONGO_URI=mongodb://127.0.0.1:27017/intent_sessions_sqs_test?replicaSet=rs0
//
// SQS is mocked in the child processes. No real queue is contacted.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const mongoose = require('mongoose');
const schemas = require('../../models/intent/schemas');

const TEST_URI = (process.env.INTENT_TEST_MONGO_URI || '').trim();
const PRODUCTION_URI = (process.env.INTENT_MONGO_URI || '').trim();
const SKIP = !TEST_URI ? 'INTENT_TEST_MONGO_URI not set' : false;
const CHILD = path.join(__dirname, 'fixtures', 'relay-child.js');
const T0 = Date.parse('2026-10-05T05:00:00.000Z');

function dbNameOf(uri) {
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/);
  return m ? decodeURIComponent(m[1]) : '';
}

let conn;
let IntentOutbox;

before(async () => {
  if (SKIP) return;
  const dbName = dbNameOf(TEST_URI);
  if (!dbName.endsWith('_test')) throw new Error(`refusing to run: "${dbName}" is not a *_test database`);
  if (dbName === 'intent_sessions' || (PRODUCTION_URI && TEST_URI === PRODUCTION_URI)) {
    throw new Error('refusing to run: production intent database');
  }
  conn = mongoose.createConnection(TEST_URI, { serverSelectionTimeoutMS: 15000 });
  await conn.asPromise();
  IntentOutbox = conn.model('IntentOutbox', schemas.intentOutboxSchema);
  await IntentOutbox.init();
});

after(async () => {
  if (conn) {
    await conn.db.dropDatabase();
    await conn.close();
  }
});

function seedRows(prefix, count) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${String(i).padStart(4, '0')}`;
    rows.push({
      message_id: `event:${id}`,
      brand_id: 'bbb_shop',
      type: 'event',
      schema_version: 1,
      payload: {
        schema_version: 1,
        type: 'event',
        message_key: id,
        brand_id: 'bbb_shop',
        event_id: id,
        event_name: 'product_viewed',
        actor_id: 'a',
        client_id: 'c',
        visitor_id: 'v',
        session_id: 's',
        occurred_at: new Date(T0 + i).toISOString(),
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
      claimed_by: null,
      claimed_until: null,
      created_at: new Date(T0 + i),
      updated_at: new Date(T0 + i),
    });
  }
  return rows;
}

function runChild(cfg) {
  return new Promise((resolve, reject) => {
    const child = fork(CHILD, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let result = null;
    child.on('message', (msg) => {
      result = msg;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0 || !result) reject(new Error(`relay child ${cfg.workerId} exited with ${code}`));
      else resolve(result);
    });
    child.send({ uri: TEST_URI, ...cfg });
  });
}

// ---------- Scenario A: two relays, many rows, no lease expiry ----------

test('two concurrent relays: no row is claimed or sent twice, every row is sent', { skip: SKIP, timeout: 120000 }, async () => {
  await IntentOutbox.deleteMany({});
  await IntentOutbox.insertMany(seedRows('a', 60));

  const common = {
    batchSize: 5,
    claimTimeoutMs: 60000,
    delayMessageIds: [],
    delayMs: 0,
    jitterMs: 8,
    idleRounds: 3,
    idleSleepMs: 50,
  };
  const [r1, r2] = await Promise.all([
    runChild({ ...common, workerId: 'relay-1' }),
    runChild({ ...common, workerId: 'relay-2' }),
  ]);

  const allSends = [...r1.sends, ...r2.sends];
  const perMessage = new Map();
  for (const s of allSends) perMessage.set(s.message_id, (perMessage.get(s.message_id) || 0) + 1);

  const rows = await IntentOutbox.find({}).lean();
  assert.equal(rows.length, 60);
  assert.ok(rows.every((r) => r.status === 'sent'), 'every row eventually sent');
  assert.ok(rows.every((r) => r.attempts === 1), 'each row claimed exactly once');
  assert.ok(allSends.length === 60, `expected 60 sends, got ${allSends.length}`);
  assert.ok([...perMessage.values()].every((n) => n === 1), 'no row was sent twice');
  assert.ok(r1.sends.length > 0 && r2.sends.length > 0, 'both relays did real work');
  assert.ok(allSends.every((s) => s.dbState.status === 'claimed' && s.dbState.claimed_by === s.relay),
    'at send time the row was claimed by the relay that sent it');
  assert.ok(allSends.every((s) => s.dbState.claimed_until_ms_from_now > 0), 'lease was live during the send');
  assert.ok(rows.every((r) => r.claimed_by === null && r.claimed_until === null), 'no stale claim left behind');
  assert.ok(rows.every((r) => /^relay-[12]-\d+$/.test(r.sqs_message_id)), 'sqs_message_id came from one of the two relays');
});

// ---------- Scenario B: lease expires during a slow send ----------

test('lease expiry during a send: the other relay reclaims, and the stale relay cannot overwrite it', { skip: SKIP, timeout: 120000 }, async () => {
  await IntentOutbox.deleteMany({});
  const rows = seedRows('slow', 4);
  await IntentOutbox.insertMany(rows);
  const slowId = 'slow-0000';

  const slowRelay = runChild({
    workerId: 'relay-slow',
    batchSize: 1,
    claimTimeoutMs: 1000,
    delayMessageIds: [slowId],
    delayMs: 2500,
    jitterMs: 0,
    idleRounds: 2,
    idleSleepMs: 50,
  });

  // Start the second relay after the first has claimed the slow row, so its
  // lease is live when the second relay first looks.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const fastRelay = runChild({
    workerId: 'relay-fast',
    batchSize: 1,
    claimTimeoutMs: 1000,
    delayMessageIds: [],
    delayMs: 0,
    jitterMs: 0,
    idleRounds: 8,
    idleSleepMs: 400,
  });

  const [slow, fast] = await Promise.all([slowRelay, fastRelay]);

  const slowRow = await IntentOutbox.findOne({ message_id: `event:${slowId}` }).lean();
  const slowSends = [...slow.sends, ...fast.sends].filter((s) => s.message_id === `event:${slowId}`);

  assert.equal(slowRow.status, 'sent');
  assert.equal(slowRow.attempts, 2, 'reclaimed after lease expiry');
  assert.equal(slowSends.length, 2, 'at-least-once: the same body was sent by both relays');
  assert.equal(slowSends[0].body, slowSends[1].body, 'identical body both times');
  assert.ok(slowSends.some((s) => s.relay === 'relay-fast'), 'the reclaiming relay sent it');
  assert.ok(slow.logs.some((l) => /lease lost before marking sent/.test(l)), 'stale relay detected the lost lease');
  assert.equal(slowRow.sqs_message_id, 'relay-fast-1', 'newer relay state kept, stale relay did not overwrite it');
  assert.equal(slowRow.claimed_by, null);
  const others = await IntentOutbox.find({ message_id: { $ne: `event:${slowId}` } }).lean();
  assert.ok(others.every((r) => r.status === 'sent' && r.attempts === 1), 'other rows sent once each');
});

// ---------- Query plan: claim query, with and without { status: 1, claimed_until: 1 } ----------

function claimFilter(at) {
  return {
    $and: [
      { $or: [{ status: 'pending' }, { status: 'claimed', claimed_until: { $lt: at } }] },
      { next_attempt_at: { $not: { $gt: at } } },
    ],
  };
}

async function explainClaim(at) {
  const e = await IntentOutbox.collection
    .find(claimFilter(at))
    .sort({ created_at: 1 })
    .limit(1)
    .explain('executionStats');
  return {
    docsExamined: e.executionStats.totalDocsExamined,
    keysExamined: e.executionStats.totalKeysExamined,
    returned: e.executionStats.nReturned,
    plan: JSON.stringify(e.queryPlanner.winningPlan),
  };
}

test('claim query plan: measured with a realistic mix, before and after a test-only index', { skip: SKIP, timeout: 180000 }, async () => {
  await IntentOutbox.deleteMany({});
  const bulk = [];
  for (let i = 0; i < 20000; i++) {
    bulk.push({
      message_id: `event:bulk-${i}`,
      brand_id: 'bbb_shop',
      type: 'event',
      schema_version: 1,
      payload: { i },
      status: i < 19900 ? 'sent' : i < 19950 ? 'claimed' : 'pending',
      attempts: 1,
      claimed_by: i < 19900 ? null : 'x',
      claimed_until: i >= 19900 && i < 19950 ? new Date(T0 - 1000000) : null,
      created_at: new Date(T0 + i),
      updated_at: new Date(T0 + i),
    });
  }
  await IntentOutbox.collection.insertMany(bulk, { ordered: false });

  const at = new Date();
  const before = await explainClaim(at);
  await IntentOutbox.collection.createIndex({ status: 1, claimed_until: 1 }, { name: 'test_status_claimed_until' });
  const after = await explainClaim(at);
  await IntentOutbox.collection.dropIndex('test_status_claimed_until');

  console.log('[query-plan] 20k rows, 100 pending, 50 expired claims');
  console.log('[query-plan] current indexes only:', JSON.stringify(before));
  console.log('[query-plan] with test-only {status:1, claimed_until:1}:', JSON.stringify(after));
  assert.equal(before.returned, 1);
  assert.equal(after.returned, 1);
});
