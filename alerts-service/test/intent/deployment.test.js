const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');

function read(relative) {
  return fs.readFileSync(path.join(REPO, relative), 'utf8');
}

test('the default compose service list does not include the outbox relay', () => {
  const source = read('scripts/compose-stack.js');
  const start = source.indexOf('const BASE_SERVICES = [');
  const end = source.indexOf('];', start);
  assert.ok(start !== -1 && end !== -1, 'BASE_SERVICES must be present');
  const block = source.slice(start, end);
  assert.equal(block.includes('intent-outbox-relay'), false);
  assert.equal(block.includes('alerts-service'), true, 'alerts-service must still be deployed');
});

test('the outbox relay compose service is opt-in only, behind a profile', () => {
  const compose = read('docker-compose.yml');
  const index = compose.indexOf('\n  intent-outbox-relay:');
  assert.ok(index !== -1, 'the relay service definition is kept for the legacy path');
  // The service block runs until the next top-level service (two-space indent).
  const rest = compose.slice(index + 1);
  const next = rest.search(/\n {2}[a-z][\w-]*:\s*\n/);
  const serviceBlock = next === -1 ? rest : rest.slice(0, next);
  assert.match(serviceBlock, /profiles:\s*\["outbox-relay"\]/);
});

test('no deploy workflow or script starts the outbox relay', () => {
  const dirs = ['.github/workflows'];
  for (const dir of dirs) {
    const full = path.join(REPO, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of fs.readdirSync(full)) {
      const text = fs.readFileSync(path.join(full, file), 'utf8');
      assert.equal(text.includes('intent-outbox-relay'), false, `${file} must not start the relay`);
      assert.equal(text.includes('outbox-relay'), false, `${file} must not start the relay profile`);
    }
  }
});

test('the intent path never imports the Mongo outbox or intent models', () => {
  const files = [
    'services/intent/sqsProducer.js',
    'services/intent/sqsPublisher.js',
    'services/intentEventQueue.js',
    'services/intent/config.js',
  ];
  const forbidden = /mongoose|models\/intent|outboxIngest|outboxRelay|IntentOutbox|getIntentModels/;
  for (const file of files) {
    const source = fs.readFileSync(path.join(REPO, 'alerts-service', file), 'utf8');
    assert.equal(forbidden.test(source), false, `${file} must not depend on Mongo`);
  }
});
