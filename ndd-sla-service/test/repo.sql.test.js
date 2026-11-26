// Checks the SQL the repo ISSUES (shape, fencing, parameters, transactions) with a scripted fake pool. It does not
// prove the SQL runs on MySQL: that is repo.mysql.test.js, which needs a real MySQL 8 and is skipped otherwise.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRepo } = require("../src/services/repo");

function fakePool(script = () => [[]]) {
  const log = [];
  const run = async (sql, args) => {
    log.push({ sql: sql.replace(/\s+/g, " ").trim(), args });
    return script(sql, args);
  };
  const conn = { query: run, beginTransaction: async () => log.push({ tx: "begin" }), commit: async () => log.push({ tx: "commit" }),
    rollback: async () => log.push({ tx: "rollback" }), release: () => {} };
  return { log, query: run, getConnection: async () => conn };
}
const sqls = (p) => p.log.filter((l) => l.sql).map((l) => l.sql);

test("insertOrders: ONE multi-row INSERT per batch, NULL (not a date) for a missing pickup, run/generation on every row", async () => {
  const pool = fakePool();
  const repo = buildRepo(pool);
  const n = await repo.insertOrders(7, 3, [
    { reference: "A", location: "AJMAL_SONS", orderAt: "2026-11-19 10:00:00", orderDate: "2026-11-19", orderHour: 10, courier: "BlitzNDD", isNdd: true, pickedAt: null, sla: "BREACHED" },
    { reference: "B", location: "EMIZA_GGN", orderAt: "2026-11-19 11:00:00", orderDate: "2026-11-19", orderHour: 11, courier: "Delhivery", isNdd: false, pickedAt: "2026-11-19 12:00:00", sla: "MET" },
  ]);
  assert.equal(n, 2);
  assert.equal(pool.log.length, 1);
  const [{ sql, args }] = pool.log;
  assert.match(sql, /^INSERT INTO ndd_sla_orders \(.*shipment_picked_at, sla_status, marketplace\) VALUES \?$/);
  const [values] = args;
  assert.equal(values.length, 2);
  assert.deepEqual(values[0], [7, 3, "A", "AJMAL_SONS", "2026-11-19 10:00:00", "2026-11-19", 10, "BlitzNDD", 1, null, "BREACHED", null]);
  assert.equal(values[1][9], "2026-11-19 12:00:00");
  assert.equal(await repo.insertOrders(7, 3, []), 0);
  assert.equal(pool.log.length, 1, "an empty batch issues no SQL");
});

test("claimNext: SKIP LOCKED, brand-scoped, never terminal runs, stamps the lock in the same transaction", async () => {
  const pool = fakePool((sql) => (/^SELECT \* FROM ndd_sla_runs/.test(sql.trim()) ? [[{ id: "5", status: "WAITING_FOR_GOKWIK", report_date: "2026-11-19" }]] : [{}]));
  const run = await buildRepo(pool).claimNext("AJMAL", "w1");
  const [select, update] = sqls(pool);
  assert.match(select, /brand_key = \? .*locked_at IS NULL .*control = 'NONE' .*status NOT IN \('COMPLETED','GOKWIK_TIMEOUT','CANCELLED'\).*next_attempt_at <= UTC_TIMESTAMP\(\).*FOR UPDATE SKIP LOCKED/);
  assert.match(update, /SET locked_at = UTC_TIMESTAMP\(\), locked_by = \?/);
  assert.deepEqual([run.id, run.locked_by], [5, "w1"]);
  assert.deepEqual(pool.log.filter((l) => l.tx).map((l) => l.tx), ["begin", "commit"]);
});

test("every worker write is fenced on locked_by; a write that no longer owns the run throws LOCK_LOST", async () => {
  const owned = buildRepo(fakePool((sql) => (/^SELECT status/.test(sql) ? [[{ status: "PROCESSING" }]] : [{ affectedRows: 1 }])));
  await owned.transition(1, "w1", "EASYCOM_FETCHING", { rows_in: 5 });
  const pool = fakePool((sql) => (/^SELECT status/.test(sql) ? [[]] : [{ affectedRows: 0 }]));
  const lostRepo = buildRepo(pool);
  for (const call of [
    () => lostRepo.transition(1, "w1", "PROCESSING"),
    () => lostRepo.heartbeat(1, "w1"),
    () => lostRepo.update(1, "w1", { rows_in: 1 }),
    () => lostRepo.activate(1, "w1", 2, {}),
    () => lostRepo.failAttempt(1, "w1", { status: "EASYCOM_FAILED", code: "X", detail: "", delayMs: 1000 }),
    () => lostRepo.scheduleWait(1, "w1", 1000),
    () => lostRepo.beginGeneration(1, "w1"),
  ]) await assert.rejects(call(), (e) => e.code === "LOCK_LOST");
  assert.ok(sqls(pool).filter((s) => /^UPDATE/.test(s)).every((s) => /locked_by = \?/.test(s)));
  assert.ok(pool.log.some((l) => l.tx === "rollback"), "failed transactions roll back");
});

test("transition writes the status change and its audit event in ONE transaction", async () => {
  const pool = fakePool((sql) => (/^SELECT status/.test(sql) ? [[{ status: "WAITING_FOR_GOKWIK" }]] : [{ affectedRows: 1 }]));
  await buildRepo(pool).transition(9, "w1", "GOKWIK_RECEIVED", { gmail_ms: 12 }, { messageId: "m" });
  const kinds = pool.log.map((l) => l.tx || l.sql.split(" ").slice(0, 3).join(" "));
  assert.deepEqual(kinds, ["begin", "SELECT status FROM", "UPDATE ndd_sla_runs SET", "INSERT INTO ndd_sla_events", "commit"]);
  const event = pool.log.find((l) => /ndd_sla_events/.test(l.sql || ""));
  assert.deepEqual(event.args.slice(0, 4), [9, "WAITING_FOR_GOKWIK", "GOKWIK_RECEIVED", "w1"]);
});

test("activate: sets active_generation and deletes every OTHER generation in the same transaction", async () => {
  const pool = fakePool((sql) => (/^SELECT status/.test(sql) ? [[{ status: "PROCESSING" }]] : /^SELECT active_generation/.test(sql) ? [[{ active_generation: 2 }]] : [{ affectedRows: 1 }]));
  await buildRepo(pool).activate(4, "w1", 3, { sla_met: 10, sla_breached: 2 });
  const all = sqls(pool);
  assert.match(all[2], /status = 'COMPLETED', active_generation = \?, sla_met = \?, sla_breached = \?.*generation = \?$/);
  const del = pool.log.filter((l) => /^DELETE/.test(l.sql || ""));
  assert.equal(del.length, 2);
  assert.ok(del.every((d) => /run_id = \? AND generation NOT IN \(\?, \?\)/.test(d.sql) && d.args.join() === "4,3,2"), "keeps the new generation and ONE previous one");
  assert.deepEqual(pool.log.filter((l) => l.tx).map((l) => l.tx), ["begin", "commit"]);
});

test("beginGeneration: next number is above any earlier attempt, unfinished generations are removed first", async () => {
  const pool = fakePool((sql) => (/^SELECT status/.test(sql) ? [[{ status: "PROCESSING" }]] : /^SELECT generation/.test(sql) ? [[{ generation: 4, active_generation: 2 }]] : [{}]));
  const gen = await buildRepo(pool).beginGeneration(1, "w1");
  assert.equal(gen, 5);
  const del = pool.log.find((l) => /DELETE FROM ndd_sla_orders/.test(l.sql || ""));
  assert.match(del.sql, /generation > \?/);
  assert.deepEqual(del.args, [1, 2], "removes only unfinished attempts above the active generation");
});

test("failAttempt: delay => next_attempt_at in the future; null => NULL (final)", async () => {
  const mk = () => fakePool((sql) => (/^SELECT status/.test(sql) ? [[{ status: "EASYCOM_FETCHING" }]] : [{ affectedRows: 1 }]));
  const retry = mk();
  await buildRepo(retry).failAttempt(1, "w", { status: "EASYCOM_FAILED", code: "C", detail: "d", delayMs: 90000 });
  assert.match(sqls(retry)[1], /attempts = attempts \+ 1, next_attempt_at = \(UTC_TIMESTAMP\(\) \+ INTERVAL \? SECOND\)/);
  assert.equal(retry.log[2].args[3], 90);
  const final = mk();
  await buildRepo(final).failAttempt(1, "w", { status: "EASYCOM_FAILED", code: "C", detail: "d", delayMs: null });
  assert.match(sqls(final)[1], /next_attempt_at = NULL/);
});

test("update: column names are whitelisted (no SQL from keys) and a duplicate Gmail message maps to a permanent error", async () => {
  const repo = buildRepo(fakePool());
  await assert.rejects(repo.update(1, "w", { "status = 'COMPLETED', x": 1 }), /not updatable/);
  const dup = buildRepo(fakePool(() => { const e = new Error("dup"); e.code = "ER_DUP_ENTRY"; throw e; }));
  await assert.rejects(dup.update(1, "w", { gmail_message_id: "m" }), (e) => e.code === "GMAIL_MESSAGE_ALREADY_USED" && e.retryable === false);
});

test("reads are brand-scoped and use keyset pagination on (order_at, reference_code)", async () => {
  const pool = fakePool();
  const repo = buildRepo(pool);
  await repo.listRuns("AJMAL", { from: "2026-11-01", limit: 5 });
  await repo.getRun("AJMAL", "2026-11-19");
  await repo.listOrders(1, 2, { location: "EMIZA_GGN", sla: "BREACHED", limit: 50, after: { orderAt: "2026-11-19 10:00:00", reference: "R5" } });
  const [list, get, orders] = pool.log;
  assert.match(list.sql, /WHERE brand_key = \? AND report_date >= \?/);
  assert.match(get.sql, /WHERE brand_key = \? AND report_date = \?/);
  assert.match(orders.sql, /run_id = \? AND generation = \? AND client_location = \? AND sla_status = \? AND \(order_at > \? OR \(order_at = \? AND reference_code > \?\)\) ORDER BY order_at, reference_code LIMIT \?/);
  assert.equal(orders.args.at(-1), 51, "fetches limit+1 to know whether another page exists");
});
