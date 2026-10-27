jest.mock("../../../shared/db/models/TotalConfig.mongo", () => {
  const COST_FIELDS = [
    "cogs", "freight_inwards", "shipping", "rto", "payment_gateway", "packaging",
    "meta", "google", "other_paid", "influencers", "content", "sponsorships",
    "other_brand", "salaries", "rent", "technology", "agency_fees", "other_overheads",
  ];
  const model = {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  };
  model.COST_FIELDS = COST_FIELDS;
  model.VALUE_TYPES = ["flat", "percentage"];
  return model;
});
jest.mock("../../../shared/db/models/Tenant.mongo", () => ({
  resolveBrandRef: jest.fn(async () => "tenant-oid"),
}));

const TotalConfig = require("../../../shared/db/models/TotalConfig.mongo");
const service = require("../../../services/pnlCostConfig.service");

const lean = (value) => ({ lean: jest.fn(async () => value) });

describe("pnlCostConfig.service (total_config, one document per brand)", () => {
  beforeEach(() => {
    TotalConfig.findOne.mockReset();
    TotalConfig.findOneAndUpdate.mockReset();
  });

  test("getTotalConfig returns defaults with exists=false when the brand has no document", async () => {
    TotalConfig.findOne.mockReturnValue(lean(null));
    const config = await service.getTotalConfig("bbb");

    expect(TotalConfig.findOne).toHaveBeenCalledWith({ brand_id: "BBB" });
    expect(config.exists).toBe(false);
    expect(config.gstPct).toBe(18);
    expect(Object.keys(config.costs)).toEqual(service.COST_FIELDS);
    expect(Object.values(config.costs).every((line) => line === null)).toBe(true);
    expect(config.labels.cogs).toBe("COGS (SKU level)");
  });

  test("getTotalConfig maps a stored document to the API shape", async () => {
    TotalConfig.findOne.mockReturnValue(
      lean({
        brand_id: "BBB",
        gst_pct: 12,
        costs: { cogs: { value_type: "percentage", value: 30 }, rent: { value_type: "flat", value: 90000 } },
        updated_by_email: "a@b.c",
        updated_at: "2026-09-16T10:00:00.000Z",
      }),
    );
    const config = await service.getTotalConfig("BBB");
    expect(config.exists).toBe(true);
    expect(config.gstPct).toBe(12);
    expect(config.costs.cogs).toEqual({ valueType: "percentage", value: 30 });
    expect(config.costs.rent).toEqual({ valueType: "flat", value: 90000 });
    expect(config.costs.meta).toBeNull();
    expect(config.updatedByEmail).toBe("a@b.c");
  });

  test("saveTotalConfig upserts the single document with per-field $set paths", async () => {
    TotalConfig.findOneAndUpdate.mockReturnValue(
      lean({ brand_id: "BBB", gst_pct: 5, costs: { cogs: { value_type: "percentage", value: 30 }, rent: null } }),
    );
    const config = await service.saveTotalConfig({
      brandKey: "bbb",
      gstPct: "5",
      costs: { cogs: { value: 30, value_type: "percentage" }, rent: null },
      updatedByEmail: "a@b.c",
    });

    const [filter, update, options] = TotalConfig.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ brand_id: "BBB" });
    expect(update.$set).toEqual({
      gst_pct: 5,
      "costs.cogs": { value_type: "percentage", value: 30 },
      "costs.rent": null,
      brand: "tenant-oid",
      updated_by_email: "a@b.c",
    });
    expect(update.$setOnInsert).toEqual({ brand_id: "BBB", created_by_email: "a@b.c" });
    expect(options).toMatchObject({ upsert: true, new: true });
    expect(config.gstPct).toBe(5);
    expect(config.costs.cogs).toEqual({ valueType: "percentage", value: 30 });
  });

  test("upsertCostLine and clearCostLine touch only that line", async () => {
    TotalConfig.findOneAndUpdate.mockReturnValue(lean({ brand_id: "BBB", costs: {} }));
    await service.upsertCostLine({ brandKey: "BBB", field: "meta", value: "1200", valueType: "flat" });
    expect(TotalConfig.findOneAndUpdate.mock.calls[0][1].$set["costs.meta"]).toEqual({ value_type: "flat", value: 1200 });

    await service.clearCostLine({ brandKey: "BBB", field: "meta" });
    expect(TotalConfig.findOneAndUpdate.mock.calls[1][1].$set["costs.meta"]).toBeNull();
  });

  test("rejects unknown fields, bad value types, out-of-range values and empty saves", async () => {
    await expect(service.upsertCostLine({ brandKey: "BBB", field: "coffee", value: 1, valueType: "flat" }))
      .rejects.toMatchObject({ status: 400 });
    await expect(service.upsertCostLine({ brandKey: "BBB", field: "cogs", value: 1, valueType: "weird" }))
      .rejects.toMatchObject({ status: 400 });
    await expect(service.upsertCostLine({ brandKey: "BBB", field: "cogs", value: 150, valueType: "percentage" }))
      .rejects.toMatchObject({ status: 400 });
    await expect(service.upsertCostLine({ brandKey: "BBB", field: "cogs", value: -1, valueType: "flat" }))
      .rejects.toMatchObject({ status: 400 });
    await expect(service.saveTotalConfig({ brandKey: "BBB", gstPct: 101 })).rejects.toMatchObject({ status: 400 });
    await expect(service.saveTotalConfig({ brandKey: "BBB" })).rejects.toMatchObject({ status: 400 });
    await expect(service.saveTotalConfig({ brandKey: "" , gstPct: 18 })).rejects.toMatchObject({ status: 400 });
    expect(TotalConfig.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
