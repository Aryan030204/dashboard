/* eslint-env jest */

jest.mock("../../../shared/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const {
  createSharedStore,
  defaultSharedStore,
  sharedCacheEnabled,
  redisKey,
  KEY_PREFIX,
} = require("../../../shared/utils/sharedQueryCache");
const { createQueryCache } = require("../../../services/intentFunnelService");

// A tiny in-memory stand-in for an ioredis client.
function fakeRedis() {
  const data = new Map();
  return {
    data,
    get: jest.fn(async (key) => (data.has(key) ? data.get(key) : null)),
    set: jest.fn(async (key, value) => {
      data.set(key, value);
      return "OK";
    }),
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("shared store", () => {
  test("stores and reads back a JSON result; a miss is undefined and a cached null is still a hit", async () => {
    const client = fakeRedis();
    const store = createSharedStore({ getClient: () => client });

    expect(await store.get("k")).toBeUndefined();
    store.set("k", { rows: [1, 2] }, 5000);
    await tick();
    expect(await store.get("k")).toEqual({ value: { rows: [1, 2] } });

    store.set("n", null, 5000);
    await tick();
    expect(await store.get("n")).toEqual({ value: null });
  });

  test("the Redis key is a hash with a version prefix, never the SQL or the brand", () => {
    const key = redisKey("BBB|SELECT 1|[]");
    expect(key.startsWith(KEY_PREFIX)).toBe(true);
    expect(key).not.toContain("BBB");
    expect(key).not.toContain("SELECT");
    expect(redisKey("a")).not.toBe(redisKey("b"));
  });

  test("the entry carries the lifetime in milliseconds (at least a second)", async () => {
    const client = fakeRedis();
    const store = createSharedStore({ getClient: () => client });
    store.set("k", 1, 600000);
    store.set("short", 1, 10);
    await tick();
    expect(client.set.mock.calls[0].slice(2)).toEqual(["PX", 600000]);
    expect(client.set.mock.calls[1].slice(2)).toEqual(["PX", 1000]);
  });

  test("a Redis error is a miss, pauses Redis for a while, and is never thrown", async () => {
    let clock = 0;
    const client = { get: jest.fn(async () => { throw new Error("down"); }), set: jest.fn() };
    const onError = jest.fn();
    const store = createSharedStore({ getClient: () => client, now: () => clock, pauseMs: 30000, onError });

    expect(await store.get("k")).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);

    expect(await store.get("k")).toBeUndefined(); // paused: Redis is not asked
    store.set("k", 1, 1000);
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.set).not.toHaveBeenCalled();

    clock = 31000; // pause over: asked again
    await store.get("k");
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  test("a slow Redis counts as a failure instead of slowing the query", async () => {
    const client = { get: jest.fn(() => new Promise(() => {})), set: jest.fn() };
    const store = createSharedStore({ getClient: () => client, timeoutMs: 20 });
    const started = Date.now();
    expect(await store.get("k")).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("no client, an unreadable value, or a value that cannot be stored are all just misses", async () => {
    expect(await createSharedStore({ getClient: () => null }).get("k")).toBeUndefined();

    const broken = { get: jest.fn(async () => "{not json"), set: jest.fn() };
    expect(await createSharedStore({ getClient: () => broken }).get("k")).toBeUndefined();

    const client = fakeRedis();
    const store = createSharedStore({ getClient: () => client });
    store.set("big", { n: BigInt(1) }, 1000); // JSON cannot hold a BigInt
    await tick();
    expect(client.set).not.toHaveBeenCalled();
  });

  test("it is off unless INTENT_REDIS_CACHE=on", () => {
    expect(sharedCacheEnabled({})).toBe(false);
    expect(sharedCacheEnabled({ INTENT_REDIS_CACHE: "on" })).toBe(true);
    expect(sharedCacheEnabled({ INTENT_REDIS_CACHE: "off" })).toBe(false);
    expect(defaultSharedStore({})).toBeNull();
  });
});

describe("query cache with a shared level", () => {
  test("a result computed by one cache is found by another through the shared store, without running the loader", async () => {
    const client = fakeRedis();
    const shared = createSharedStore({ getClient: () => client });
    const first = createQueryCache({ shared });
    const second = createQueryCache({ shared }); // another server: its own empty memory

    const loaderA = jest.fn(async () => ({ rows: [1] }));
    const loaderB = jest.fn(async () => ({ rows: [2] }));
    expect(await first("BBB|sql|[]", loaderA)).toEqual({ rows: [1] });
    await tick();
    expect(await second("BBB|sql|[]", loaderB)).toEqual({ rows: [1] });
    expect(loaderB).not.toHaveBeenCalled();
  });

  test("brands never share an entry (the brand is part of the key)", async () => {
    const client = fakeRedis();
    const shared = createSharedStore({ getClient: () => client });
    const cache = createQueryCache({ shared });
    await cache("BBB|sql|[]", async () => "bbb");
    await tick();
    expect(await createQueryCache({ shared })("OTHER|sql|[]", async () => "other")).toBe("other");
  });

  test("a failing loader is not cached anywhere", async () => {
    const client = fakeRedis();
    const shared = createSharedStore({ getClient: () => client });
    const cache = createQueryCache({ shared });
    await expect(cache("k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await tick();
    expect(client.set).not.toHaveBeenCalled();
    expect(await cache("k", async () => "ok")).toBe("ok");
  });

  test("a broken Redis never fails a query", async () => {
    const client = { get: jest.fn(async () => { throw new Error("down"); }), set: jest.fn(async () => { throw new Error("down"); }) };
    const cache = createQueryCache({ shared: createSharedStore({ getClient: () => client }) });
    expect(await cache("k", async () => "value")).toBe("value");
  });

  test("the shared entry lives as long as the call asks for", async () => {
    const client = fakeRedis();
    const cache = createQueryCache({ shared: createSharedStore({ getClient: () => client }), ttlMs: 120000 });
    await cache("a", async () => 1);
    await cache("b", async () => 2, { ttlMs: 600000 });
    await tick();
    expect(client.set.mock.calls[0][3]).toBe(120000);
    expect(client.set.mock.calls[1][3]).toBe(600000);
  });

  test("without a shared store nothing changes", async () => {
    const loader = jest.fn(async () => "v");
    const cache = createQueryCache({ shared: null });
    await cache("k", loader);
    await cache("k", loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
