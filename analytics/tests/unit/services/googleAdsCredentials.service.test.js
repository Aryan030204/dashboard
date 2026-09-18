jest.mock("../../../shared/db/models/GoogleAdsCredential.mongo", () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  deleteOne: jest.fn(),
}));
jest.mock("../../../shared/db/models/Tenant.mongo", () => ({
  resolveBrandRef: jest.fn(async () => "tenant-oid"),
}));
jest.mock("../../../shared/utils/crypto", () => ({
  encryptText: jest.fn((value) => `enc(${value})`),
  decryptText: jest.fn(),
}));

const GoogleAdsCredential = require("../../../shared/db/models/GoogleAdsCredential.mongo");
const { encryptText } = require("../../../shared/utils/crypto");
const service = require("../../../services/googleAdsCredentials.service");

const lean = (value) => ({ lean: jest.fn(async () => value) });

describe("googleAdsCredentials.service (pasted token, one document per brand)", () => {
  beforeEach(() => {
    GoogleAdsCredential.findOne.mockReset();
    GoogleAdsCredential.findOneAndUpdate.mockReset();
    GoogleAdsCredential.deleteOne.mockReset();
  });

  test("getStatus is not connected without a document", async () => {
    GoogleAdsCredential.findOne.mockReturnValue(lean(null));
    expect(await service.getStatus("bbb")).toEqual({ connected: false });
    expect(GoogleAdsCredential.findOne).toHaveBeenCalledWith({ brand_id: "BBB" });
  });

  test("getStatus never exposes the token itself", async () => {
    GoogleAdsCredential.findOne.mockReturnValue(
      lean({
        brand_id: "BBB",
        customer_id: "1234567890",
        login_customer_id: null,
        token_encrypted: "enc(secret)",
        token_suffix: "…secret",
        captured_at: "2026-09-18T10:00:00.000Z",
        updated_by_email: "a@b.c",
        last_error: null,
      }),
    );
    const status = await service.getStatus("BBB");
    expect(status).toEqual({
      connected: true,
      customerId: "1234567890",
      loginCustomerId: null,
      tokenSuffix: "…secret",
      capturedAt: "2026-09-18T10:00:00.000Z",
      updatedByEmail: "a@b.c",
      lastError: null,
    });
    expect(JSON.stringify(status)).not.toContain("enc(");
  });

  test("saveCredentials stores the token encrypted against the brand", async () => {
    GoogleAdsCredential.findOneAndUpdate.mockReturnValue(
      lean({ brand_id: "BBB", customer_id: "1234567890", token_suffix: "…abcdef" }),
    );
    const result = await service.saveCredentials({
      brandKey: "bbb",
      customerId: "123-456-7890",
      loginCustomerId: "987-654-3210",
      token: "  1//0g-refresh-abcdef  ",
      updatedByEmail: "a@b.c",
    });

    expect(result.success).toBe(true);
    expect(result.status).toMatchObject({ connected: true, customerId: "1234567890", tokenSuffix: "…abcdef" });
    expect(encryptText).toHaveBeenCalledWith("1//0g-refresh-abcdef");
    const [filter, update, options] = GoogleAdsCredential.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ brand_id: "BBB" });
    expect(update.$set).toMatchObject({
      brand: "tenant-oid",
      brand_id: "BBB",
      customer_id: "1234567890",
      login_customer_id: "9876543210",
      token_encrypted: "enc(1//0g-refresh-abcdef)",
      token_suffix: "…abcdef",
      updated_by_email: "a@b.c",
      last_error: null,
    });
    expect(update.$set).not.toHaveProperty("token");
    expect(options).toMatchObject({ upsert: true, new: true });
  });

  test("saveCredentials rejects a missing or malformed customer id", async () => {
    expect(await service.saveCredentials({ brandKey: "BBB", customerId: "", token: "x" })).toMatchObject({
      success: false,
      error: expect.stringContaining("customer_id is required"),
    });
    expect(await service.saveCredentials({ brandKey: "BBB", customerId: "12345", token: "x" })).toMatchObject({
      success: false,
      error: expect.stringContaining("10 digits"),
    });
    expect(GoogleAdsCredential.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("saveCredentials rejects a missing token", async () => {
    const result = await service.saveCredentials({ brandKey: "BBB", customerId: "1234567890", token: "   " });
    expect(result).toEqual({ success: false, error: "token is required." });
    expect(GoogleAdsCredential.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("saveCredentials requires a brand", async () => {
    await expect(service.saveCredentials({ brandKey: "", customerId: "1234567890", token: "x" })).rejects.toThrow(
      "brandKey is required",
    );
  });

  test("deleteCredentials removes the brand's document", async () => {
    GoogleAdsCredential.deleteOne.mockResolvedValue({ deletedCount: 1 });
    expect(await service.deleteCredentials("bbb")).toEqual({ success: true });
    expect(GoogleAdsCredential.deleteOne).toHaveBeenCalledWith({ brand_id: "BBB" });
  });
});
