const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("stream");
const { parseCsv } = require("../src/lib/csvStream");

const collect = async (it) => { const out = []; for await (const r of it) out.push(r); return out; };
const fromChunks = (chunks) => Readable.from(chunks.map((c) => Buffer.from(c)));

test("parses quoted fields with commas, escaped quotes and embedded newlines, CRLF, and a BOM", async () => {
  const text = '﻿Ref,Note\r\nA1,"hello, ""world"""\r\nA2,"line1\nline2"\r\n\r\nA3,plain\r\n';
  const rows = await collect(parseCsv(fromChunks([text]), { required: ["Ref", "Note"] }));
  assert.deepEqual(rows, [{ Ref: "A1", Note: 'hello, "world"' }, { Ref: "A2", Note: "line1\nline2" }, { Ref: "A3", Note: "plain" }]);
});

test("same result no matter where chunk boundaries fall (1 byte at a time, multi-byte characters included)", async () => {
  const text = 'Ref,Name\nA1,"Zoë, ""é"" 日本"\nA2,ok\n';
  const bytes = Buffer.from(text);
  const one = await collect(parseCsv(Readable.from([...bytes].map((b) => Buffer.from([b]))), { required: ["Ref", "Name"] }));
  const whole = await collect(parseCsv(fromChunks([text]), { required: ["Ref", "Name"] }));
  assert.deepEqual(one, whole);
  assert.equal(one[0].Name, 'Zoë, "é" 日本');
});

test("header match is case/space-insensitive and renamed to the caller's spelling; extra columns kept", async () => {
  const rows = await collect(parseCsv(fromChunks(["reference code ,CLIENT  LOCATION,Extra\nX,Y,Z"]), { required: ["Reference Code", "Client Location"] }));
  assert.deepEqual(rows, [{ "Reference Code": "X", "Client Location": "Y", Extra: "Z" }]);
});

test("missing required column fails before any row is produced", async () => {
  await assert.rejects(collect(parseCsv(fromChunks(["A,B\n1,2\n"]), { required: ["A", "Courier Name"] })),
    (e) => e.code === "CSV_MISSING_COLUMNS" && /Courier Name/.test(e.message));
});

test("ragged rows are padded, final row without newline is kept, empty file and unterminated quote are errors", async () => {
  const rows = await collect(parseCsv(fromChunks(["A,B,C\n1,2\n3,4,5"]), { required: ["A"] }));
  assert.deepEqual(rows, [{ A: "1", B: "2", C: "" }, { A: "3", B: "4", C: "5" }]);
  await assert.rejects(collect(parseCsv(fromChunks([""]))), (e) => e.code === "CSV_EMPTY");
  await assert.rejects(collect(parseCsv(fromChunks(['A\n"never closed\n']))), (e) => e.code === "CSV_UNTERMINATED_QUOTE");
});

test("memory is bounded by the row, not the file: rows are yielded while later chunks are still unread", async () => {
  let produced = 0;
  async function* source() {
    yield Buffer.from("A,B\n");
    for (let i = 0; i < 1000; i += 1) { produced += 1; yield Buffer.from(`${i},x\n`); }
  }
  let yieldedWhenFirstRow = null;
  for await (const _row of parseCsv(source(), { required: ["A"] })) {
    if (yieldedWhenFirstRow === null) yieldedWhenFirstRow = produced;
  }
  assert.ok(yieldedWhenFirstRow <= 2, `first row surfaced after ${yieldedWhenFirstRow} chunks`);
});

test("an oversized field (runaway quote) stops instead of growing without bound", async () => {
  await assert.rejects(collect(parseCsv(fromChunks(['A\n"', "x".repeat(500)]), { maxFieldChars: 100 })), (e) => e.code === "CSV_FIELD_TOO_LARGE");
});

test("aliases, punctuation-insensitive headers, column order and a banner above the header are tolerated", async () => {
  const rows = await collect(parseCsv(fromChunks(["Export 19 Nov\n\nExtra,Shipment(Pickup At),REFERENCE_CODE\nz,11/19/2026 17:17,A1\n"]), {
    required: ["Reference Code", "Shipment Picked At"],
    aliases: { "Shipment Picked At": ["Shipment Pickup At", "Pickup At"] },
  }));
  assert.deepEqual(rows, [{ Extra: "z", "Shipment Picked At": "11/19/2026 17:17", "Reference Code": "A1" }]);
});

test("the preferred header wins over an alias when both are present", async () => {
  const rows = await collect(parseCsv(fromChunks(["Courier Name,Courier\nA,B\n"]), { required: ["Courier"], aliases: { Courier: ["Courier Name"] } }));
  assert.equal(rows[0].Courier, "B");
});

test("project: only the required columns are materialized, quoting and ragged rows still parse", async () => {
  const rows = await collect(parseCsv(fromChunks(['A,Noise,C\n1,"x,""y""",3\n4,5\n']), { required: ["A", "C"], project: true }));
  assert.deepEqual(rows, [{ A: "1", C: "3" }, { A: "4", C: "" }]);
});

test("a delimiter, quote or line break split across chunks parses the same as one chunk", async () => {
  const text = 'A,B\r\n"q,1","a""b"\r\nplain,2\r\n';
  const whole = await collect(parseCsv(fromChunks([text]), { required: ["A"] }));
  for (let cut = 1; cut < text.length; cut += 1) {
    const split = await collect(parseCsv(fromChunks([text.slice(0, cut), text.slice(cut)]), { required: ["A"] }));
    assert.deepEqual(split, whole, `cut at ${cut}`);
  }
  assert.deepEqual(whole, [{ A: "q,1", B: 'a"b' }, { A: "plain", B: "2" }]);
});
