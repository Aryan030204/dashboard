const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createOutboxRelay, readRelayConfig } = require('../../services/intent/outboxRelay');
const { sendRawMessage } = require('../../services/intentEventQueue');

const BASE = Date.parse('2026-10-05T05:00:00.000Z');
const SILENT = { info() {}, warn() {}, error() {} };

function clockAt(ms) {
  const c = { t: ms };
  c.now = () => new Date(c.t);
  return c;
}

// ---- in-memory stand-in for the intent_outbox collection ----------------
function matchCond(value, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    if ('$lt' in cond) return value != null && value < cond.$lt;
    if ('$gt' in cond) return value != null && value > cond.$gt;
    if ('$not' in cond) return !matchCond(value, cond.$not);
  }
  return value === cond;
}
function matchFilter(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$and') return cond.every((f) => matchFilter(doc, f));
    if (key === '$or') return cond.some((f) => matchFilter(doc, f));
    return matchCond(doc[key], cond);
  });
}
function applyUpdate(doc, update) {
  Object.assign(doc, update.$set || {});
  for (const [k, v] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + v;
}

function createFakeOutbox(rows = []) {
  const docs = rows.map((r) => structuredClone(r));
  const model = {
    docs,
    findOneAndUpdate(filter, update, opts = {}) {
      const candidates = docs
        .filter((d) => matchFilter(d, filter))
        .sort((a, b) => a.created_at - b.created_at);
      const hit = candidates[0] || null;
      if (hit) applyUpdate(hit, update);
      return { lean: async () => (hit ? structuredClone(hit) : null) };
    },
    async updateOne(filter, update) {
      const hit = docs.find((d) => matchFilter(d, filter));
      if (!hit) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(hit, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    get(id) {
      return docs.find((d) => d._id === id);
    },
  };
  return model;
}

function payloadFor(id, createdOffset = 0) {
  return {
    schema_version: 1,
    type: 'event',
    message_key: id,
    brand_id: 'bbb_shop',
    event_id: id,
    event_name: 'product_viewed',
    actor_id: 'actor-1',
    client_id: 'cid-1',
    visitor_id: 'vid-1',
    session_id: 'sess-1',
    occurred_at: new Date(BASE + createdOffset).toISOString(),
    url: 'https://blabliblulife.com/products/x',
    referrer: null,
    user_agent: 'UA',
    session_start: new Date(BASE).toISOString(),
    session_end: null,
    session_time_spent: null,
    raw: { product_id: 'gid://shopify/Product/9' },
  };
}

function row(id, { createdOffset = 0, status = 'pending', attempts = 0, claimed_by = null, claimed_until = null, payload } = {}) {
  return {
    _id: id,
    message_id: `event:${id}`,
    brand_id: 'bbb_shop',
    type: 'event',
    schema_version: 1,
    payload: payload || payloadFor(id, createdOffset),
    status,
    attempts,
    claimed_by,
    claimed_until,
    sent_at: null,
    next_attempt_at: null,
    last_error: null,
    created_at: new Date(BASE + createdOffset),
    updated_at: new Date(BASE + createdOffset),
  };
}

function makeRelay(outbox, { clock, sendMessage, workerId = 'relay-a', batchSize = 10, claimTimeoutMs = 60000, retryBaseMs = 1000, retryMaxMs = 300000 } = {}) {
  return createOutboxRelay({
    IntentOutbox: outbox,
    sendMessage,
    workerId,
    batchSize,
    claimTimeoutMs,
    retryBaseMs,
    retryMaxMs,
    now: clock.now,
    logger: SILENT,
  });
}

function okSender(ids = []) {
  const bodies = [];
  let n = 0;
  return {
    bodies,
    send: async (body) => {
      bodies.push(body);
      n += 1;
      return ids[n - 1] || `sqs-${n}`;
    },
  };
}

test('pending row is claimed before its send, with a lease owned by this relay', async () => {
  const clock = clockAt(BASE);
  const outbox = createFakeOutbox([row('e1')]);
  let duringSend = null;
  const relay = makeRelay(outbox, {
    clock,
    sendMessage: async () => {
      duringSend = { ...outbox.get('e1') };
      return 'sqs-1';
    },
  });

  await relay.processOnce();

  assert.equal(duringSend.status, 'claimed');
  assert.equal(duringSend.claimed_by, 'relay-a');
  assert.equal(duringSend.claimed_until.getTime(), BASE + 60000);
});

test('successful SendMessage marks the row sent and clears the claim', async () => {
  const clock = clockAt(BASE + 5000);
  const outbox = createFakeOutbox([row('e1')]);
  const sender = okSender(['sqs-abc']);
  const relay = makeRelay(outbox, { clock, sendMessage: sender.send });

  const summary = await relay.processOnce();

  const stored = outbox.get('e1');
  assert.deepEqual(summary, { claimed: 1, sent: 1, failed: 0 });
  assert.equal(stored.status, 'sent');
  assert.deepEqual(stored.sent_at, new Date(BASE + 5000));
  assert.equal(stored.claimed_by, null);
  assert.equal(stored.claimed_until, null);
  assert.equal(stored.sqs_message_id, 'sqs-abc');
  assert.equal(stored.last_error, null);
});

test('failed SendMessage keeps the row pending, releases the claim, and records the error', async () => {
  const clock = clockAt(BASE);
  const outbox = createFakeOutbox([row('e1')]);
  const relay = makeRelay(outbox, {
    clock,
    sendMessage: async () => {
      throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    },
  });

  const summary = await relay.processOnce();

  const stored = outbox.get('e1');
  assert.deepEqual(summary, { claimed: 1, sent: 0, failed: 1 });
  assert.equal(stored.status, 'pending');
  assert.equal(stored.sent_at, null);
  assert.equal(stored.claimed_by, null);
  assert.equal(stored.claimed_until, null);
  assert.match(stored.last_error, /ThrottlingException: throttled/);
  assert.deepEqual(stored.next_attempt_at, new Date(BASE + 1000), 'first retry backoff is the base delay');
});

test('attempts increment on every claim, and backoff delays the next claim', async () => {
  const clock = clockAt(BASE);
  const outbox = createFakeOutbox([row('e1')]);
  let fail = true;
  const relay = makeRelay(outbox, {
    clock,
    sendMessage: async () => {
      if (fail) throw new Error('nope');
      return 'ok';
    },
  });

  await relay.processOnce();
  assert.equal(outbox.get('e1').attempts, 1);

  const early = await relay.processOnce();
  assert.equal(early.claimed, 0, 'not claimable before next_attempt_at');

  clock.t = BASE + 1000;
  fail = false;
  await relay.processOnce();
  assert.equal(outbox.get('e1').attempts, 2);
  assert.equal(outbox.get('e1').status, 'sent');
});

test('expired claim from a crashed relay is reclaimed and sent', async () => {
  const clock = clockAt(BASE + 120000);
  const outbox = createFakeOutbox([
    row('e1', { status: 'claimed', attempts: 1, claimed_by: 'crashed-relay', claimed_until: new Date(BASE + 60000) }),
  ]);
  const sender = okSender();
  const relay = makeRelay(outbox, { clock, sendMessage: sender.send, workerId: 'relay-b' });

  const summary = await relay.processOnce();

  assert.equal(summary.sent, 1);
  assert.equal(outbox.get('e1').status, 'sent');
  assert.equal(outbox.get('e1').attempts, 2);
  assert.equal(sender.bodies.length, 1);
});

test('active claim is not taken by another relay', async () => {
  const clock = clockAt(BASE + 1000);
  const outbox = createFakeOutbox([
    row('e1', { status: 'claimed', attempts: 1, claimed_by: 'relay-a', claimed_until: new Date(BASE + 60000) }),
  ]);
  const sender = okSender();
  const relayB = makeRelay(outbox, { clock, sendMessage: sender.send, workerId: 'relay-b' });

  const summary = await relayB.processOnce();

  assert.deepEqual(summary, { claimed: 0, sent: 0, failed: 0 });
  assert.equal(sender.bodies.length, 0);
  assert.equal(outbox.get('e1').claimed_by, 'relay-a', 'relay-a still owns its claim');
});

test('the exact stored payload is published unchanged, with no added fields', async () => {
  const clock = clockAt(BASE);
  const payload = payloadFor('e1');
  const outbox = createFakeOutbox([row('e1', { payload })]);
  const sender = okSender();
  const relay = makeRelay(outbox, { clock, sendMessage: sender.send });

  await relay.processOnce();

  assert.equal(sender.bodies[0], JSON.stringify(payload));
  const body = JSON.parse(sender.bodies[0]);
  assert.deepEqual(body, payload);
  assert.equal('ingested_at' in body, false);
});

test('multiple rows are claimed in created_at order, batch by batch', async () => {
  const clock = clockAt(BASE);
  const outbox = createFakeOutbox([
    row('e5', { createdOffset: 5 }),
    row('e1', { createdOffset: 1 }),
    row('e3', { createdOffset: 3 }),
    row('e2', { createdOffset: 2 }),
    row('e4', { createdOffset: 4 }),
  ]);
  const sender = okSender();
  const relay = makeRelay(outbox, { clock, sendMessage: sender.send, batchSize: 3 });

  const first = await relay.processOnce();
  const second = await relay.processOnce();

  assert.deepEqual(first, { claimed: 3, sent: 3, failed: 0 });
  assert.deepEqual(second, { claimed: 2, sent: 2, failed: 0 });
  const order = sender.bodies.map((b) => JSON.parse(b).event_id);
  assert.deepEqual(order, ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.ok(outbox.docs.every((d) => d.status === 'sent'));
});

test('retry after a lost markSent write is safe: the same body is resent and ends sent', async () => {
  const clock = clockAt(BASE);
  const outbox = createFakeOutbox([row('e1')]);
  const sender = okSender();

  const relay = makeRelay(outbox, { clock, sendMessage: sender.send });
  const realUpdate = outbox.updateOne;
  let failNextSentWrite = true;
  outbox.updateOne = async (filter, update) => {
    if (failNextSentWrite && update.$set && update.$set.status === 'sent') {
      failNextSentWrite = false;
      throw new Error('mongo blip');
    }
    return realUpdate.call(outbox, filter, update);
  };

  const first = await relay.processOnce();
  assert.equal(first.failed, 1, 'markSent failure is counted, not thrown');
  assert.equal(outbox.get('e1').status, 'claimed', 'row keeps its lease until it expires');

  clock.t = BASE + 60001;
  const second = await relay.processOnce();

  assert.equal(second.sent, 1);
  assert.equal(outbox.get('e1').status, 'sent');
  assert.equal(sender.bodies.length, 2);
  assert.equal(sender.bodies[0], sender.bodies[1], 'identical body both times');
});

test('lease lost mid-send: the stale relay does not overwrite the new owner', async () => {
  const clock = clockAt(BASE);
  const outbox = createFakeOutbox([row('e1')]);
  const senderA = okSender(['sqs-a']);
  const senderB = okSender(['sqs-b']);

  const relayB = makeRelay(outbox, { clock, sendMessage: senderB.send, workerId: 'relay-b' });
  const relayA = makeRelay(outbox, {
    clock,
    workerId: 'relay-a',
    sendMessage: async (body) => {
      clock.t = BASE + 61000;
      await relayB.processOnce();
      return senderA.send(body);
    },
  });

  const summary = await relayA.processOnce();

  assert.equal(summary.sent, 1);
  assert.equal(senderB.bodies.length, 1, 'relay-b reclaimed and sent after expiry');
  assert.equal(outbox.get('e1').status, 'sent');
  assert.equal(outbox.get('e1').sqs_message_id, 'sqs-b', 'relay-b state is kept, not overwritten');
});

test('invalid stored payload is never sent and stays pending with the reason recorded', async () => {
  const clock = clockAt(BASE);
  const bad = { ...payloadFor('e1'), event_id: undefined };
  const outbox = createFakeOutbox([row('e1', { payload: bad })]);
  const sender = okSender();
  const relay = makeRelay(outbox, { clock, sendMessage: sender.send });

  const summary = await relay.processOnce();

  assert.equal(summary.failed, 1);
  assert.equal(sender.bodies.length, 0);
  assert.equal(outbox.get('e1').status, 'pending');
  assert.match(outbox.get('e1').last_error, /invalid payload/);
});

test('retry backoff doubles and is capped', async () => {
  const clock = clockAt(BASE);
  const outbox = createFakeOutbox([row('e1')]);
  const relay = makeRelay(outbox, {
    clock,
    retryBaseMs: 1000,
    retryMaxMs: 4000,
    sendMessage: async () => {
      throw new Error('down');
    },
  });

  const deltas = [];
  for (let i = 0; i < 4; i++) {
    await relay.processOnce();
    const stored = outbox.get('e1');
    deltas.push(stored.next_attempt_at.getTime() - clock.t);
    clock.t = stored.next_attempt_at.getTime();
  }
  assert.deepEqual(deltas, [1000, 2000, 4000, 4000]);
});

test('duplicate-safe re-run: a sent row is never claimed again', async () => {
  const clock = clockAt(BASE);
  const outbox = createFakeOutbox([row('e1')]);
  const sender = okSender();
  const relay = makeRelay(outbox, { clock, sendMessage: sender.send });

  await relay.processOnce();
  clock.t = BASE + 600000;
  const again = await relay.processOnce();

  assert.equal(again.claimed, 0);
  assert.equal(sender.bodies.length, 1);
});

test('sendRawMessage passes the body through unchanged and requires a queue URL', async () => {
  const sent = [];
  const sqs = { send: async (command) => { sent.push(command.input); return { MessageId: 'm-7' }; } };
  const body = JSON.stringify({ schema_version: 1, type: 'event', event_id: 'e1' });

  const id = await sendRawMessage(body, { sqs, queueUrl: 'https://sqs/intent-events' });

  assert.equal(id, 'm-7');
  assert.equal(sent[0].MessageBody, body);
  assert.equal(sent[0].QueueUrl, 'https://sqs/intent-events');
  await assert.rejects(sendRawMessage(body, { sqs, queueUrl: '' }), /SQS_INTENT_QUEUE_URL/);
});

test('readRelayConfig reads environment settings, applies defaults, and rejects bad values', () => {
  const cfg = readRelayConfig({ SQS_INTENT_QUEUE_URL: 'https://sqs/q', INTENT_OUTBOX_RELAY_BATCH_SIZE: '25' });
  assert.equal(cfg.queueUrl, 'https://sqs/q');
  assert.equal(cfg.region, 'ap-south-1');
  assert.equal(cfg.batchSize, 25);
  assert.equal(cfg.claimTimeoutMs, 60000);
  assert.equal(cfg.pollIntervalMs, 1000);
  assert.ok(cfg.workerId.length > 0);

  assert.throws(() => readRelayConfig({}), /SQS_INTENT_QUEUE_URL is required/);
  assert.throws(
    () => readRelayConfig({ SQS_INTENT_QUEUE_URL: 'x', INTENT_OUTBOX_RELAY_BATCH_SIZE: '0' }),
    /INTENT_OUTBOX_RELAY_BATCH_SIZE/,
  );
  assert.throws(
    () => readRelayConfig({ SQS_INTENT_QUEUE_URL: 'x', INTENT_OUTBOX_CLAIM_TIMEOUT_MS: 'soon' }),
    /INTENT_OUTBOX_CLAIM_TIMEOUT_MS/,
  );
});

test('no AWS access keys are hardcoded or read by the relay path', () => {
  const root = path.join(__dirname, '..', '..');
  const files = [
    'services/intent/outboxRelay.js',
    'services/intentEventQueue.js',
    'scripts/intent-outbox-relay.js',
  ];
  for (const rel of files) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.equal(/AKIA[0-9A-Z]{16}/.test(source), false, `${rel} contains an access-key-shaped literal`);
    assert.equal(source.includes('AWS_ACCESS_KEY_ID'), false, `${rel} reads AWS_ACCESS_KEY_ID`);
    assert.equal(source.includes('AWS_SECRET_ACCESS_KEY'), false, `${rel} reads AWS_SECRET_ACCESS_KEY`);
  }
});
