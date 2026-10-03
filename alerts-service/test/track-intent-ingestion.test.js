const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildTrackController,
  resolveIntentIngestionMode,
  INTENT_MODES,
} = require('../controllers/trackController');
const {
  SQS_MESSAGE_LIMIT_BYTES,
  serializeIntentEvent,
  sendIntentEvent,
} = require('../services/intentEventQueue');

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
  };
}

const silentLogger = { info() {}, warn() {}, error() {} };

function makeFakeModels({ existingSession = null, existingOtp = null, existingPurchase = null } = {}) {
  const calls = { sessionFindOne: [], sessionSaved: [], otpSaved: [], purchaseSaved: [] };

  function FakeSession(doc) {
    Object.assign(this, doc);
    this.save = async () => {
      calls.sessionSaved.push({ ...doc });
    };
  }
  FakeSession.findOne = async (query) => {
    calls.sessionFindOne.push(query);
    return existingSession;
  };

  function FakeOtp(doc) {
    this.save = async () => calls.otpSaved.push(doc);
  }
  FakeOtp.findOne = async () => existingOtp;

  function FakePurchase(doc) {
    this.save = async () => calls.purchaseSaved.push(doc);
  }
  FakePurchase.findOne = async () => existingPurchase;

  return { calls, Session: FakeSession, OtpVerified: FakeOtp, AjrsPurchase: FakePurchase };
}

function makeFakeQueue({ messageId = 'msg-123', error = null } = {}) {
  const sent = [];
  return {
    sent,
    sendIntentEvent: async (event) => {
      if (error) throw error;
      sent.push(event);
      return messageId;
    },
  };
}

function buildController({ mode, models, queue, limit = SQS_MESSAGE_LIMIT_BYTES }) {
  return buildTrackController({
    ...models,
    logger: silentLogger,
    intentEventQueue: queue,
    sqsMessageLimitBytes: limit,
    ingestionMode: mode,
  });
}

function normalEvent(overrides = {}) {
  return {
    event_id: 'evt-1',
    idempotency_key: 'idem-abc',
    event_type: 'add_to_cart',
    session_id: 'sess-1',
    variantId: 42,
    shop_name: 'pts',
    cart_token: 'cart-1',
    checkout_token: null,
    user_agent: 'UA',
    url: 'https://shop.example/products/x',
    data: { price: 100, nested: { a: [1, 2] } },
    ...overrides,
  };
}

async function track(controller, body) {
  const res = makeRes();
  await controller.track({ body }, res);
  return res;
}

test('mode resolution defaults to mongo when unset, and only "sqs" enables SQS', () => {
  assert.equal(resolveIntentIngestionMode(undefined), INTENT_MODES.MONGO);
  assert.equal(resolveIntentIngestionMode(''), INTENT_MODES.MONGO);
  assert.equal(resolveIntentIngestionMode('mongo'), INTENT_MODES.MONGO);
  assert.equal(resolveIntentIngestionMode(' SQS '), INTENT_MODES.SQS);
  assert.equal(resolveIntentIngestionMode('sqs'), INTENT_MODES.SQS);
});

test('unknown mode value falls back to mongo and warns', () => {
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m) };
  assert.equal(resolveIntentIngestionMode('kafka', logger), INTENT_MODES.MONGO);
  assert.equal(warnings.length, 1);
});

test('mongo mode: normal event is checked against Session and saved, returns 201', async () => {
  const models = makeFakeModels();
  const queue = makeFakeQueue();
  const controller = buildController({ mode: INTENT_MODES.MONGO, models, queue });

  const res = await track(controller, normalEvent());

  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.message, 'Session tracked successfully');
  assert.deepEqual(models.calls.sessionFindOne, [{ idempotency_key: 'idem-abc' }]);
  assert.equal(models.calls.sessionSaved.length, 1);
  assert.equal(models.calls.sessionSaved[0].idempotency_key, 'idem-abc');
  assert.equal(queue.sent.length, 0);
});

test('mongo mode: duplicate idempotency_key returns 200 "Event already processed"', async () => {
  const existing = { idempotency_key: 'idem-abc' };
  const models = makeFakeModels({ existingSession: existing });
  const queue = makeFakeQueue();
  const controller = buildController({ mode: INTENT_MODES.MONGO, models, queue });

  const res = await track(controller, normalEvent());

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.message, 'Event already processed');
  assert.equal(res.payload.session, existing);
  assert.equal(models.calls.sessionSaved.length, 0);
});

test('missing idempotency_key returns 400 in mongo mode and sqs mode', async () => {
  for (const mode of [INTENT_MODES.MONGO, INTENT_MODES.SQS]) {
    const models = makeFakeModels();
    const queue = makeFakeQueue();
    const controller = buildController({ mode, models, queue });

    const res = await track(controller, normalEvent({ idempotency_key: undefined }));

    assert.equal(res.statusCode, 400, mode);
    assert.equal(res.payload.error, 'idempotency_key is required');
    assert.equal(queue.sent.length, 0);
    assert.equal(models.calls.sessionSaved.length, 0);
  }
});

test('sqs mode: normal event returns 202 and sends the complete payload to SQS', async () => {
  const models = makeFakeModels();
  const queue = makeFakeQueue({ messageId: 'mid-9' });
  const controller = buildController({ mode: INTENT_MODES.SQS, models, queue });
  const event = normalEvent();

  const res = await track(controller, event);

  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.payload, { message: 'Event accepted', event_id: 'idem-abc' });
  assert.equal(queue.sent.length, 1);
  for (const [key, value] of Object.entries(event)) {
    assert.deepEqual(queue.sent[0][key], value, `field ${key} must be preserved`);
  }
  assert.equal(queue.sent[0].idempotency_key, 'idem-abc');
});

test('sqs mode: never queries or writes the Mongo Session collection', async () => {
  const models = makeFakeModels();
  const queue = makeFakeQueue();
  const controller = buildController({ mode: INTENT_MODES.SQS, models, queue });

  await track(controller, normalEvent());

  assert.equal(models.calls.sessionFindOne.length, 0);
  assert.equal(models.calls.sessionSaved.length, 0);
});

test('sqs mode: serialized message contains ingested_at as an ISO timestamp', () => {
  const body = JSON.parse(serializeIntentEvent(normalEvent()));
  assert.match(body.ingested_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('sqs mode: SQS failure returns 503 and never reports success', async () => {
  const models = makeFakeModels();
  const queue = makeFakeQueue({ error: Object.assign(new Error('throttled'), { name: 'ThrottlingException' }) });
  const controller = buildController({ mode: INTENT_MODES.SQS, models, queue });

  const res = await track(controller, normalEvent());

  assert.ok(res.statusCode >= 500 && res.statusCode <= 599, `expected 5xx, got ${res.statusCode}`);
  assert.notEqual(res.statusCode, 202);
  assert.notEqual(res.statusCode, 200);
  assert.equal(res.payload.message, undefined);
  assert.equal(res.payload.error, 'Failed to queue event');
});

test('sqs mode: event over 256 KB returns 413 and SQS is not called', async () => {
  const models = makeFakeModels();
  const queue = makeFakeQueue();
  const controller = buildController({ mode: INTENT_MODES.SQS, models, queue });
  const huge = normalEvent({ data: { blob: 'x'.repeat(SQS_MESSAGE_LIMIT_BYTES + 10) } });

  const res = await track(controller, huge);

  assert.equal(res.statusCode, 413);
  assert.equal(queue.sent.length, 0);
});

test('RS_Cinema_KP event still writes OtpVerified and not Session, in both modes', async () => {
  for (const mode of [INTENT_MODES.MONGO, INTENT_MODES.SQS]) {
    const models = makeFakeModels();
    const queue = makeFakeQueue();
    const controller = buildController({ mode, models, queue });

    const res = await track(controller, { tags: 'RS_Cinema_KP', customer_id: 'cust-7' });

    assert.equal(res.statusCode, 201, mode);
    assert.equal(res.payload.message, 'Session tracked successfully');
    assert.deepEqual(models.calls.otpSaved, [{ customer_id: 'cust-7' }]);
    assert.equal(models.calls.sessionSaved.length, 0);
    assert.equal(queue.sent.length, 0);
  }
});

test('RS_Cinema_KP with an idempotency_key skips the Session lookup and never reaches SQS', async () => {
  for (const mode of [INTENT_MODES.MONGO, INTENT_MODES.SQS]) {
    const models = makeFakeModels({ existingSession: { idempotency_key: 'idem-rs' } });
    const queue = makeFakeQueue();
    const controller = buildController({ mode, models, queue });

    const res = await track(controller, {
      tags: 'RS_Cinema_KP',
      customer_id: 'cust-9',
      idempotency_key: 'idem-rs',
    });

    assert.equal(res.statusCode, 201, mode);
    assert.equal(models.calls.sessionFindOne.length, 0, mode);
    assert.equal(models.calls.sessionSaved.length, 0, mode);
    assert.equal(queue.sent.length, 0, mode);
    assert.deepEqual(models.calls.otpSaved, [{ customer_id: 'cust-9' }], mode);
  }
});

test('orderId with an idempotency_key skips the Session lookup and never reaches SQS', async () => {
  for (const mode of [INTENT_MODES.MONGO, INTENT_MODES.SQS]) {
    const models = makeFakeModels({ existingSession: { idempotency_key: 'idem-ord' } });
    const queue = makeFakeQueue();
    const controller = buildController({ mode, models, queue });

    const res = await track(controller, { orderId: 'ord-77', idempotency_key: 'idem-ord' });

    assert.equal(res.statusCode, 201, mode);
    assert.equal(models.calls.sessionFindOne.length, 0, mode);
    assert.deepEqual(models.calls.purchaseSaved, [{ order_id: 'ord-77' }], mode);
    assert.equal(queue.sent.length, 0, mode);
  }
});

test('RS_Cinema_KP does not re-save an existing OtpVerified record', async () => {
  const models = makeFakeModels({ existingOtp: { customer_id: 'cust-7' } });
  const controller = buildController({ mode: INTENT_MODES.SQS, models, queue: makeFakeQueue() });

  await track(controller, { tags: 'RS_Cinema_KP', customer_id: 'cust-7' });

  assert.equal(models.calls.otpSaved.length, 0);
});

test('orderId event still writes AjrsPurchase and not Session, in both modes', async () => {
  for (const mode of [INTENT_MODES.MONGO, INTENT_MODES.SQS]) {
    const models = makeFakeModels();
    const queue = makeFakeQueue();
    const controller = buildController({ mode, models, queue });

    const res = await track(controller, { orderId: 'ord-55' });

    assert.equal(res.statusCode, 201, mode);
    assert.deepEqual(models.calls.purchaseSaved, [{ order_id: 'ord-55' }]);
    assert.equal(models.calls.sessionSaved.length, 0);
    assert.equal(queue.sent.length, 0);
  }
});

test('unexpected Mongo error in mongo mode returns 500', async () => {
  const models = makeFakeModels();
  models.Session.findOne = async () => {
    throw new Error('mongo down');
  };
  const controller = buildController({ mode: INTENT_MODES.MONGO, models, queue: makeFakeQueue() });

  const res = await track(controller, normalEvent());

  assert.equal(res.statusCode, 500);
  assert.equal(res.payload.error, 'Failed to track alert');
});

test('sendIntentEvent returns SQS MessageId and uses the configured queue URL', async () => {
  const sentCommands = [];
  const sqs = { send: async (cmd) => {
    sentCommands.push(cmd);
    return { MessageId: 'abc-1' };
  } };
  const queueUrl = 'https://sqs.ap-south-1.amazonaws.com/000000000000/intent-events';

  const messageId = await sendIntentEvent(normalEvent(), { sqs, queueUrl });

  assert.equal(messageId, 'abc-1');
  assert.equal(sentCommands[0].input.QueueUrl, queueUrl);
  assert.equal(JSON.parse(sentCommands[0].input.MessageBody).idempotency_key, 'idem-abc');
});

test('sendIntentEvent rethrows SQS errors instead of swallowing them', async () => {
  const sqs = { send: async () => { throw new Error('AccessDenied'); } };
  await assert.rejects(
    sendIntentEvent(normalEvent(), { sqs, queueUrl: 'https://example/q' }),
    /AccessDenied/,
  );
});

test('sendIntentEvent fails loudly when SQS_INTENT_QUEUE_URL is not configured', async () => {
  const previous = process.env.SQS_INTENT_QUEUE_URL;
  delete process.env.SQS_INTENT_QUEUE_URL;
  try {
    await assert.rejects(
      sendIntentEvent(normalEvent(), { sqs: { send: async () => ({}) } }),
      /SQS_INTENT_QUEUE_URL/,
    );
  } finally {
    if (previous !== undefined) process.env.SQS_INTENT_QUEUE_URL = previous;
  }
});

test('no AWS access keys are read or required by the SQS integration', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'intentEventQueue.js'),
    'utf8',
  );
  assert.equal(source.includes('AWS_ACCESS_KEY_ID'), false);
  assert.equal(source.includes('AWS_SECRET_ACCESS_KEY'), false);
  assert.equal(/credentials\s*:/.test(source), false);
});
