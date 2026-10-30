/* eslint-env jest */

const { parseArgs, diff } = require("../../../scripts/intent-queries-parity.cjs");

describe("intent-queries-parity script helpers", () => {
  test("parses the brand and range and validates them", () => {
    expect(parseArgs(["--brand", "bbb", "--from", "2026-10-01", "--to", "2026-10-20", "--path", "/x"])).toMatchObject({
      brand: "BBB", from: "2026-10-01", to: "2026-10-20", path: "/x",
    });
    expect(() => parseArgs(["--from", "2026-10-01", "--to", "2026-10-02"])).toThrow("--brand");
    expect(() => parseArgs(["--brand", "BBB", "--from", "x", "--to", "2026-10-02"])).toThrow("dates");
    expect(() => parseArgs(["--brand", "BBB", "--from", "2026-10-05", "--to", "2026-10-02"])).toThrow("before");
    expect(() => parseArgs(["--brand", "BBB", "--bogus", "1"])).toThrow("Unknown option");
  });

  test("diff lists every differing value by path and ignores float noise", () => {
    expect(diff({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } })).toEqual([]);
    expect(diff({ a: 0.1 + 0.2 }, { a: 0.3 })).toEqual([]);
    expect(diff({ a: 1, b: { c: [1, 2] } }, { a: 2, b: { c: [1, 3] } })).toEqual([
      "root.a: 1 != 2",
      "root.b.c.1: 2 != 3",
    ]);
    expect(diff({ a: 1 }, { b: 1 })).toEqual(["root.a: 1 != undefined", "root.b: undefined != 1"]);
  });
});
