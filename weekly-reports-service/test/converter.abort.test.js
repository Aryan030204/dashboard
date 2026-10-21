const test = require("node:test");
const assert = require("node:assert/strict");
const { run } = require("../src/services/converter");

// Uses a real child process: proves that an abort actually kills it instead of waiting for it.
test("run() kills a long-running process when the signal aborts, and reports ABORTED", async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(
    run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 60000, signal: controller.signal }),
    (err) => err.code === "ABORTED",
  );
  assert.ok(Date.now() - started < 5000, "returned promptly instead of waiting for the process");
});

test("run() refuses to start when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run(process.execPath, ["-e", "1"], { signal: controller.signal }), (err) => err.code === "ABORTED");
});

test("run() still reports a timeout as TIMEOUT, not as an abort", async () => {
  await assert.rejects(
    run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 150 }),
    (err) => err.code === "TIMEOUT",
  );
});
