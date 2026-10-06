const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter } = require('node:events');

const { createLookup, createSocketFactory } = require('../services/intent/kafkaDns');
const { createHealthMonitorReporter } = require('../healthMonitor');

// --- Kafka hostname lookup that bypasses the getaddrinfo thread pool ---
const callLookup = (lookup, host, opts) => new Promise((resolve, reject) => {
  const cb = (err, a, f) => (err ? reject(err) : resolve({ a, f }));
  opts === undefined ? lookup(host, cb) : lookup(host, opts, cb);
});

test('lookup uses the c-ares resolver and never the getaddrinfo fallback when it answers', async () => {
  let fallbackCalls = 0;
  const lookup = createLookup({
    resolver: { resolve4: (h, cb) => cb(null, ['172.22.0.13']) },
    fallback: () => { fallbackCalls += 1; },
  });
  assert.deepEqual(await callLookup(lookup, 'kafka-service', {}), { a: '172.22.0.13', f: 4 });
  assert.deepEqual(await callLookup(lookup, 'kafka-service', { all: true }), { a: [{ address: '172.22.0.13', family: 4 }], f: undefined });
  assert.equal(fallbackCalls, 0);
});

test('lookup falls back to dns.lookup when the resolver errors (e.g. localhost, /etc/hosts names)', async () => {
  const lookup = createLookup({
    resolver: { resolve4: (h, cb) => cb(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })) },
    fallback: (h, o, cb) => cb(null, '127.0.0.1', 4),
  });
  assert.deepEqual(await callLookup(lookup, 'localhost', {}), { a: '127.0.0.1', f: 4 });
});

test('lookup falls back when the resolver does not answer in time', async () => {
  const lookup = createLookup({
    resolver: { resolve4: () => {} }, // never calls back
    fallback: (h, o, cb) => cb(null, '10.0.0.9', 4),
    timeoutMs: 30,
  });
  assert.deepEqual(await callLookup(lookup, 'kafka-service', {}), { a: '10.0.0.9', f: 4 });
});

test('IP addresses skip the resolver entirely', async () => {
  let resolverCalls = 0;
  const lookup = createLookup({
    resolver: { resolve4: () => { resolverCalls += 1; } },
    fallback: (h, o, cb) => cb(null, h, 4),
  });
  assert.equal((await callLookup(lookup, '10.1.2.3', {})).a, '10.1.2.3');
  assert.equal(resolverCalls, 0);
});

test('the socket factory connects through the custom lookup', async () => {
  const server = net.createServer((s) => s.end('hi'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const seen = [];
  const lookup = createLookup({
    resolver: { resolve4: (h, cb) => { seen.push(h); cb(null, ['127.0.0.1']); } },
  });
  try {
    const socket = createSocketFactory(lookup)({ host: 'kafka-service', port: server.address().port, onConnect: () => {} });
    const data = await new Promise((resolve, reject) => { socket.once('data', (d) => resolve(String(d))); socket.once('error', reject); });
    assert.equal(data, 'hi');
    assert.deepEqual(seen, ['kafka-service']);
    socket.destroy();
  } finally { server.close(); }
});

// --- health monitor must not turn a burst of failures into a burst of outbound calls ---
function fakeReqRes(status) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.json = (b) => b;
  res.send = (b) => b;
  res.getHeaders = () => ({});
  const req = { method: 'POST', path: '/track', route: { path: '/track' }, baseUrl: '', headers: {}, query: {}, params: {}, body: {} };
  return { req, res };
}

test('a burst of 503s sends one failure event per route and status, not one per request', async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = (url) => { calls.push(url); return new Promise(() => {}); }; // never settles
  try {
    const reporter = createHealthMonitorReporter({ serviceName: 'alerts-service', baseUrl: 'http://x', logger: { info() {}, warn() {}, error() {} } });
    for (let i = 0; i < 200; i++) {
      const { req, res } = fakeReqRes(503);
      reporter(req, res, () => {});
      res.emit('finish');
    }
    assert.equal(calls.length, 1);
    const other = fakeReqRes(500); // a different status is a different failure
    reporter(other.req, other.res, () => {});
    other.res.emit('finish');
    assert.equal(calls.length, 2);
  } finally { global.fetch = realFetch; }
});
