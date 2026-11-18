/* eslint-env jest */

const {
  DEFAULT_DATA_RESTRICTION_PERIOD,
  getDataRestrictionConfig,
  isRangeOverDataRestrictionPeriod,
} = require("../../../../modules/metrics/longRangeGate");
const { extractFilters } = require("../../../../shared/utils/filters");

const ORIGINAL = process.env.DATA_RESTRICTION_PERIOD;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DATA_RESTRICTION_PERIOD;
  else process.env.DATA_RESTRICTION_PERIOD = ORIGINAL;
});

describe("data restriction period", () => {
  test("is 31 days unless the environment says otherwise", () => {
    delete process.env.DATA_RESTRICTION_PERIOD;
    expect(DEFAULT_DATA_RESTRICTION_PERIOD).toBe(31);
    expect(getDataRestrictionConfig().periodDays).toBe(31);
  });

  test("31 days are allowed, 32 are over the limit", () => {
    delete process.env.DATA_RESTRICTION_PERIOD;
    expect(isRangeOverDataRestrictionPeriod("2026-10-01", "2026-10-31")).toBe(false); // 31 days
    expect(isRangeOverDataRestrictionPeriod("2026-10-01", "2026-11-01")).toBe(true); // 32 days
  });

  test("UTM filters are dropped past the same limit, not past a fixed 30", () => {
    delete process.env.DATA_RESTRICTION_PERIOD;
    const query = (start, end) => ({ query: { start, end, utm_source: "facebook" }, user: {} });
    expect(extractFilters(query("2026-10-01", "2026-10-31")).utm_source).toBeTruthy(); // 31 days kept
    expect(extractFilters(query("2026-10-01", "2026-11-01")).utm_source).toBeNull(); // 32 days dropped
  });
});
