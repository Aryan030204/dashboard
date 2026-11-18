const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReportsRepo } = require("../src/services/reportsRepo");

// A pool whose only job is to hand back the rows the repo asks for.
function fakePool({ claimRow = null, columnType = null } = {}) {
  const conn = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    query: async (sql) => {
      if (/FROM weekly_reports\s+WHERE status = 'PROCESSING'/.test(sql)) return [claimRow ? [claimRow] : []];
      return [[], undefined];
    },
  };
  return {
    getConnection: async () => conn,
    query: async (sql) => {
      if (/SHOW COLUMNS/.test(sql)) return [columnType ? [{ Type: columnType }] : []];
      return [[], undefined];
    },
  };
}

function memoryLogger() {
  const lines = [];
  const push = (level) => (message, fields) => lines.push({ level, message, fields });
  return { lines, logger: { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") } };
}

const claim = (sourceType, key) => ({ id: 28, brand_key: "AJMAL", source_storage_key: key, source_type: sourceType });

test("a PDF stored with an empty type (migration 004 missing) is still handed to the worker as a pdf", async () => {
  const { lines, logger } = memoryLogger();
  const repo = buildReportsRepo(fakePool({ claimRow: claim("", "AJMAL/28/source/presentation.pdf") }), { logger });
  const job = await repo.claimNext("w1");
  assert.equal(job.sourceType, "pdf");
  const warn = lines.find((l) => l.level === "warn");
  assert.ok(warn && /migration 004/.test(warn.message), "the missing migration is called out");
});

test("a type that is stored is used as it is, with no warning", async () => {
  for (const [type, key] of [["pptx", "B/1/source/presentation.pptx"], ["ppt", "B/2/source/presentation.ppt"], ["pdf", "B/3/source/presentation.pdf"]]) {
    const { lines, logger } = memoryLogger();
    const job = await buildReportsRepo(fakePool({ claimRow: claim(type, key) }), { logger }).claimNext("w1");
    assert.equal(job.sourceType, type);
    assert.equal(lines.filter((l) => l.level === "warn").length, 0);
  }
});

test("an empty type with an unknown file name stays empty rather than guessing", async () => {
  const job = await buildReportsRepo(fakePool({ claimRow: claim("", "B/1/source/presentation.xyz") })).claimNext("w1");
  assert.equal(job.sourceType, "");
});

test("the schema check reports a database that does not accept pdf, and one that does", async () => {
  const old = memoryLogger();
  const missing = await buildReportsRepo(fakePool({ columnType: "enum('pptx','ppt')" }), { logger: old.logger }).checkSchema();
  assert.equal(missing.ok, false);
  assert.ok(old.lines.some((l) => l.level === "error" && /004-allow-pdf-source/.test(l.message)));

  const fresh = memoryLogger();
  const ok = await buildReportsRepo(fakePool({ columnType: "enum('pptx','ppt','pdf')" }), { logger: fresh.logger }).checkSchema();
  assert.equal(ok.ok, true);
  assert.ok(!fresh.lines.some((l) => l.level === "error"));
});

test("the schema check never throws when the database cannot be read", async () => {
  const { lines, logger } = memoryLogger();
  const pool = { getConnection: async () => {}, query: async () => { throw new Error("connection refused"); } };
  const result = await buildReportsRepo(pool, { logger }).checkSchema();
  assert.equal(result.ok, false);
  assert.ok(lines.some((l) => l.level === "error" && /could not run/.test(l.message)));
});
