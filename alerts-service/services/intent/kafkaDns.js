const dns = require("dns");
const net = require("net");

// Hostname lookup for Kafka sockets that does not use libuv's 4-thread pool.
//
// dns.lookup (what net.connect uses by default) runs getaddrinfo on that shared pool. If
// something else in the process keeps those threads busy, the lookup of the broker host
// waits in the queue and the connect times out, even though Kafka is healthy. The c-ares
// resolver (dns.Resolver) does its queries on the event loop and has no such limit. If it
// cannot answer (for example /etc/hosts names such as localhost), we fall back to
// dns.lookup.
function createLookup({ resolver = new dns.Resolver(), fallback = dns.lookup, timeoutMs = 2000 } = {}) {
  return function lookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const wantAll = Boolean(options?.all);
    const reply = (addresses) => {
      if (wantAll) return callback(null, addresses.map((address) => ({ address, family: 4 })));
      return callback(null, addresses[0], 4);
    };

    if (net.isIP(hostname)) return fallback(hostname, options, callback);

    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => fallback(hostname, options, callback)), timeoutMs);
    timer.unref?.();

    resolver.resolve4(hostname, (err, addresses) => {
      if (err || !addresses?.length) return finish(() => fallback(hostname, options, callback));
      finish(() => reply(addresses));
    });
  };
}

// kafkajs socketFactory: a plain TCP socket whose hostname lookup uses the function above.
function createSocketFactory(lookup = createLookup()) {
  return ({ host, port, onConnect }) => net.connect({ host, port, lookup }, onConnect);
}

module.exports = { createLookup, createSocketFactory };
