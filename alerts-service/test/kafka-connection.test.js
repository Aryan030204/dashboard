// Connection-manager behaviour of the Kafka producer, including the failure seen in
// production after a restart: Kafka not ready yet when alerts-service starts, and a
// connect that takes longer than a request's send deadline.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createKafkaPublisher } = require('../services/intent/kafkaProducer');

const SILENT = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(10); }
  return false;
}
const cfg = (o = {}) => ({
  brokers: ['kafka-service:9092'], clientId: 't', connectionTimeoutMs: 50, maxInFlight: 10,
  connectWaitMs: 30, connectTimeoutMs: 400, backoffInitialMs: 20, backoffMaxMs: 60,
  sendTimeoutMs: 100, failureThreshold: 3, ...o,
});
const msg = { topic: 't', key: 'k', value: 'v' };
const connErr = () => Object.assign(new Error('x'), { name: 'KafkaJSNumberOfRetriesExceeded' });

// connectDelays: per attempt, 'fail' | 'hang' | milliseconds to wait before succeeding.
function scriptedKafka({ connectDelays = [0], send } = {}) {
  let built = 0;
  const state = { built: () => built, connectAttempts: 0, sends: 0 };
  const kafka = {
    producer: () => {
      built += 1;
      return {
        events: { DISCONNECT: 'producer.disconnect' },
        on() {},
        connect: async () => {
          const d = connectDelays[Math.min(state.connectAttempts++, connectDelays.length - 1)];
          if (d === 'fail') throw new Error('Connection timeout');
          if (d === 'hang') return new Promise(() => {});
          if (d) await sleep(d);
        },
        disconnect: async () => {},
        send: async (r) => { state.sends += 1; return send ? send(r, state) : [{ partition: 0, baseOffset: String(state.sends) }]; },
      };
    },
  };
  return { kafka, state };
}
const make = (script, o) => createKafkaPublisher({ statsIntervalMs: 0, config: cfg(o), logger: SILENT, kafka: script.kafka });

test('not connected: a request fails fast instead of waiting for its send deadline', async () => {
  const pub = make(scriptedKafka({ connectDelays: ['fail'] }), { sendTimeoutMs: 5000 });
  const t = Date.now();
  await assert.rejects(pub.publish(msg), (e) => e.category === 'unavailable');
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
  await pub.shutdown();
});

test('slow Kafka boot: a connect slower than the send deadline still completes, and later requests succeed', async () => {
  // connect takes 300 ms and the send deadline is 100 ms. The old design aborted the
  // connect every time; now requests never touch it.
  const script = scriptedKafka({ connectDelays: [300] });
  const pub = make(script, { connectTimeoutMs: 2000 });
  await assert.rejects(pub.publish(msg)); // still connecting: fast fail
  assert.equal(await until(() => pub.stats().connected), true, 'the connect must finish despite failed requests');
  assert.equal(script.state.connectAttempts, 1, 'requests must not restart the connect');
  assert.equal((await pub.publish(msg)).partition, 0);
  await pub.shutdown();
});

test('a request waits briefly for a connect that is about to finish, so a healthy boot loses nothing', async () => {
  const pub = make(scriptedKafka({ connectDelays: [20] }), { connectWaitMs: 500 });
  assert.equal((await pub.publish(msg)).partition, 0);
  await pub.shutdown();
});

test('Kafka down at boot, up later: the loop keeps retrying with fresh producers and then connects', async () => {
  const script = scriptedKafka({ connectDelays: ['fail', 'fail', 'fail', 0] });
  const pub = make(script);
  pub.start();
  assert.equal(await until(() => pub.stats().connected), true);
  assert.equal(script.state.connectAttempts, 4);
  assert.equal(script.state.built(), 4, 'one fresh producer per attempt, not one per request');
  assert.equal((await pub.publish(msg)).offset, '1');
  await pub.shutdown();
});

test('a hung connect is cut off by its own timeout and retried with a new producer', async () => {
  const script = scriptedKafka({ connectDelays: ['hang', 0] });
  const pub = make(script, { connectTimeoutMs: 80 });
  pub.start();
  assert.equal(await until(() => pub.stats().connected), true);
  assert.equal(script.state.connectAttempts, 2);
  await pub.shutdown();
});

test('requests during an outage do not churn producers', async () => {
  const script = scriptedKafka({ connectDelays: ['fail'] });
  const pub = make(script, { backoffInitialMs: 200, backoffMaxMs: 200 });
  pub.start();
  await Promise.all(Array.from({ length: 50 }, () => pub.publish(msg).catch(() => {})));
  assert.ok(script.state.built() <= 3, `built ${script.state.built()} producers for 50 requests`);
  await pub.shutdown();
});

test('three consecutive connection failures mark the producer disconnected, rebuild it and recover', async () => {
  let failing = true;
  const script = scriptedKafka({ send: () => { if (failing) throw connErr(); return [{ partition: 1, baseOffset: '5' }]; } });
  const pub = make(script);
  pub.start();
  assert.equal(await until(() => pub.stats().connected), true);
  const builtBefore = script.state.built();
  for (let i = 0; i < 3; i++) await assert.rejects(pub.publish(msg), (e) => e.category === 'unavailable');
  failing = false;
  assert.equal(await until(() => pub.stats().connected && script.state.built() > builtBefore), true, 'rebuilt and reconnected');
  assert.equal((await pub.publish(msg)).offset, '5');
  await pub.shutdown();
});

test('a successful send resets the failure count, so isolated failures never rebuild', async () => {
  let n = 0;
  const script = scriptedKafka({ send: () => { n += 1; if ([1, 2, 4, 5].includes(n)) throw connErr(); return [{ partition: 0, baseOffset: '1' }]; } });
  const pub = make(script);
  pub.start();
  await until(() => pub.stats().connected);
  const outcomes = [];
  for (let i = 0; i < 5; i++) outcomes.push(await pub.publish(msg).then(() => 'ok', () => 'fail'));
  assert.deepEqual(outcomes, ['fail', 'fail', 'ok', 'fail', 'fail']);
  assert.equal(script.state.built(), 1, 'never reached the threshold, so no rebuild');
  await pub.shutdown();
});

test('a hung send hits its deadline, frees the slot, and the next send works', async () => {
  let n = 0;
  const script = scriptedKafka({ send: () => (++n === 1 ? new Promise(() => {}) : [{ partition: 0, baseOffset: '2' }]) });
  const pub = make(script, { maxInFlight: 1 });
  pub.start();
  await until(() => pub.stats().connected);
  await assert.rejects(pub.publish(msg), (e) => e.category === 'timeout');
  assert.equal(pub.stats().inFlight, 0);
  assert.equal((await pub.publish(msg)).offset, '2');
  await pub.shutdown();
});

test('in-flight cap still fails immediately and never queues', async () => {
  const script = scriptedKafka({ send: () => new Promise(() => {}) });
  const pub = make(script, { maxInFlight: 2, sendTimeoutMs: 400 });
  pub.start();
  await until(() => pub.stats().connected);
  const held = [1, 2].map(() => pub.publish(msg).catch((e) => e));
  await sleep(10);
  await assert.rejects(pub.publish(msg), (e) => e.category === 'saturated');
  await Promise.all(held);
  await pub.shutdown();
});

test('shutdown stops the connect loop and rejects new publishes', async () => {
  const script = scriptedKafka({ connectDelays: ['fail'] });
  const pub = make(script);
  pub.start();
  await sleep(60);
  await pub.shutdown();
  const attempts = script.state.connectAttempts;
  await sleep(150);
  assert.equal(script.state.connectAttempts, attempts, 'no attempts after shutdown');
  await assert.rejects(pub.publish(msg), (e) => e.category === 'unavailable');
});
