const test = require('node:test');
const assert = require('node:assert/strict');

const { validateIntentConfig, assertIntentConfig } = require('../../services/intent/config');

const QUEUE = 'https://sqs.ap-south-1.amazonaws.com/923233838659/intent-events';
const BRANDS = {
  INTENT_BRANDS_ALLOWLIST: 'bbb_shop',
  INTENT_BRAND_TIMEZONES: 'bbb_shop=Asia/Kolkata',
};
const VALID = { SQS_INTENT_QUEUE_URL: QUEUE, AWS_REGION: 'ap-south-1', ...BRANDS };

test('a complete sqs configuration has no errors', () => {
  assert.deepEqual(validateIntentConfig(VALID, 'sqs').errors, []);
});

test('missing SQS_INTENT_QUEUE_URL fails in sqs mode', () => {
  const { errors } = validateIntentConfig({ AWS_REGION: 'ap-south-1' }, 'sqs');
  assert.ok(errors.some((e) => e.includes('SQS_INTENT_QUEUE_URL is required')));
});

test('a malformed queue URL fails in sqs mode', () => {
  const { errors } = validateIntentConfig({ ...VALID, SQS_INTENT_QUEUE_URL: 'https://example.com/queue' }, 'sqs');
  assert.ok(errors.some((e) => e.includes('must look like')));
});

test('an AWS_REGION that differs from the queue region fails', () => {
  const { errors } = validateIntentConfig({ ...VALID, AWS_REGION: 'us-east-1' }, 'sqs');
  assert.ok(errors.some((e) => e.includes('does not match the queue URL region')));
});

test('an invalid AWS_REGION name fails', () => {
  const { errors } = validateIntentConfig({ ...VALID, AWS_REGION: 'south' }, 'sqs');
  assert.ok(errors.some((e) => e.includes('not a valid AWS region')));
});

test('concurrency above the socket cap fails', () => {
  const { errors } = validateIntentConfig({ ...VALID, INTENT_SQS_MAX_CONCURRENCY: '100', INTENT_SQS_MAX_SOCKETS: '64' }, 'sqs');
  assert.ok(errors.some((e) => e.includes('must not exceed INTENT_SQS_MAX_SOCKETS')));
});

test('concurrency at the socket cap passes', () => {
  assert.deepEqual(validateIntentConfig({ ...VALID, INTENT_SQS_MAX_CONCURRENCY: '64', INTENT_SQS_MAX_SOCKETS: '64' }, 'sqs').errors, []);
});

test('non-integer or zero INTEGER settings fail in any mode', () => {
  for (const mode of ['sqs', 'mongo']) {
    const { errors } = validateIntentConfig({ INTENT_SQS_MAX_PENDING: 'lots' }, mode);
    assert.ok(errors.some((e) => e.includes('INTENT_SQS_MAX_PENDING must be a positive integer')), mode);
    const zero = validateIntentConfig({ INTENT_SQS_MAX_ATTEMPTS: '0' }, mode);
    assert.ok(zero.errors.some((e) => e.includes('INTENT_SQS_MAX_ATTEMPTS')), mode);
  }
});

test('attempts above the cap and a send timeout above the proxy budget fail', () => {
  const { errors } = validateIntentConfig({ ...VALID, INTENT_SQS_MAX_ATTEMPTS: '9', INTENT_SQS_SEND_TIMEOUT_MS: '60000' }, 'sqs');
  assert.ok(errors.some((e) => e.includes('INTENT_SQS_MAX_ATTEMPTS')));
  assert.ok(errors.some((e) => e.includes('INTENT_SQS_SEND_TIMEOUT_MS')));
});

test('mongo mode does not require the SQS queue', () => {
  assert.deepEqual(validateIntentConfig(BRANDS, 'mongo').errors, []);
});

test('a missing brand allow-list fails in both modes', () => {
  for (const mode of ['sqs', 'mongo']) {
    const { errors } = validateIntentConfig({ AWS_REGION: 'ap-south-1', SQS_INTENT_QUEUE_URL: QUEUE }, mode);
    assert.ok(errors.some((e) => e.includes('INTENT_BRANDS_ALLOWLIST is required')), mode);
  }
});

test('assertIntentConfig throws with every problem listed', () => {
  assert.throws(
    () => assertIntentConfig({ AWS_REGION: 'ap-south-1', INTENT_SQS_MAX_CONCURRENCY: '100', INTENT_SQS_MAX_SOCKETS: '64' }, 'sqs'),
    (err) => err.message.includes('SQS_INTENT_QUEUE_URL is required') && err.message.includes('must not exceed'),
  );
});

test('assertIntentConfig passes for a valid sqs configuration', () => {
  assert.doesNotThrow(() => assertIntentConfig(VALID, 'sqs'));
});
