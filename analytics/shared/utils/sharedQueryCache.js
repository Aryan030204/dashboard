// A second level for the Intent / Heatmap query cache, shared by every analytics server through Redis.
//
// The in-process cache (createQueryCache in services/intentFunnelService.js) only helps the server that ran a query: with
// several servers behind the gateway, the same heavy scan of the same brand database runs once per server per cache
// lifetime. With this store switched on, a result computed by one server is found by the others.
//
//   INTENT_REDIS_CACHE=on   switch it on (default off)
//
// It can only ever make a request faster, never fail it:
//   - a Redis error, a slow Redis (more than COMMAND_TIMEOUT_MS) or an unreadable value is a cache miss, and Redis is
//     then left alone for FAILURE_PAUSE_MS so a sick Redis does not add a delay to every query;
//   - the key is a hash of the brand, the SQL text and its parameters (the same key the in-process cache uses), so a brand
//     can never see another brand's rows and a changed query never reads an older query's answer;
//   - an entry lives as long as the in-process one would (2 minutes, 10 for a range that has ended).

const crypto = require("crypto");

const KEY_PREFIX = "intent:q:v1:";
const COMMAND_TIMEOUT_MS = 150;
const FAILURE_PAUSE_MS = 30 * 1000;
const MAX_VALUE_BYTES = 2 * 1024 * 1024;

function sharedCacheEnabled(env = process.env) {
  return String(env.INTENT_REDIS_CACHE || "off").trim().toLowerCase() === "on";
}

function redisKey(key) {
  return KEY_PREFIX + crypto.createHash("sha1").update(String(key)).digest("hex");
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("redis cache timeout")), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// `getClient` returns an ioredis-like client ({ get, set }) or null. It is called on every use, so the real client is only
// required once the cache is actually switched on.
function createSharedStore({ getClient, now = Date.now, timeoutMs = COMMAND_TIMEOUT_MS, pauseMs = FAILURE_PAUSE_MS, onError } = {}) {
  let pausedUntil = 0;

  const fail = (err) => {
    pausedUntil = now() + pauseMs;
    onError?.(err);
  };
  const usable = () => {
    if (now() < pausedUntil) return null;
    try {
      return getClient() || null;
    } catch (err) {
      fail(err);
      return null;
    }
  };

  return {
    // { value } for a hit, undefined for a miss (a cached `null` is still a hit)
    async get(key) {
      const client = usable();
      if (!client) return undefined;
      try {
        const raw = await withTimeout(Promise.resolve(client.get(redisKey(key))), timeoutMs);
        if (raw == null) return undefined;
        const parsed = JSON.parse(raw);
        return parsed && Object.prototype.hasOwnProperty.call(parsed, "v") ? { value: parsed.v } : undefined;
      } catch (err) {
        fail(err);
        return undefined;
      }
    },

    // fire and forget: the caller never waits for it and never sees its failure
    set(key, value, ttlMs) {
      const client = usable();
      if (!client) return;
      let payload;
      try {
        payload = JSON.stringify({ v: value });
      } catch {
        return; // not JSON-serialisable (for example a BigInt): simply not shared
      }
      if (payload.length > MAX_VALUE_BYTES) return;
      Promise.resolve()
        .then(() => withTimeout(Promise.resolve(client.set(redisKey(key), payload, "PX", Math.max(1000, Math.floor(ttlMs)))), timeoutMs))
        .catch(fail);
    },
  };
}

let defaultStore;
// The store the default query cache uses: null unless INTENT_REDIS_CACHE=on.
function defaultSharedStore(env = process.env) {
  if (!sharedCacheEnabled(env)) return null;
  if (!defaultStore) {
    defaultStore = createSharedStore({
      getClient: () => require("../db/redis"),
      onError: (err) => {
        try {
          require("./logger").warn(`[intent-cache] redis cache paused for ${FAILURE_PAUSE_MS / 1000}s: ${err?.message}`);
        } catch {
          // logging must never matter here
        }
      },
    });
  }
  return defaultStore;
}

module.exports = { createSharedStore, defaultSharedStore, sharedCacheEnabled, redisKey, KEY_PREFIX, COMMAND_TIMEOUT_MS, FAILURE_PAUSE_MS };
