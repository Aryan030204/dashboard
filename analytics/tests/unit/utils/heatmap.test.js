/* eslint-env jest */

const {
  DEVICES,
  DEVICE_CASE_SQL,
  MAX_PATH_LENGTH,
  deviceFromUserAgent,
  escapeLike,
  normalizePagePath,
} = require("../../../shared/utils/heatmap");

describe("normalizePagePath", () => {
  test("strips scheme, host, query string and hash", () => {
    expect(normalizePagePath("https://blabliblulife.com/products/build-your-small-own-box?utm_source=facebook&fbclid=abc#reviews")).toBe(
      "/products/build-your-small-own-box",
    );
    expect(normalizePagePath("http://shop.example.com:8080/collections/all?page=2")).toBe("/collections/all");
  });

  test("the home page is '/', with or without query parameters", () => {
    expect(normalizePagePath("https://blabliblulife.com/")).toBe("/");
    expect(normalizePagePath("https://blabliblulife.com")).toBe("/");
    expect(normalizePagePath("https://blabliblulife.com/?utm_source=google")).toBe("/");
    expect(normalizePagePath("/")).toBe("/");
  });

  test("matches the format the click rollup uses: lowercase, no trailing or duplicate slashes", () => {
    expect(normalizePagePath("/Collections/All/")).toBe("/collections/all");
    expect(normalizePagePath("//collections//all")).toBe("/collections/all");
    expect(normalizePagePath("/account///")).toBe("/account");
  });

  test("accepts a bare path and adds the leading slash", () => {
    expect(normalizePagePath("/products/love-drunk-perfume?variant=50151101694247")).toBe("/products/love-drunk-perfume");
    expect(normalizePagePath("products/x")).toBe("/products/x");
  });

  test("empty or unusable input is an empty string, and over-long paths are rejected", () => {
    expect(normalizePagePath("")).toBe("");
    expect(normalizePagePath(null)).toBe("");
    expect(normalizePagePath(undefined)).toBe("");
    expect(normalizePagePath(`/${"a".repeat(MAX_PATH_LENGTH)}`)).toBe("");
    expect(normalizePagePath(`/${"a".repeat(MAX_PATH_LENGTH - 1)}`)).toHaveLength(MAX_PATH_LENGTH);
  });

  test("encoded characters are kept as they are", () => {
    expect(normalizePagePath("/pages/caf%C3%A9?x=1")).toBe("/pages/caf%c3%a9");
  });
});

describe("deviceFromUserAgent", () => {
  test("phones, tablets and desktops", () => {
    expect(
      deviceFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)"),
    ).toBe("mobile");
    expect(deviceFromUserAgent("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/155.0 Mobile Safari/537.36")).toBe("mobile");
    expect(deviceFromUserAgent("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15")).toBe("tablet");
    expect(deviceFromUserAgent("Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120.0 Safari/537.36")).toBe("tablet");
    expect(deviceFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36")).toBe("desktop");
    expect(deviceFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("desktop");
  });

  test("missing user agent counts as desktop and the buckets are the three the UI offers", () => {
    expect(deviceFromUserAgent(null)).toBe("desktop");
    expect(deviceFromUserAgent("")).toBe("desktop");
    expect(DEVICES).toEqual(["desktop", "mobile", "tablet"]);
  });

  test("the SQL version covers the same cases as the JavaScript one", () => {
    expect(DEVICE_CASE_SQL).toContain("'%iPad%'");
    expect(DEVICE_CASE_SQL).toContain("'%Tablet%'");
    expect(DEVICE_CASE_SQL).toContain("'%Android%' AND user_agent NOT LIKE '%Mobile%'");
    expect(DEVICE_CASE_SQL).toContain("'%iPhone%'");
    expect(DEVICE_CASE_SQL).toContain("ELSE 'desktop'");
  });
});

describe("escapeLike", () => {
  test("wildcards in a search are literal", () => {
    expect(escapeLike("50%_off")).toBe("50\\%\\_off");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    expect(escapeLike(null)).toBe("");
  });
});
