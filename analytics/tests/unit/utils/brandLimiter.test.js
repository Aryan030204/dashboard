/* eslint-env jest */

const { runLimited, limitFromEnv, snapshot, DEFAULT_LIMIT } = require("../../../shared/utils/brandLimiter");

// A task that stays "running" until released, so concurrency can be observed.
function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("brandLimiter", () => {
  test("at most the limit run at once for a brand; the rest start as slots free up, in order", async () => {
    const gates = [gate(), gate(), gate(), gate()];
    const started = [];
    const tasks = gates.map((g, i) =>
      runLimited(
        "BBB",
        async () => {
          started.push(i);
          await g.promise;
          return i;
        },
        2,
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1]);
    expect(snapshot()).toEqual([{ brandKey: "BBB", active: 2, waiting: 2 }]);

    gates[0].release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1, 2]);

    gates[1].release();
    gates[2].release();
    gates[3].release();
    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3]);
    expect(snapshot()).toEqual([]);
  });

  test("brands do not wait for each other", async () => {
    const g = gate();
    const slow = runLimited("A", () => g.promise, 1);
    await expect(runLimited("B", async () => "done", 1)).resolves.toBe("done");
    g.release();
    await slow;
  });

  test("a failing task frees its slot and its error reaches the caller", async () => {
    await expect(runLimited("BBB", async () => { throw new Error("boom"); }, 1)).rejects.toThrow("boom");
    await expect(runLimited("BBB", async () => "ok", 1)).resolves.toBe("ok");
    expect(snapshot()).toEqual([]);
  });

  test("no brand key runs straight away without a limit", async () => {
    const gates = [gate(), gate(), gate()];
    let running = 0;
    const tasks = gates.map((g) =>
      runLimited(null, async () => {
        running += 1;
        await g.promise;
      }, 1),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(running).toBe(3);
    gates.forEach((g) => g.release());
    await Promise.all(tasks);
  });

  test("the limit comes from INTENT_QUERY_CONCURRENCY, default 4, never below 1", () => {
    expect(limitFromEnv({})).toBe(DEFAULT_LIMIT);
    expect(limitFromEnv({ INTENT_QUERY_CONCURRENCY: "6" })).toBe(6);
    expect(limitFromEnv({ INTENT_QUERY_CONCURRENCY: "0" })).toBe(DEFAULT_LIMIT);
    expect(limitFromEnv({ INTENT_QUERY_CONCURRENCY: "abc" })).toBe(DEFAULT_LIMIT);
  });
});
