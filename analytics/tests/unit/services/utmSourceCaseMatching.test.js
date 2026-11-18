/* eslint-env jest */

const { buildMetricsSnapshotService } = require("../../../services/metricsSnapshotService");

// The UTM tables use a case-insensitive collation, so GROUP BY merges "Google" and "google" but MySQL labels the
// merged row with an arbitrary spelling that can change from day to day. Joining rows by exact string used to
// drop the previous-period values (shown as 0) and the payment split of such a source.
function buildConn({ baseByDate, ordersByDate }) {
  return {
    query: jest.fn().mockImplementation((sql, options = {}) => {
      const date = options.replacements?.[0];
      if (sql.includes("FROM utm_source_daily")) return Promise.resolve(baseByDate[date] || []);
      if (sql.includes("FROM shopify_orders")) return Promise.resolve(ordersByDate[date] || []);
      return Promise.resolve([]);
    }),
  };
}

async function runFunnel(conn) {
  const service = buildMetricsSnapshotService({ now: () => new Date("2026-11-18T10:00:00Z") });
  return service.getDailyFunnel({
    conn,
    start: "2026-11-16",
    end: "2026-11-16",
    includeDaily: false,
    includeUtm: true,
    utmDate: "2026-11-16",
    utmEndDate: "2026-11-16",
    compareUtmDate: "2026-11-15",
    compareUtmEndDate: "2026-11-15",
    timezone: "Asia/Kolkata",
  });
}

describe("UTM source funnel: source spelling differs between days", () => {
  test("previous-period values and payment split are matched case-insensitively", async () => {
    const conn = buildConn({
      baseByDate: {
        "2026-11-16": [{ utm_source: "Google", sales: 100, sessions: 23575, atc_sessions: 1340, orders: 356 }],
        "2026-11-15": [{ utm_source: "google", sales: 90, sessions: 23760, atc_sessions: 1467, orders: 382 }],
      },
      ordersByDate: {
        "2026-11-16": [{ utm_source: "google", prepaid_orders: 150, cod_orders: 200, partially_paid_orders: 6 }],
        "2026-11-15": [{ utm_source: "Google", prepaid_orders: 160, cod_orders: 215, partially_paid_orders: 7 }],
      },
    });

    const { utmRows } = await runFunnel(conn);

    // one row, not a "Google" row with sessions and a separate "google" row with only the payment split
    expect(utmRows).toHaveLength(1);
    expect(utmRows[0]).toMatchObject({
      sessions: 23575,
      orders: 356,
      prepaid_orders: 150,
      cod_orders: 200,
      partially_paid_orders: 6,
    });
    expect(utmRows[0].previous).toMatchObject({
      sessions: 23760,
      atc_sessions: 1467,
      orders: 382,
      prepaid_orders: 160,
      cod_orders: 215,
      partially_paid_orders: 7,
    });
    expect(utmRows[0].deltas.sessions.value).not.toBeNull();
  });

  test("an identical spelling still works and a genuinely missing previous source stays 0", async () => {
    const conn = buildConn({
      baseByDate: {
        "2026-11-16": [
          { utm_source: "Google", sales: 0, sessions: 100, atc_sessions: 10, orders: 5 },
          { utm_source: "newsource", sales: 0, sessions: 50, atc_sessions: 5, orders: 1 },
        ],
        "2026-11-15": [{ utm_source: "Google", sales: 0, sessions: 80, atc_sessions: 8, orders: 4 }],
      },
      ordersByDate: {},
    });

    const { utmRows } = await runFunnel(conn);
    const google = utmRows.find((row) => row.utm_source === "Google");
    const fresh = utmRows.find((row) => row.utm_source === "newsource");

    expect(google.previous.sessions).toBe(80);
    expect(fresh.previous.sessions).toBe(0);
  });
});
