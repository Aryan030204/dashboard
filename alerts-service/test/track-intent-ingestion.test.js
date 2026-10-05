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
    sendStatus(code) {
      this.statusCode = code;
      this.payload = null;
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

function buildController({
  mode,
  models,
  queue,
  intentSqsPublish = async () => ({ event_id: 'evt-1', type: 'event', messageId: 'm-1' }),
  intentIngest = async () => ({ inserted: true, kind: 'event' }),
  isKnownBrand = () => true,
}) {
  return buildTrackController({
    ...models,
    logger: silentLogger,
    ingestionMode: mode,
    intentIngest,
    intentSqsPublish,
    isKnownBrand,
  });
}

function intentEvent(overrides = {}) {
  return {
    event_id: 'evt-1',
    event_name: 'page_viewed',
    occurred_at: '2026-09-19T05:56:39.008Z',
    brand_id: 'bbb_shop',
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

function normalEvent(overrides = {}) {
  return {
    brand_id: 'bbb_shop',
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

test('mongo mode: valid intent event for a known brand is ingested and returns 204', async () => {
  const ingested = [];
  const intentIngest = async (body, brand) => {
    ingested.push({ body, brand });
    return { inserted: true, kind: 'event' };
  };
  const models = makeFakeModels();
  const queue = makeFakeQueue();
  const controller = buildController({ mode: INTENT_MODES.MONGO, models, queue, intentIngest });

  const res = await track(controller, intentEvent());

  assert.equal(res.statusCode, 204);
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].brand, 'bbb_shop');
  assert.equal(queue.sent.length, 0);
  assert.equal(models.calls.sessionSaved.length, 0);
});

test('mongo mode: duplicate event is still 204 (no Session writes, no SQS)', async () => {
  const intentIngest = async () => ({ inserted: false, kind: 'event' });
  const models = makeFakeModels();
  const queue = makeFakeQueue();
  const controller = buildController({ mode: INTENT_MODES.MONGO, models, queue, intentIngest });

  const res = await track(controller, intentEvent());

  assert.equal(res.statusCode, 204);
  assert.equal(models.calls.sessionSaved.length, 0);
  assert.equal(queue.sent.length, 0);
});

test('mongo mode: unknown or inactive brand_id returns 400 and never ingests', async () => {
  let called = false;
  const controller = buildController({
    mode: INTENT_MODES.MONGO,
    models: makeFakeModels(),
    queue: makeFakeQueue(),
    intentIngest: async () => {
      called = true;
      return { inserted: true };
    },
    isKnownBrand: () => false,
  });

  const res = await track(controller, intentEvent({ brand_id: 'nope_shop' }));

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'unknown or inactive brand_id');
  assert.equal(called, false);
});

test('mongo mode: intent payload that fails validation returns 400', async () => {
  const controller = buildController({
    mode: INTENT_MODES.MONGO,
    models: makeFakeModels(),
    queue: makeFakeQueue(),
    intentIngest: async () => {
      const err = new Error('invalid occurred_at');
      err.status = 400;
      throw err;
    },
  });

  const res = await track(controller, intentEvent({ occurred_at: 'not-a-date' }));

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'invalid event payload');
});

test('sqs mode: idempotency_key is not required; event_id is published and 202 returned', async () => {
  const seen = [];
  const controller = buildController({
    mode: INTENT_MODES.SQS,
    models: makeFakeModels(),
    queue: makeFakeQueue(),
    intentSqsPublish: async (body, brand) => {
      seen.push({ body, brand });
      return { event_id: body.event_id, type: 'event', messageId: 'm-1' };
    },
  });

  const res = await track(controller, normalEvent({ idempotency_key: undefined }));

  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.payload, { message: 'Event accepted', event_id: 'evt-1' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].brand, 'bbb_shop');
});

test('sqs mode: unknown or inactive brand_id returns 400 and never publishes', async () => {
  let published = 0;
  const controller = buildController({
    mode: INTENT_MODES.SQS,
    models: makeFakeModels(),
    queue: makeFakeQueue(),
    isKnownBrand: () => false,
    intentSqsPublish: async () => {
      published += 1;
      return { event_id: 'evt-1' };
    },
  });

  const res = await track(controller, normalEvent());

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'unknown or inactive brand_id');
  assert.equal(published, 0);
});

test('sqs mode: duplicate requests are not deduplicated; each one is published and returns 202', async () => {
  let published = 0;
  const controller = buildController({
    mode: INTENT_MODES.SQS,
    models: makeFakeModels(),
    queue: makeFakeQueue(),
    intentSqsPublish: async () => {
      published += 1;
      return { event_id: 'evt-1' };
    },
  });

  const first = await track(controller, normalEvent());
  const second = await track(controller, normalEvent());

  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 202);
  assert.equal(published, 2);
});

test('sqs mode: invalid payload rejected by the producer returns 400 and never reports success', async () => {
  const controller = buildController({
    mode: INTENT_MODES.SQS,
    models: makeFakeModels(),
    queue: makeFakeQueue(),
    intentSqsPublish: async () => {
      throw Object.assign(new Error('invalid occurred_at'), { status: 400 });
    },
  });

  const res = await track(controller, normalEvent());

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'invalid event payload');
  assert.equal(res.payload.message, undefined);
});

test('sqs mode: intent path never calls the Mongo intent ingestor or writes Session', async () => {
  const models = makeFakeModels();
  let mongoIngests = 0;
  const controller = buildController({
    mode: INTENT_MODES.SQS,
    models,
    queue: makeFakeQueue(),
    intentIngest: async () => {
      mongoIngests += 1;
      return { inserted: true, kind: 'event' };
    },
    intentSqsPublish: async () => ({ event_id: 'evt-1' }),
  });

  const res = await track(controller, normalEvent());

  assert.equal(res.statusCode, 202);
  assert.equal(mongoIngests, 0);
  assert.equal(models.calls.sessionFindOne.length, 0);
  assert.equal(models.calls.sessionSaved.length, 0);
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
  const controller = buildController({
    mode: INTENT_MODES.SQS,
    models: makeFakeModels(),
    queue: makeFakeQueue(),
    intentSqsPublish: async () => {
      throw Object.assign(new Error('throttled'), { status: 503 });
    },
  });

  const res = await track(controller, normalEvent());

  assert.equal(res.statusCode, 503);
  assert.notEqual(res.statusCode, 202);
  assert.equal(res.payload.message, undefined);
  assert.equal(res.payload.error, 'Failed to queue event');
});

test('sqs mode: oversize message from the producer returns 413', async () => {
  const controller = buildController({
    mode: INTENT_MODES.SQS,
    models: makeFakeModels(),
    queue: makeFakeQueue(),
    intentSqsPublish: async () => {
      throw Object.assign(new Error('too large'), { status: 413 });
    },
  });

  const res = await track(controller, normalEvent({ data: { blob: 'x'.repeat(SQS_MESSAGE_LIMIT_BYTES + 10) } }));

  assert.equal(res.statusCode, 413);
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

test('unexpected infrastructure error in mongo mode returns 500', async () => {
  const controller = buildController({
    mode: INTENT_MODES.MONGO,
    models: makeFakeModels(),
    queue: makeFakeQueue(),
    intentIngest: async () => {
      throw new Error('mongo down');
    },
  });

  const res = await track(controller, intentEvent());

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
