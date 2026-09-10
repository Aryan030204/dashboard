/* eslint-env jest */

const {
  extractDiscountCodes,
  extractFilters,
  MAX_DISCOUNT_CODES,
} = require("../../../shared/utils/filters");

describe("extractDiscountCodes", () => {
  test("returns null when nothing is provided", () => {
    expect(extractDiscountCodes(undefined)).toBeNull();
    expect(extractDiscountCodes("")).toBeNull();
    expect(extractDiscountCodes([])).toBeNull();
  });

  test("normalizes a single code to a one-element array", () => {
    expect(extractDiscountCodes("SAVE10")).toEqual(["SAVE10"]);
    expect(extractDiscountCodes("  SAVE10 ")).toEqual(["SAVE10"]);
  });

  test("accepts repeated query params and comma-separated strings", () => {
    expect(extractDiscountCodes(["A", "B", "C"])).toEqual(["A", "B", "C"]);
    expect(extractDiscountCodes("A, B ,C")).toEqual(["A", "B", "C"]);
  });

  test("de-dupes and caps at MAX_DISCOUNT_CODES", () => {
    expect(MAX_DISCOUNT_CODES).toBe(3);
    expect(extractDiscountCodes(["A", "A", "B"])).toEqual(["A", "B"]);
    expect(extractDiscountCodes(["A", "B", "C", "D", "E"])).toEqual([
      "A",
      "B",
      "C",
    ]);
  });
});

describe("extractFilters discount_code", () => {
  const baseReq = (query) => ({ query, user: { isAuthor: true } });

  test("maps a single discount code", () => {
    expect(extractFilters(baseReq({ discount_code: "SAVE10" })).discount_code).toEqual([
      "SAVE10",
    ]);
  });

  test("maps multiple discount codes capped at 3", () => {
    expect(
      extractFilters(baseReq({ discount_code: ["A", "B", "C", "D"] })).discount_code,
    ).toEqual(["A", "B", "C"]);
  });

  test("is null when absent", () => {
    expect(extractFilters(baseReq({})).discount_code).toBeNull();
  });
});
