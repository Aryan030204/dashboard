jest.mock("../../../shared/db/models/AdsAlertRule.mongo", () => ({
  ...jest.requireActual("../../../shared/db/models/AdsAlertRule.mongo"),
  AdsAlertRule: {},
}));
jest.mock("../../../shared/db/models/AdsAlertEvent.mongo", () => ({ AdsAlertEvent: {} }));

const service = require("../../../services/adsPerformance.service");

function missingTable() {
  return Object.assign(new Error("no table"), { original: { code: "ER_NO_SUCH_TABLE" } });
}

// Fake brand connection answering by which table the SQL reads.
function connWith(handlers) {
  const query = jest.fn(async (sql, opts) => {
    for (const [needle, handler] of Object.entries(handlers)) {
      if (sql.includes(needle)) return typeof handler === "function" ? handler(sql, opts) : handler;
    }
    return [];
  });
  return { query };
}

const CAMPAIGN = {
  channel: "meta",
  campaign_id: "c1",
  campaign_name: "TOF_Sales",
  campaign_status: "ACTIVE",
  campaign_type: "OUTCOME_SALES",
  currency: "INR",
  active_days: 3,
  spend: "1000.0000",
  impressions: "10000",
  clicks: "200",
  link_clicks: "150",
  landing_page_views: "60",
  platform_purchases: "4.0000",
  platform_purchase_value: "1500.0000",
  utm_orders: "5",
  utm_sales: "2500.00",
};

describe("adsPerformance.service", () => {
  test("rejects malformed ranges and channels", async () => {
    await expect(service.getCampaigns({ conn: connWith({}), start: "2026-10", end: "2026-10-20" })).rejects.toMatchObject({ status: 400 });
    await expect(service.getCampaigns({ conn: connWith({}), start: "2026-10-21", end: "2026-10-20" })).rejects.toMatchObject({ status: 400 });
    await expect(
      service.getCampaigns({ conn: connWith({}), start: "2026-10-20", end: "2026-10-20", channel: "tiktok" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("campaigns carry both ROAS figures, LC->LPV and rule breaches", async () => {
    const conn = connWith({ ads_campaign_daily: [CAMPAIGN] });
    const result = await service.getCampaigns({
      conn,
      start: "2026-10-18",
      end: "2026-10-20",
      channel: "meta",
      rules: [{ rule_id: "r", name: "Low LPV", metric: "lpv_rate", threshold: 50 }],
    });
    expect(conn.query.mock.calls[0][1].replacements).toEqual(["2026-10-18", "2026-10-20", "meta"]);
    expect(result.campaigns[0]).toMatchObject({
      campaignId: "c1",
      spend: 1000,
      roas: 1.5,
      shopifyRoas: 2.5,
      lpvRate: 40,
      ctr: 2,
      cpc: 5,
      cpa: 250,
      cpm: 100,
    });
    expect(result.campaigns[0].alerts).toHaveLength(1);
  });

  test("a brand without migration 007 gets setup:false, not an error", async () => {
    const conn = connWith({ ads_campaign_daily: () => { throw missingTable(); } });
    await expect(service.getCampaigns({ conn, start: "2026-10-18", end: "2026-10-20" })).resolves.toEqual({ setup: false, campaigns: [] });
    const overview = await service.getOverview({ conn, start: "2026-10-18", end: "2026-10-20" });
    expect(overview.setup).toBe(false);
  });

  test("overview totals both channels and compares with the previous range", async () => {
    let call = 0;
    const conn = connWith({
      "GROUP BY channel": () => {
        call += 1;
        return call === 1
          ? [{ ...CAMPAIGN, day_count: 3 }, { ...CAMPAIGN, channel: "google", link_clicks: null, landing_page_views: null, day_count: 3 }]
          : [{ ...CAMPAIGN, spend: "1000.0000", platform_purchase_value: "1000", day_count: 3 }];
      },
      "GROUP BY date, channel": [
        { date: "2026-10-18", channel: "meta", spend: "300", platform_purchase_value: "450", utm_sales: "700" },
        { date: "2026-10-18", channel: "google", spend: "100", platform_purchase_value: "50", utm_sales: "0" },
      ],
      "COUNT(DISTINCT date) AS days": [{ days: 12, last_date: "2026-10-20" }],
    });
    const result = await service.getOverview({ conn, start: "2026-10-18", end: "2026-10-20" });
    expect(result.previousStart).toBe("2026-10-15");
    expect(result.previousEnd).toBe("2026-10-17");
    expect(result.total.spend).toBe(2000);
    expect(result.total.roas).toBe(1.5);
    expect(result.total.change.spend).toBe(100);
    expect(result.total.lpvRate).toBe(40);
    expect(result.channels.google.hasData).toBe(true);
    expect(result.trend[0]).toEqual({ date: "2026-10-18", metaSpend: 300, googleSpend: 100, platformValue: 500, utmSales: 700 });
    expect(result.coverage).toEqual({ daysInRange: 3, syncedDays: 12, lastSyncedDate: "2026-10-20" });
  });

  test("products pair each channel's spend with that channel's product revenue", async () => {
    const conn = connWith({
      ads_product_daily: [
        { product_id: "77", channel: "meta", spend: "400", clicks: "10", platform_purchase_value: "0" },
        { product_id: "77", channel: "google", spend: "100", clicks: "5", platform_purchase_value: "0" },
        { product_id: "0", channel: "meta", spend: "500", clicks: "9", platform_purchase_value: "0" },
      ],
      product_utm_daily: [{ product_id: "77", meta_sales: "1200", meta_orders: "3", google_sales: "500", google_orders: "1" }],
      product_landing_page_map: [{ product_id: "77", title: "Deal 5", path: "/products/deal-5" }],
    });
    const result = await service.getProducts({ conn, start: "2026-10-18", end: "2026-10-20" });
    const product = result.products.find((p) => p.productId === "77");
    expect(product).toMatchObject({ title: "Deal 5", spend: 500, metaRoas: 3, googleRoas: 5, roas: 3.4, orders: 4 });
    const unattributed = result.products.find((p) => p.unattributed);
    expect(unattributed).toMatchObject({ spend: 500, roas: null, sales: null });
    expect(result.totals).toEqual({ spend: 1000, attributedSpend: 500, attributedShare: 50 });
  });

  test("product revenue query binds every placeholder", async () => {
    const conn = connWith({
      ads_product_daily: [{ product_id: "77", channel: "meta", spend: "1", clicks: "0", platform_purchase_value: "0" }],
    });
    await service.getProducts({ conn, start: "2026-10-18", end: "2026-10-20" });
    const [sql, opts] = conn.query.mock.calls.find(([s]) => s.includes("product_utm_daily"));
    expect((sql.match(/\?/g) || []).length).toBe(opts.replacements.length);
  });

  test("landing pages join site speed and bucket LC->LPV by LCP", async () => {
    const conn = connWith({
      ads_ad_daily: [
        { landing_path: "/products/deal-5", ads: 2, spend: "500", clicks: "120", link_clicks: "100", landing_page_views: "50", platform_purchase_value: "0" },
        { landing_path: "/pages/sale", ads: 1, spend: "200", clicks: "60", link_clicks: "50", landing_page_views: "45", platform_purchase_value: "0" },
        { landing_path: "", ads: 1, spend: "10", clicks: "5", link_clicks: "5", landing_page_views: "1", platform_purchase_value: "0" },
      ],
      web_vitals_summary: [
        { url: "https://shop.myshopify.com/shop.myshopify.com/products/deal-5", lcp: "6.03", fcp: "4.3", performance: "67", samples: 2 },
        { url: "https://shop.myshopify.com/shop.myshopify.com/pages/sale/", lcp: "2.1", fcp: "1.2", performance: "90", samples: 1 },
      ],
    });
    const result = await service.getLandingPages({ conn, start: "2026-10-18", end: "2026-10-20" });
    const deal = result.pages.find((p) => p.landingPath === "/products/deal-5");
    expect(deal).toMatchObject({ lpvRate: 50, lostClicks: 50, lcp: 6.03, speedBucket: "poor" });
    const buckets = Object.fromEntries(result.speedBuckets.map((b) => [b.id, b]));
    expect(buckets.good.lpvRate).toBe(90);
    expect(buckets.poor.lpvRate).toBe(50);
    expect(result.unmeasuredPages).toBe(1);
  });

  test("vitalsPath drops the repeated shop domain segment", () => {
    expect(service.vitalsPath("https://a.myshopify.com/a.myshopify.com/products/x")).toBe("/products/x");
    expect(service.vitalsPath("https://a.com/")).toBe("/");
    expect(service.vitalsPath("not a url")).toBeNull();
  });
});
