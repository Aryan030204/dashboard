jest.mock("../../../shared/db/models/AdsAlertRule.mongo", () => {
  const actual = jest.requireActual("../../../shared/db/models/AdsAlertRule.mongo");
  return {
    ...actual,
    AdsAlertRule: { findOne: jest.fn(), findOneAndUpdate: jest.fn() },
  };
});
jest.mock("../../../shared/db/models/AdsAlertEvent.mongo", () => ({
  AdsAlertEvent: { find: jest.fn() },
}));

const { AdsAlertRule } = require("../../../shared/db/models/AdsAlertRule.mongo");
const service = require("../../../services/adsAlertRules.service");

const ROW = {
  channel: "meta",
  spend: 1000,
  impressions: 10000,
  clicks: 200,
  link_clicks: 150,
  landing_page_views: 60,
  platform_purchases: 4,
  platform_purchase_value: 1500,
  utm_sales: 2500,
};

function lean(value) {
  return { lean: jest.fn().mockResolvedValue(value) };
}

describe("adsAlertRules.service", () => {
  beforeEach(() => jest.clearAllMocks());

  // Same cases as tests/test_ads_performance.py::AlertRuleTests in the
  // pipeline repo - the two evaluators must agree.
  test("metric definitions match the pipeline", () => {
    expect(service.metricValue("roas", ROW)).toBeCloseTo(1.5);
    expect(service.metricValue("shopify_roas", ROW)).toBeCloseTo(2.5);
    expect(service.metricValue("lpv_rate", ROW)).toBeCloseTo(40);
    expect(service.metricValue("ctr", ROW)).toBeCloseTo(2);
    expect(service.metricValue("cpc", ROW)).toBeCloseTo(5);
    expect(service.metricValue("cpa", ROW)).toBeCloseTo(250);
    expect(service.metricValue("lpv_rate", { ...ROW, link_clicks: null })).toBeNull();
    expect(service.metricValue("roas", { ...ROW, spend: 0 })).toBeNull();
  });

  test("evaluateRule respects operator, channel and volume gates", () => {
    const rule = { metric: "roas", operator: "below", threshold: 2, channel: "meta", min_spend: 500 };
    expect(service.evaluateRule(rule, ROW)).toBeCloseTo(1.5);
    expect(service.evaluateRule({ ...rule, threshold: 1 }, ROW)).toBeNull();
    expect(service.evaluateRule({ ...rule, channel: "google" }, ROW)).toBeNull();
    expect(service.evaluateRule({ ...rule, min_spend: 5000 }, ROW)).toBeNull();
    expect(service.evaluateRule({ ...rule, is_active: false }, ROW)).toBeNull();
    expect(service.evaluateRule({ metric: "cpc", operator: "above", threshold: 4 }, ROW)).toBeCloseTo(5);
    expect(service.evaluateRule({ metric: "lpv_rate", threshold: 50, min_clicks: 500 }, ROW)).toBeNull();
  });

  test("breachesFor lists every breached rule with a rounded value", () => {
    const breaches = service.breachesFor(
      [
        { rule_id: "a", name: "Low ROAS", metric: "roas", threshold: 2 },
        { rule_id: "b", name: "High CPC", metric: "cpc", operator: "above", threshold: 10 },
      ],
      ROW,
    );
    expect(breaches).toEqual([
      { rule_id: "a", name: "Low ROAS", severity: "medium", metric: "roas", operator: "below", threshold: 2, value: 1.5 },
    ]);
  });

  test("normalizeRule fills defaults and validates", () => {
    const rule = service.normalizeRule({ name: " Low LPV ", metric: "lpv_rate", threshold: "60" }, 0);
    expect(rule).toMatchObject({
      name: "Low LPV",
      channel: "all",
      operator: "below",
      threshold: 60,
      lookback_days: 3,
      severity: "medium",
      is_active: true,
    });
    expect(rule.rule_id).toEqual(expect.any(String));
    expect(() => service.normalizeRule({ name: "x", metric: "nope", threshold: 1 }, 0)).toThrow(/metric/);
    expect(() => service.normalizeRule({ name: "x", metric: "roas" }, 0)).toThrow(/threshold/);
    expect(() => service.normalizeRule({ name: "x", metric: "roas", threshold: 1, lookback_days: 45 }, 0)).toThrow(/1-30/);
    expect(() => service.normalizeRule({ name: "x", metric: "roas", threshold: -1 }, 0)).toThrow(/>= 0/);
  });

  test("saveRules replaces the brand's full rule set, upper-casing brand_id", async () => {
    AdsAlertRule.findOneAndUpdate.mockReturnValue(lean({ rules: [{ rule_id: "r1" }], updated_by: "a@b.c" }));
    const result = await service.saveRules({
      brandKey: "bbb",
      rules: [{ rule_id: "r1", name: "Low ROAS", metric: "roas", threshold: 1.5 }],
      updatedByEmail: "a@b.c",
    });
    const [filter, update] = AdsAlertRule.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ brand_id: "BBB" });
    expect(update.$set.rules[0]).toMatchObject({ rule_id: "r1", threshold: 1.5 });
    expect(result.updatedBy).toBe("a@b.c");
  });

  test("saveRules rejects a non-array", async () => {
    await expect(service.saveRules({ brandKey: "BBB", rules: "x" })).rejects.toMatchObject({ status: 400 });
  });

  test("getRules returns an empty list when the brand has none", async () => {
    AdsAlertRule.findOne.mockReturnValue(lean(null));
    await expect(service.getRules("BBB")).resolves.toEqual({ rules: [], updatedAt: null, updatedBy: null });
  });
});
