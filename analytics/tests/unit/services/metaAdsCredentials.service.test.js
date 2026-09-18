jest.mock("axios", () => ({ get: jest.fn() }));
jest.mock("../../../shared/db/models/MetaAdsCredential.mongo", () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
  deleteOne: jest.fn(),
}));
jest.mock("../../../shared/db/models/MetaOauthLog.mongo", () => ({}));
jest.mock("../../../shared/db/models/Tenant.mongo", () => ({
  resolveBrandRef: jest.fn(async () => "tenant-oid"),
}));
jest.mock("../../../shared/utils/crypto", () => ({
  encryptText: jest.fn((value) => `enc(${value})`),
  decryptText: jest.fn((value) => value.replace(/^enc\(|\)$/g, "")),
}));

const axios = require("axios");
const MetaAdsCredential = require("../../../shared/db/models/MetaAdsCredential.mongo");
const service = require("../../../services/metaAdsCredentials.service");

const lean = (value) => ({ lean: jest.fn(async () => value) });

describe("metaAdsCredentials.service storage (Mongo, one document per brand)", () => {
  beforeEach(() => {
    axios.get.mockReset();
    MetaAdsCredential.findOne.mockReset();
    MetaAdsCredential.findOneAndUpdate.mockReset();
    MetaAdsCredential.updateOne.mockReset();
    MetaAdsCredential.deleteOne.mockReset();
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
  });

  test("saveCredentials verifies with Meta then upserts the encrypted token by brand_id", async () => {
    axios.get.mockResolvedValue({ data: { id: "act_1", name: "Brand" } });
    MetaAdsCredential.findOneAndUpdate.mockResolvedValue({});

    const result = await service.saveCredentials({
      brandKey: "bbb",
      adAccountId: "1",
      accessToken: "EAAB-token",
      updatedByEmail: "a@b.c",
    });

    expect(result).toEqual({ success: true });
    expect(axios.get.mock.calls[0][0]).toContain("/act_1");
    const [filter, update, options] = MetaAdsCredential.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ brand_id: "BBB" });
    expect(update.$set).toMatchObject({
      brand: "tenant-oid",
      brand_id: "BBB",
      ad_account_id: "act_1",
      access_token_encrypted: "enc(EAAB-token)",
      last_error: null,
      updated_by_email: "a@b.c",
    });
    expect(update.$set).not.toHaveProperty("access_token");
    expect(options).toMatchObject({ upsert: true });
  });

  test("saveCredentials refuses a token Meta rejects and writes nothing", async () => {
    axios.get.mockRejectedValue({ response: { data: { error: { message: "Invalid OAuth access token." } } } });
    const result = await service.saveCredentials({ brandKey: "BBB", adAccountId: "1", accessToken: "bad" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid OAuth access token.");
    expect(MetaAdsCredential.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("getStatus reads by upper-cased brand_id and never exposes the token", async () => {
    MetaAdsCredential.findOne.mockReturnValue(
      lean({
        brand_id: "BBB",
        ad_account_id: "act_1",
        access_token_encrypted: "enc(secret)",
        token_expires_at: null,
        last_verified_at: "2026-09-18T10:00:00.000Z",
        last_error: "Meta insights: token expired",
        updated_by_email: "a@b.c",
        updated_at: "2026-09-18T10:00:00.000Z",
      }),
    );
    const status = await service.getStatus("bbb");
    expect(MetaAdsCredential.findOne).toHaveBeenCalledWith({ brand_id: "BBB" });
    expect(status).toMatchObject({ connected: true, adAccountId: "act_1", lastError: "Meta insights: token expired" });
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  test("getStatus is not connected without a document", async () => {
    MetaAdsCredential.findOne.mockReturnValue(lean(null));
    expect(await service.getStatus("BBB")).toEqual({ connected: false });
  });

  test("getCredentials decrypts the stored token", async () => {
    MetaAdsCredential.findOne.mockReturnValue(
      lean({ ad_account_id: "act_1", access_token_encrypted: "enc(secret)", token_expires_at: null }),
    );
    expect(await service.getCredentials("BBB")).toEqual({ adAccountId: "act_1", accessToken: "secret", expiresAt: null });
  });

  test("recordError and deleteCredentials address the brand's document", async () => {
    MetaAdsCredential.updateOne.mockResolvedValue({});
    MetaAdsCredential.deleteOne.mockResolvedValue({});
    await service.recordError("bbb", "x".repeat(600));
    expect(MetaAdsCredential.updateOne.mock.calls[0][0]).toEqual({ brand_id: "BBB" });
    expect(MetaAdsCredential.updateOne.mock.calls[0][1].$set.last_error).toHaveLength(500);
    expect(await service.deleteCredentials("bbb")).toEqual({ success: true });
    expect(MetaAdsCredential.deleteOne).toHaveBeenCalledWith({ brand_id: "BBB" });
  });
});
