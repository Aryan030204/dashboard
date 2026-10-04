// Per-actor async lock. Serializes the read-decide-write-close cycle for one
// `brand|actor_id` so two near-simultaneous events for the same actor cannot
// interleave and clobber each other's cursor update.
//
// In-process only: correct for a single alerts-service instance (confirmed for
// the current docker-compose deployment). Horizontal scaling needs a
// distributed lock instead.
const actorLocks = new Map(); // key -> tail promise (never rejects)

function withActorLock(key, fn) {
  const prevTail = actorLocks.get(key) || Promise.resolve();
  const result = prevTail.then(fn);
  const tail = result.then(
    () => {},
    () => {},
  );
  actorLocks.set(key, tail);
  tail.finally(() => {
    if (actorLocks.get(key) === tail) actorLocks.delete(key);
  });
  return result;
}

module.exports = { withActorLock, _actorLocks: actorLocks };
