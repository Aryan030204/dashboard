jest.mock("axios", () => ({ get: jest.fn() }));
jest.mock("../../../shared/db/models/MetaAdsCredential.mongo", () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
  deleteOne: jest.fn(),
}));
jest.mock("../../../shared/db/models/MetaOauthPending.mongo", () => ({
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
const MetaAdsCredential = require("../../../shared/db/models/MetaAdsCredential.mongo");
const MetaOauthPending = require("../../../shared/db/models/MetaOauthPending.mongo");
const service = require("../../../services/metaAdsCredentials.service");

const lean = (value) => ({ lean: jest.fn(async () => value) });

describe("metaAdsCredentials.service storage (Mongo, one document per brand)", () => {
  beforeEach(() => {
    axios.get.mockReset();
    MetaAdsCredential.findOne.mockReset();
    MetaAdsCredential.findOneAndUpdate.mockReset();
    MetaAdsCredential.updateOne.mockReset();
    MetaAdsCredential.deleteOne.mockReset();
    MetaOauthPending.findOne.mockReset();
    MetaOauthPending.findOneAndUpdate.mockReset();
    MetaOauthPending.deleteOne.mockReset();
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
  });

  test("saveCredentials verifies with Meta then upserts the encrypted token by brand_id", async () => {
    axios.get.mockResolvedValue({ data: { id: "act_1", name: "Brand" } });
    MetaAdsCredential.findOneAndUpdate.mockResolvedValue({});

    const result = await service.saveCredentials({
      brandKey: "bbb",
      adAccountIds: ["1"],
      accessToken: "EAAB-token",
      updatedByEmail: "a@b.c",
    });

    expect(result).toMatchObject({ success: true });
    expect(axios.get.mock.calls[0][0]).toContain("/act_1");
    const [filter, update, options] = MetaAdsCredential.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ brand_id: "BBB" });
    expect(update.$set).toMatchObject({
      brand: "tenant-oid",
      brand_id: "BBB",
      ad_account_ids: ["act_1"],
      ad_account_id: "act_1",
      access_token_encrypted: "enc(EAAB-token)",
      last_error: null,
      updated_by_email: "a@b.c",
    });
    expect(update.$set).not.toHaveProperty("access_token");
    expect(options).toMatchObject({ upsert: true });
  });

  test("saveCredentials accepts multiple ad account ids, verifying and storing each", async () => {
    axios.get
      .mockResolvedValueOnce({ data: { id: "act_1", name: "Brand 1" } })
      .mockResolvedValueOnce({ data: { id: "act_2", name: "Brand 2" } });
    MetaAdsCredential.findOneAndUpdate.mockResolvedValue({});

    const result = await service.saveCredentials({
      brandKey: "bbb",
      adAccountIds: ["1", "act_2", "1"],
      accessToken: "EAAB-token",
      tokenType: "system_user",
    });

    expect(result).toMatchObject({ success: true });
    expect(axios.get).toHaveBeenCalledTimes(2);
    const [, update] = MetaAdsCredential.findOneAndUpdate.mock.calls[0];
    expect(update.$set.ad_account_ids).toEqual(["act_1", "act_2"]);
    expect(update.$set.ad_account_id).toBe("act_1");
  });

  test("saveCredentials refuses when no ad account ids are given", async () => {
    const result = await service.saveCredentials({ brandKey: "BBB", adAccountIds: [], accessToken: "x" });
    expect(result.success).toBe(false);
    expect(axios.get).not.toHaveBeenCalled();
    expect(MetaAdsCredential.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("saveCredentials defaults to token_type 'user' and exchanges via META_APP_ID/SECRET when configured", async () => {
    process.env.META_APP_ID = "app-id";
    process.env.META_APP_SECRET = "app-secret";
    axios.get
      .mockResolvedValueOnce({ data: { id: "act_1", name: "Brand" } }) // verifyToken
      .mockResolvedValueOnce({ data: { access_token: "LONG-LIVED", expires_in: 5184000 } }); // exchange
    MetaAdsCredential.findOneAndUpdate.mockResolvedValue({});

    const result = await service.saveCredentials({
      brandKey: "bbb",
      adAccountIds: ["1"],
      accessToken: "EAAB-token",
    });

    expect(result).toMatchObject({ success: true });
    expect(axios.get).toHaveBeenCalledTimes(2);
    const [, update] = MetaAdsCredential.findOneAndUpdate.mock.calls[0];
    expect(update.$set.token_type).toBe("user");
    expect(update.$set.access_token_encrypted).toBe("enc(LONG-LIVED)");
    expect(update.$set.token_expires_at).toBeInstanceOf(Date);
  });

  test("saveCredentials with token_type 'system_user' never calls the exchange endpoint and stores the token as-is", async () => {
    process.env.META_APP_ID = "app-id";
    process.env.META_APP_SECRET = "app-secret";
    axios.get.mockResolvedValueOnce({ data: { id: "act_1", name: "Brand" } }); // verifyToken only
    MetaAdsCredential.findOneAndUpdate.mockResolvedValue({});

    const result = await service.saveCredentials({
      brandKey: "bbb",
      adAccountIds: ["1"],
      accessToken: "SYSTEM-USER-TOKEN",
      tokenType: "system_user",
    });

    expect(result).toMatchObject({ success: true });
    // Only verifyToken's call — the exchange endpoint is never hit for system_user.
    expect(axios.get).toHaveBeenCalledTimes(1);
    const [, update] = MetaAdsCredential.findOneAndUpdate.mock.calls[0];
    expect(update.$set.token_type).toBe("system_user");
    expect(update.$set.access_token_encrypted).toBe("enc(SYSTEM-USER-TOKEN)");
    expect(update.$set.token_expires_at).toBeNull();
  });

  test("saveCredentials treats any unrecognized token_type as 'user'", async () => {
    axios.get.mockResolvedValueOnce({ data: { id: "act_1", name: "Brand" } });
    MetaAdsCredential.findOneAndUpdate.mockResolvedValue({});

    await service.saveCredentials({
      brandKey: "bbb",
      adAccountIds: ["1"],
      accessToken: "tok",
      tokenType: "not-a-real-type",
    });

    const [, update] = MetaAdsCredential.findOneAndUpdate.mock.calls[0];
    expect(update.$set.token_type).toBe("user");
  });

  test("saveCredentials refuses a token Meta rejects and writes nothing", async () => {
    axios.get.mockRejectedValue({ response: { data: { error: { message: "Invalid OAuth access token." } } } });
    const result = await service.saveCredentials({ brandKey: "BBB", adAccountIds: ["1"], accessToken: "bad" });
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
    expect(status).toMatchObject({
      connected: true,
      adAccountId: "act_1",
      adAccountIds: ["act_1"],
      lastError: "Meta insights: token expired",
    });
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  test("getStatus surfaces every ad_account_ids entry for a multi-account document", async () => {
    MetaAdsCredential.findOne.mockReturnValue(
      lean({
        brand_id: "BBB",
        ad_account_ids: ["act_1", "act_2"],
        ad_account_id: "act_1",
        access_token_encrypted: "enc(secret)",
      }),
    );
    const status = await service.getStatus("BBB");
    expect(status).toMatchObject({ adAccountIds: ["act_1", "act_2"], adAccountId: "act_1" });
  });

  test("getStatus surfaces token_type, defaulting to 'user' for older documents without it", async () => {
    MetaAdsCredential.findOne.mockReturnValueOnce(
      lean({ brand_id: "BBB", ad_account_id: "act_1", access_token_encrypted: "enc(x)" }),
    );
    expect(await service.getStatus("BBB")).toMatchObject({ tokenType: "user" });

    MetaAdsCredential.findOne.mockReturnValueOnce(
      lean({
        brand_id: "BBB",
        ad_account_id: "act_1",
        access_token_encrypted: "enc(x)",
        token_type: "system_user",
      }),
    );
    expect(await service.getStatus("BBB")).toMatchObject({ tokenType: "system_user" });
  });

  test("getStatus is not connected without a document", async () => {
    MetaAdsCredential.findOne.mockReturnValue(lean(null));
    expect(await service.getStatus("BBB")).toEqual({ connected: false });
  });

  test("getCredentials decrypts the stored token", async () => {
    MetaAdsCredential.findOne.mockReturnValue(
      lean({ ad_account_id: "act_1", access_token_encrypted: "enc(secret)", token_expires_at: null }),
    );
    expect(await service.getCredentials("BBB")).toEqual({
      adAccountIds: ["act_1"],
      adAccountId: "act_1",
      accessToken: "secret",
      expiresAt: null,
    });
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

  describe("OAuth (Continue with Meta)", () => {
    test("startOauth exchanges the code, lists ad accounts, and parks the encrypted token without persisting the real credential", async () => {
      process.env.META_APP_ID = "app-id";
      process.env.META_APP_SECRET = "app-secret";
      axios.get
        .mockResolvedValueOnce({ data: { access_token: "SYSTEM-BUSINESS-TOKEN" } }) // code exchange
        .mockResolvedValueOnce({ data: { data: [{ id: "act_1", name: "Brand" }] } }); // listAdAccounts
      MetaOauthPending.findOneAndUpdate.mockResolvedValue({});

      const result = await service.startOauth({
        brandKey: "bbb",
        code: "auth-code",
        redirectUri: "https://app.example.com/pnl",
        updatedByEmail: "a@b.c",
      });

      expect(result).toEqual({
        success: true,
        accounts: [{ id: "act_1", name: "Brand", currency: null, accountStatus: null, accountStatusLabel: null }],
      });
      expect(axios.get.mock.calls[0][1].params).toMatchObject({
        client_id: "app-id",
        client_secret: "app-secret",
        redirect_uri: "https://app.example.com/pnl",
        code: "auth-code",
      });
      const [filter, update, options] = MetaOauthPending.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({ brand_id: "BBB" });
      expect(update.$set).toMatchObject({
        brand: "tenant-oid",
        brand_id: "BBB",
        access_token_encrypted: "enc(SYSTEM-BUSINESS-TOKEN)",
        updated_by_email: "a@b.c",
      });
      expect(options).toMatchObject({ upsert: true });
      expect(MetaAdsCredential.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test("startOauth fails without META_APP_ID/SECRET configured", async () => {
      const result = await service.startOauth({ brandKey: "BBB", code: "x", redirectUri: "https://x" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("META_APP_ID");
      expect(axios.get).not.toHaveBeenCalled();
    });

    test("startOauth surfaces Meta's rejection of the code", async () => {
      process.env.META_APP_ID = "app-id";
      process.env.META_APP_SECRET = "app-secret";
      axios.get.mockRejectedValue({ response: { data: { error: { message: "Invalid verification code format." } } } });

      const result = await service.startOauth({ brandKey: "BBB", code: "bad", redirectUri: "https://x" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid verification code format.");
      expect(MetaOauthPending.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test("startOauth fails when the login covered no ad accounts", async () => {
      process.env.META_APP_ID = "app-id";
      process.env.META_APP_SECRET = "app-secret";
      axios.get
        .mockResolvedValueOnce({ data: { access_token: "SYSTEM-BUSINESS-TOKEN" } })
        .mockResolvedValueOnce({ data: { data: [] } });

      const result = await service.startOauth({ brandKey: "BBB", code: "x", redirectUri: "https://x" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("No ad accounts were shared");
      expect(MetaOauthPending.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test("finalizeOauth reads back the parked token, verifies + persists it with token_type 'system_user', and clears the pending doc", async () => {
      MetaOauthPending.findOne.mockReturnValue(
        lean({ brand_id: "BBB", access_token_encrypted: "enc(SYSTEM-BUSINESS-TOKEN)" }),
      );
      axios.get.mockResolvedValue({ data: { id: "act_1", name: "Brand" } }); // verifyToken
      MetaAdsCredential.findOneAndUpdate.mockResolvedValue({});
      MetaOauthPending.deleteOne.mockResolvedValue({});

      const result = await service.finalizeOauth({
        brandKey: "bbb",
        adAccountIds: ["act_1"],
        updatedByEmail: "a@b.c",
      });

      expect(result).toMatchObject({ success: true });
      const [, update] = MetaAdsCredential.findOneAndUpdate.mock.calls[0];
      expect(update.$set.access_token_encrypted).toBe("enc(SYSTEM-BUSINESS-TOKEN)");
      expect(update.$set.token_type).toBe("system_user");
      expect(update.$set.token_expires_at).toBeNull();
      expect(update.$set.ad_account_ids).toEqual(["act_1"]);
      expect(MetaOauthPending.deleteOne).toHaveBeenCalledWith({ brand_id: "BBB" });
    });

    test("finalizeOauth accepts multiple ad account ids", async () => {
      MetaOauthPending.findOne.mockReturnValue(
        lean({ brand_id: "BBB", access_token_encrypted: "enc(SYSTEM-BUSINESS-TOKEN)" }),
      );
      axios.get
        .mockResolvedValueOnce({ data: { id: "act_1", name: "Brand 1" } })
        .mockResolvedValueOnce({ data: { id: "act_2", name: "Brand 2" } });
      MetaAdsCredential.findOneAndUpdate.mockResolvedValue({});
      MetaOauthPending.deleteOne.mockResolvedValue({});

      const result = await service.finalizeOauth({ brandKey: "BBB", adAccountIds: ["act_1", "act_2"] });

      expect(result).toMatchObject({ success: true });
      const [, update] = MetaAdsCredential.findOneAndUpdate.mock.calls[0];
      expect(update.$set.ad_account_ids).toEqual(["act_1", "act_2"]);
      expect(update.$set.ad_account_id).toBe("act_1");
    });

    test("finalizeOauth fails when there's no pending session for the brand", async () => {
      MetaOauthPending.findOne.mockReturnValue(lean(null));
      const result = await service.finalizeOauth({ brandKey: "BBB", adAccountIds: ["act_1"] });
      expect(result.success).toBe(false);
      expect(result.error).toContain("expired");
      expect(MetaAdsCredential.findOneAndUpdate).not.toHaveBeenCalled();
      expect(MetaOauthPending.deleteOne).not.toHaveBeenCalled();
    });

    test("finalizeOauth requires at least one ad account id", async () => {
      const result = await service.finalizeOauth({ brandKey: "BBB", adAccountIds: [] });
      expect(result).toEqual({ success: false, error: "ad_account_ids is required." });
      expect(MetaOauthPending.findOne).not.toHaveBeenCalled();
    });
  });
});
