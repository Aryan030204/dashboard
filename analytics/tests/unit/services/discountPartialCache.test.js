/* eslint-env jest */

const {
  queryDiscountAggregateRows,
  queryDiscountAggregateTotals,
} = require("../../../services/metricsAggregateService");
const { _resetForTests } = require("../../../services/discountPartialCache");

// A mock brand connection whose `dbName` enables the per-code cache path.
function makeConn(rowsByCode) {
  return {
    dbName: "brand_test_db",
    query: jest.fn((sql, { replacements }) => {
      const code = replacements[replacements.length - 1];
      return Promise.resolve(rowsByCode[code] || []);
    }),
  };
}

beforeEach(() => _resetForTests());

describe("discount per-code caching", () => {
  test("adding a code only queries the DB for the new code", async () => {
    const conn = makeConn({
      SAVE10: [{ date: "2026-03-01", sales: 100, orders: 2 }],
      SAVE20: [{ date: "2026-03-01", sales: 40, orders: 1 }],
    });

    const one = await queryDiscountAggregateRows(conn, "2026-03-01", "2026-03-01", {
      discount_code: ["SAVE10"],
    });
    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(one).toEqual([
      { date: "2026-03-01", sales: 100, orders: 2, sessions: 0, atc: 0 },
    ]);

    const two = await queryDiscountAggregateRows(conn, "2026-03-01", "2026-03-01", {
      discount_code: ["SAVE10", "SAVE20"],
    });
    // Only SAVE20 hit the DB; SAVE10 came from cache.
    expect(conn.query).toHaveBeenCalledTimes(2);
    expect(two).toEqual([
      { date: "2026-03-01", sales: 140, orders: 3, sessions: 0, atc: 0 },
    ]);

    // Reordering / removing touches the DB for nothing new.
    await queryDiscountAggregateRows(conn, "2026-03-01", "2026-03-01", {
      discount_code: ["SAVE20", "SAVE10"],
    });
    expect(conn.query).toHaveBeenCalledTimes(2);
  });

  test("totals fold per-code partials and reuse the cache across query shapes", async () => {
    const conn = {
      dbName: "brand_test_db",
      query: jest.fn((sql, { replacements }) => {
        const code = replacements[replacements.length - 1];
        const map = {
          A: [{ total_orders: 5, total_sales: 500 }],
          B: [{ total_orders: 3, total_sales: 200 }],
        };
        return Promise.resolve(map[code]);
      }),
    };

    const totals = await queryDiscountAggregateTotals(
      conn,
      "2026-03-01",
      "2026-03-02",
      { discount_code: ["A", "B"] },
    );
    expect(totals).toMatchObject({ total_orders: 8, total_sales: 700 });
    expect(conn.query).toHaveBeenCalledTimes(2);

    // Same codes, same range → fully cached.
    conn.query.mockClear();
    await queryDiscountAggregateTotals(conn, "2026-03-01", "2026-03-02", {
      discount_code: ["A", "B"],
    });
    expect(conn.query).not.toHaveBeenCalled();
  });

  test("plain mock connections (no dbName) fall back to one IN-clause query", async () => {
    const conn = {
      query: jest.fn().mockResolvedValue([
        { date: "2026-03-01", sales: 10, orders: 1 },
      ]),
    };
    await queryDiscountAggregateRows(conn, "2026-03-01", "2026-03-01", {
      discount_code: ["A", "B", "C"],
    });
    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(conn.query.mock.calls[0][0]).toContain("discount_code IN (?, ?, ?)");
  });
});
