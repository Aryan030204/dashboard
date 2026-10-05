const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTrackController, INTENT_MODES } = require('../controllers/trackController');

function fakeRes() {
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

// Records every touch of an RS Mongo model, so a test can prove nothing was written.
function fakeModel(name, calls) {
  return class FakeModel {
    constructor(doc) {
      this.doc = doc;
    }
    async save() {
      calls.push({ model: name, op: 'save', doc: this.doc });
    }
    static async findOne(query) {
      calls.push({ model: name, op: 'findOne', query });
      return null;
    }
  };
}

function build({ mode }) {
  const modelCalls = [];
  const intentCalls = [];
  const publishCalls = [];
  const controller = buildTrackController({
    OtpVerified: fakeModel('OtpVerified', modelCalls),
    AjrsPurchase: fakeModel('AjrsPurchase', modelCalls),
    logger: { info() {}, warn() {}, error() {} },
    ingestionMode: mode,
    intentIngest: async (body, brand) => {
      intentCalls.push({ brand, body });
    },
    intentSqsPublish: async (body, brand) => {
      publishCalls.push({ brand, body });
      return { event_id: body.event_id || 'srv-generated', type: 'event', messageId: 'm-1' };
    },
    isKnownBrand: () => true,
  });
  return { controller, modelCalls, intentCalls, publishCalls };
}

async function track(controller, body) {
  const res = fakeRes();
  await controller.track({ body }, res);
  return res;
}

const intentEvent = (overrides = {}) => ({
  event_id: 'sh-1',
  event_name: 'page_viewed',
  occurred_at: '2026-10-05T05:00:00.000Z',
  brand_id: 'bbb_shop',
  client_id: 'client-1',
  url: 'https://shop.example/',
  referrer: null,
  user_agent: 'UA',
  data: {},
  ...overrides,
});

test('normal intent event in sqs mode goes to SQS and touches no RS model', async () => {
  const { controller, modelCalls, publishCalls } = build({ mode: INTENT_MODES.SQS });
  const res = await track(controller, intentEvent());
  assert.equal(res.statusCode, 202);
  assert.equal(publishCalls.length, 1);
  assert.deepEqual(modelCalls, []);
});

test('intent event with a top-level orderId in sqs mode goes to SQS, not the RS branch', async () => {
  const { controller, modelCalls, publishCalls } = build({ mode: INTENT_MODES.SQS });
  const res = await track(controller, intentEvent({ orderId: 'ord-99', event_name: 'checkout_completed' }));
  assert.equal(res.statusCode, 202);
  assert.equal(publishCalls.length, 1);
  assert.deepEqual(modelCalls, [], 'no AjrsPurchase write for an intent event');
});

test('intent event with tags RS_Cinema_KP in sqs mode goes to SQS, not the RS branch', async () => {
  const { controller, modelCalls, publishCalls } = build({ mode: INTENT_MODES.SQS });
  const res = await track(controller, intentEvent({ tags: 'RS_Cinema_KP', customer_id: 'cust-1' }));
  assert.equal(res.statusCode, 202);
  assert.equal(publishCalls.length, 1);
  assert.deepEqual(modelCalls, []);
});

test('intent event with a top-level orderId in mongo mode goes to the intent ingestor, not the RS branch', async () => {
  const { controller, modelCalls, intentCalls } = build({ mode: INTENT_MODES.MONGO });
  const res = await track(controller, intentEvent({ orderId: 'ord-99' }));
  assert.equal(res.statusCode, 204);
  assert.equal(intentCalls.length, 1);
  assert.deepEqual(modelCalls, []);
});

test('legitimate RS orderId payload still writes AjrsPurchase, and never reaches SQS', async () => {
  const { controller, modelCalls, publishCalls } = build({ mode: INTENT_MODES.SQS });
  const res = await track(controller, { orderId: 'ord-55' });
  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.message, 'Session tracked successfully');
  assert.deepEqual(
    modelCalls.map((c) => `${c.model}.${c.op}`),
    ['AjrsPurchase.findOne', 'AjrsPurchase.save'],
  );
  assert.equal(publishCalls.length, 0);
});

test('legitimate RS_Cinema_KP payload still writes OtpVerified, and never reaches SQS', async () => {
  const { controller, modelCalls, publishCalls } = build({ mode: INTENT_MODES.SQS });
  const res = await track(controller, { tags: 'RS_Cinema_KP', customer_id: 'cust-7' });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(
    modelCalls.map((c) => `${c.model}.${c.op}`),
    ['OtpVerified.findOne', 'OtpVerified.save'],
  );
  assert.equal(publishCalls.length, 0);
});

test('no intent event payload is ever written to an RS Mongo collection', async () => {
  const payloads = [
    intentEvent(),
    intentEvent({ orderId: 'ord-1' }),
    intentEvent({ tags: 'RS_Cinema_KP', customer_id: 'c-1' }),
    intentEvent({ orderId: 'ord-2', tags: 'RS_Cinema_KP', event_name: 'click', data: {} }),
  ];
  for (const mode of [INTENT_MODES.SQS, INTENT_MODES.MONGO]) {
    for (const body of payloads) {
      const { controller, modelCalls } = build({ mode });
      await track(controller, body);
      assert.deepEqual(modelCalls, [], `mode=${mode} body=${JSON.stringify(body)}`);
    }
  }
});
