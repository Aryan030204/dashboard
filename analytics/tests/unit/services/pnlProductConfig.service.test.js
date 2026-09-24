jest.mock("../../../shared/db/models/ProductConfig.mongo", () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
jest.mock("../../../shared/db/models/Tenant.mongo", () => ({
  resolveBrandRef: jest.fn(async () => "tenant-oid"),
}));
jest.mock("../../../services/pnlCostConfig.service", () => ({
  upsertCostLine: jest.fn(async () => ({})),
}));

const ProductConfig = require("../../../shared/db/models/ProductConfig.mongo");
const pnlCostConfigService = require("../../../services/pnlCostConfig.service");
const service = require("../../../services/pnlProductConfig.service");

const lean = (value) => ({ lean: jest.fn(async () => value) });

describe("pnlProductConfig.service (per-brand product_config document)", () => {
  beforeEach(() => {
    ProductConfig.findOne.mockReset();
    ProductConfig.findOneAndUpdate.mockReset();
    pnlCostConfigService.upsertCostLine.mockClear();
  });

  describe("getProductConfig", () => {
    test("returns exists:false without a document", async () => {
      ProductConfig.findOne.mockReturnValue(lean(null));
      expect(await service.getProductConfig("bbb")).toEqual({ exists: false, productConfig: {} });
      expect(ProductConfig.findOne).toHaveBeenCalledWith({ brand_id: "BBB" });
    });

    test("returns the saved product_config", async () => {
      ProductConfig.findOne.mockReturnValue(
        lean({
          brand_id: "BBB",
          product_config: { "111": { cogs: 50 } },
          updated_by_email: "a@b.c",
          updated_at: "2026-09-18T10:00:00.000Z",
        }),
      );
      expect(await service.getProductConfig("BBB")).toEqual({
        exists: true,
        productConfig: { "111": { cogs: 50 } },
        updatedByEmail: "a@b.c",
        updatedAt: "2026-09-18T10:00:00.000Z",
      });
    });
  });

  describe("downloadTemplate", () => {
    test("builds a CSV of product_id/title from product_landing_mapping, pre-filling any saved cogs", async () => {
      ProductConfig.findOne.mockReturnValue(
        lean({ brand_id: "BBB", product_config: { "111": { cogs: 50 } } }),
      );
      const conn = {
        query: jest.fn(async () => [
          { product_id: 111, title: "Alpha Dusk" },
          { product_id: 222, title: "Cookie Crush, Deluxe" },
        ]),
      };

      const result = await service.downloadTemplate({ brandKey: "bbb", conn });

      expect(conn.query.mock.calls[0][0]).toContain("FROM product_landing_mapping");
      expect(result.filename).toBe("product-cogs-template-BBB.csv");
      expect(result.csv).toBe(
        [
          "product_id,title,cogs",
          "111,Alpha Dusk,50",
          '222,"Cookie Crush, Deluxe",',
        ].join("\n"),
      );
    });

    test("requires a brand database connection", async () => {
      await expect(service.downloadTemplate({ brandKey: "BBB", conn: null })).rejects.toThrow(
        "No database connection for this brand.",
      );
    });
  });

  describe("uploadCogs", () => {
    const csv = (rows) => ["product_id,title,cogs", ...rows].join("\n");

    test("parses the CSV, replaces the brand's product_config document, and rolls the sum into total_config.costs.cogs", async () => {
      ProductConfig.findOneAndUpdate.mockResolvedValue({});

      const result = await service.uploadCogs({
        brandKey: "bbb",
        csvText: csv(["111,Alpha Dusk,50", "222,Cookie Crush,25.5"]),
        updatedByEmail: "a@b.c",
      });

      expect(result).toMatchObject({ success: true, total: 2, succeeded: 2, failed: 0, aggregateCogs: 75.5 });
      const [filter, update, options] = ProductConfig.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({ brand_id: "BBB" });
      expect(update.$set).toMatchObject({
        brand: "tenant-oid",
        brand_id: "BBB",
        product_config: { "111": { cogs: 50 }, "222": { cogs: 25.5 } },
        updated_by_email: "a@b.c",
      });
      expect(options).toMatchObject({ upsert: true });
      expect(pnlCostConfigService.upsertCostLine).toHaveBeenCalledWith({
        brandKey: "BBB",
        field: "cogs",
        value: 75.5,
        valueType: "flat",
        updatedByEmail: "a@b.c",
      });
    });

    test("skips rows with a blank cogs cell without failing the upload", async () => {
      ProductConfig.findOneAndUpdate.mockResolvedValue({});

      const result = await service.uploadCogs({
        brandKey: "BBB",
        csvText: csv(["111,Alpha Dusk,50", "222,Cookie Crush,"]),
      });

      expect(result).toMatchObject({ success: true, total: 2, succeeded: 1, failed: 0 });
      expect(result.results[1]).toMatchObject({ product_id: "222", status: "skipped" });
      const [, update] = ProductConfig.findOneAndUpdate.mock.calls[0];
      expect(update.$set.product_config).toEqual({ "111": { cogs: 50 } });
    });

    test("rejects a non-numeric or negative cogs value as an error row, without touching other valid rows", async () => {
      ProductConfig.findOneAndUpdate.mockResolvedValue({});

      const result = await service.uploadCogs({
        brandKey: "BBB",
        csvText: csv(["111,Alpha Dusk,not-a-number", "222,Cookie Crush,-5", "333,Forest Rebel,10"]),
      });

      expect(result).toMatchObject({ success: false, total: 3, succeeded: 1, failed: 2 });
      expect(result.results[0]).toMatchObject({ status: "error", error: "cogs must be a number >= 0" });
      expect(result.results[1]).toMatchObject({ status: "error" });
      const [, update] = ProductConfig.findOneAndUpdate.mock.calls[0];
      expect(update.$set.product_config).toEqual({ "333": { cogs: 10 } });
    });

    test("rejects a row missing product_id", async () => {
      const result = await service.uploadCogs({ brandKey: "BBB", csvText: csv([",Alpha Dusk,50"]) });
      expect(result).toMatchObject({ success: false, total: 1, succeeded: 0, failed: 1 });
      expect(ProductConfig.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test("rejects a CSV missing required columns", async () => {
      const result = await service.uploadCogs({ brandKey: "BBB", csvText: "product_id,title\n111,Alpha Dusk" });
      expect(result).toEqual({ success: false, error: "Missing required column(s): cogs", results: [] });
      expect(ProductConfig.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test("rejects a CSV with no data rows", async () => {
      const result = await service.uploadCogs({ brandKey: "BBB", csvText: "product_id,title,cogs" });
      expect(result).toEqual({
        success: false,
        error: "CSV must have a header row and at least one data row.",
        results: [],
      });
    });

    test("fails when every row is blank or invalid, without writing anything", async () => {
      const result = await service.uploadCogs({ brandKey: "BBB", csvText: csv(["111,Alpha Dusk,"]) });
      expect(result).toMatchObject({ success: false, error: "No valid cogs values found in the CSV.", succeeded: 0 });
      expect(ProductConfig.findOneAndUpdate).not.toHaveBeenCalled();
      expect(pnlCostConfigService.upsertCostLine).not.toHaveBeenCalled();
    });

    test("requires a brand", async () => {
      await expect(service.uploadCogs({ brandKey: "", csvText: csv(["111,Alpha,50"]) })).rejects.toThrow(
        "brandKey is required",
      );
    });
  });
});
