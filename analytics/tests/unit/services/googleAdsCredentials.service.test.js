jest.mock("axios", () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock("../../../shared/db/models/GoogleAdsCredential.mongo", () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  deleteOne: jest.fn(),
}));
jest.mock("../../../shared/db/models/GoogleOauthPending.mongo", () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  deleteOne: jest.fn(),
}));
jest.mock("../../../shared/db/models/Tenant.mongo", () => ({
  resolveBrandRef: jest.fn(async () => "tenant-oid"),
}));
jest.mock("../../../shared/utils/crypto", () => ({
  encryptText: jest.fn((value) => `enc(${value})`),
  decryptText: jest.fn((value) => value.replace(/^enc\(|\)$/g, "")),
}));

const axios = require("axios");
const GoogleAdsCredential = require("../../../shared/db/models/GoogleAdsCredential.mongo");
const GoogleOauthPending = require("../../../shared/db/models/GoogleOauthPending.mongo");
const { encryptText } = require("../../../shared/utils/crypto");
const service = require("../../../services/googleAdsCredentials.service");

const lean = (value) => ({ lean: jest.fn(async () => value) });

describe("googleAdsCredentials.service (pasted token, one document per brand)", () => {
  beforeEach(() => {
    axios.post.mockReset();
    axios.get.mockReset();
    GoogleAdsCredential.findOne.mockReset();
    GoogleAdsCredential.findOneAndUpdate.mockReset();
    GoogleAdsCredential.deleteOne.mockReset();
    GoogleOauthPending.findOne.mockReset();
    GoogleOauthPending.findOneAndUpdate.mockReset();
    GoogleOauthPending.deleteOne.mockReset();
    delete process.env.GOOGLE_ADS_CLIENT_ID;
    delete process.env.GOOGLE_ADS_CLIENT_SECRET;
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
      customerIds: ["1234567890"],
      customerId: "1234567890",
      loginCustomerId: null,
      tokenSuffix: "…secret",
      authMethod: "manual",
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
      customerIds: ["123-456-7890"],
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
      customer_ids: ["1234567890"],
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
    expect(await service.saveCredentials({ brandKey: "BBB", customerIds: [], token: "x" })).toMatchObject({
      success: false,
      error: expect.stringContaining("customer_id is required"),
    });
    expect(await service.saveCredentials({ brandKey: "BBB", customerIds: ["12345"], token: "x" })).toMatchObject({
      success: false,
      error: expect.stringContaining("10 digits"),
    });
    expect(GoogleAdsCredential.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("saveCredentials rejects a missing token", async () => {
    const result = await service.saveCredentials({ brandKey: "BBB", customerIds: ["1234567890"], token: "   " });
    expect(result).toEqual({ success: false, error: "token is required." });
    expect(GoogleAdsCredential.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("saveCredentials requires a brand", async () => {
    await expect(
      service.saveCredentials({ brandKey: "", customerIds: ["1234567890"], token: "x" }),
    ).rejects.toThrow("brandKey is required");
  });

  test("saveCredentials accepts more than one customer id and dedupes", async () => {
    GoogleAdsCredential.findOneAndUpdate.mockReturnValue(
      lean({ brand_id: "BBB", customer_ids: ["1234567890", "1112223333"], customer_id: "1234567890" }),
    );
    const result = await service.saveCredentials({
      brandKey: "BBB",
      customerIds: ["123-456-7890", "111-222-3333", "1234567890"],
      token: "rt",
    });
    expect(result.success).toBe(true);
    const [, update] = GoogleAdsCredential.findOneAndUpdate.mock.calls[0];
    expect(update.$set.customer_ids).toEqual(["1234567890", "1112223333"]);
    expect(update.$set.customer_id).toBe("1234567890");
  });

  test("deleteCredentials removes the brand's document", async () => {
    GoogleAdsCredential.deleteOne.mockResolvedValue({ deletedCount: 1 });
    expect(await service.deleteCredentials("bbb")).toEqual({ success: true });
    expect(GoogleAdsCredential.deleteOne).toHaveBeenCalledWith({ brand_id: "BBB" });
  });

  describe("OAuth (Connect with Google)", () => {
    test("startOauth exchanges the code and parks the encrypted refresh token, never persisting the real credential", async () => {
      process.env.GOOGLE_ADS_CLIENT_ID = "cid";
      process.env.GOOGLE_ADS_CLIENT_SECRET = "secret";
      axios.post.mockResolvedValue({ data: { access_token: "at", refresh_token: "1//0g-refresh", expires_in: 3599 } });
      GoogleOauthPending.findOneAndUpdate.mockResolvedValue({});

      const result = await service.startOauth({
        brandKey: "bbb",
        code: "auth-code",
        redirectUri: "https://app.example.com/pnl",
        updatedByEmail: "a@b.c",
      });

      // GOOGLE_ADS_DEVELOPER_TOKEN isn't set in this test, so the best-effort
      // account listing fails gracefully - the connect itself still succeeds.
      expect(result).toEqual({
        success: true,
        accounts: [],
        listError: "GOOGLE_ADS_DEVELOPER_TOKEN is not configured on the backend.",
      });
      expect(axios.post).toHaveBeenCalledWith(
        "https://oauth2.googleapis.com/token",
        expect.objectContaining({ code: "auth-code", client_id: "cid", client_secret: "secret", grant_type: "authorization_code" }),
      );
      const [filter, update, options] = GoogleOauthPending.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({ brand_id: "BBB" });
      expect(update.$set.refresh_token_encrypted).toBe("enc(1//0g-refresh)");
      expect(options).toMatchObject({ upsert: true });
      expect(GoogleAdsCredential.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test("startOauth fails without GOOGLE_ADS_CLIENT_ID/SECRET configured", async () => {
      const result = await service.startOauth({ brandKey: "BBB", code: "x", redirectUri: "https://x" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("GOOGLE_ADS_CLIENT_ID");
      expect(axios.post).not.toHaveBeenCalled();
    });

    test("startOauth surfaces a clear error when Google returns no refresh token", async () => {
      process.env.GOOGLE_ADS_CLIENT_ID = "cid";
      process.env.GOOGLE_ADS_CLIENT_SECRET = "secret";
      axios.post.mockResolvedValue({ data: { access_token: "at", expires_in: 3599 } });

      const result = await service.startOauth({ brandKey: "BBB", code: "x", redirectUri: "https://x" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("did not return a refresh token");
      expect(GoogleOauthPending.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test("startOauth surfaces Google's rejection message", async () => {
      process.env.GOOGLE_ADS_CLIENT_ID = "cid";
      process.env.GOOGLE_ADS_CLIENT_SECRET = "secret";
      axios.post.mockRejectedValue({ response: { data: { error_description: "Malformed auth code." } } });

      const result = await service.startOauth({ brandKey: "BBB", code: "bad", redirectUri: "https://x" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Malformed auth code.");
    });

    test("finalizeOauth reads back the parked refresh token, persists it with auth_method 'oauth', and clears the pending doc", async () => {
      GoogleOauthPending.findOne.mockReturnValue(lean({ brand_id: "BBB", refresh_token_encrypted: "enc(1//0g-refresh)" }));
      GoogleAdsCredential.findOneAndUpdate.mockReturnValue(
        lean({ brand_id: "BBB", customer_id: "1234567890", token_suffix: "…efresh", auth_method: "oauth" }),
      );
      GoogleOauthPending.deleteOne.mockResolvedValue({});

      const result = await service.finalizeOauth({
        brandKey: "bbb",
        customerIds: ["123-456-7890"],
        updatedByEmail: "a@b.c",
      });

      expect(result.success).toBe(true);
      expect(result.status).toMatchObject({ connected: true, customerId: "1234567890", authMethod: "oauth" });
      const [, update] = GoogleAdsCredential.findOneAndUpdate.mock.calls[0];
      expect(update.$set.token_encrypted).toBe("enc(1//0g-refresh)");
      expect(update.$set.auth_method).toBe("oauth");
      expect(GoogleOauthPending.deleteOne).toHaveBeenCalledWith({ brand_id: "BBB" });
    });

    test("finalizeOauth fails when there's no pending session for the brand", async () => {
      GoogleOauthPending.findOne.mockReturnValue(lean(null));
      const result = await service.finalizeOauth({ brandKey: "BBB", customerIds: ["1234567890"] });
      expect(result.success).toBe(false);
      expect(result.error).toContain("expired");
      expect(GoogleAdsCredential.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test("finalizeOauth still rejects a malformed customer id, without touching the pending doc's lifetime", async () => {
      GoogleOauthPending.findOne.mockReturnValue(lean({ brand_id: "BBB", refresh_token_encrypted: "enc(rt)" }));
      const result = await service.finalizeOauth({ brandKey: "BBB", customerIds: ["123"] });
      expect(result).toMatchObject({ success: false, error: expect.stringContaining("10 digits") });
      expect(GoogleAdsCredential.findOneAndUpdate).not.toHaveBeenCalled();
      expect(GoogleOauthPending.deleteOne).toHaveBeenCalledWith({ brand_id: "BBB" });
    });

    test("finalizeOauth persists more than one customer id from the picker", async () => {
      GoogleOauthPending.findOne.mockReturnValue(lean({ brand_id: "BBB", refresh_token_encrypted: "enc(rt)" }));
      GoogleAdsCredential.findOneAndUpdate.mockReturnValue(
        lean({ brand_id: "BBB", customer_ids: ["1234567890", "1112223333"], customer_id: "1234567890" }),
      );
      GoogleOauthPending.deleteOne.mockResolvedValue({});

      const result = await service.finalizeOauth({
        brandKey: "BBB",
        customerIds: ["1234567890", "1112223333"],
      });
      expect(result.success).toBe(true);
      expect(result.status.customerIds).toEqual(["1234567890", "1112223333"]);
      const [, update] = GoogleAdsCredential.findOneAndUpdate.mock.calls[0];
      expect(update.$set.customer_ids).toEqual(["1234567890", "1112223333"]);
    });
  });
});
