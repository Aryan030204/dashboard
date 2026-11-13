// Only Fireflies meeting links are accepted, and they are only parsed for their id (never fetched).
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFirefliesUrl } = require("../src/services/firefliesUrl");

const ID = "01HZXABCDEFGH1234567890AB";
const refused = (input) => assert.throws(() => parseFirefliesUrl(input), (err) => err.status === 400 && err.code === "INVALID_FIREFLIES_URL", `should refuse ${JSON.stringify(input)}`);

test("a normal meeting link yields its id and a clean stored URL", () => {
  const out = parseFirefliesUrl(`https://app.fireflies.ai/view/Weekly-Sync::${ID}`);
  assert.equal(out.transcriptId, ID);
  assert.equal(out.sourceUrl, `https://app.fireflies.ai/view/Weekly-Sync::${ID}`);
});

test("a link with only the id, a trailing slash, surrounding space, a query string or a fragment is accepted", () => {
  assert.equal(parseFirefliesUrl(`https://app.fireflies.ai/view/${ID}`).transcriptId, ID);
  assert.equal(parseFirefliesUrl(`https://app.fireflies.ai/view/Some-Title::${ID}/`).transcriptId, ID);
  assert.equal(parseFirefliesUrl(`   https://app.fireflies.ai/view/${ID}   `).transcriptId, ID);
  const withExtras = parseFirefliesUrl(`https://app.fireflies.ai/view/Some-Title::${ID}?utm=x&token=secret#frag`);
  assert.equal(withExtras.transcriptId, ID);
  assert.ok(!withExtras.sourceUrl.includes("token") && !withExtras.sourceUrl.includes("utm") && !withExtras.sourceUrl.includes("#"), "query and fragment are not stored");
});

test("a title that itself contains :: still yields the last part as the id", () => {
  assert.equal(parseFirefliesUrl(`https://app.fireflies.ai/view/a::b::${ID}`).transcriptId, ID);
});

test("an uppercase host is normalised and accepted (the URL parser lower-cases it)", () => {
  assert.equal(parseFirefliesUrl(`https://APP.FIREFLIES.AI/view/${ID}`).transcriptId, ID);
});

test("malformed input is refused", () => {
  for (const input of ["", "   ", "not a url", "fireflies", "https://", "://app.fireflies.ai/view/" + ID, null, undefined, 42, {}, []]) refused(input);
});

test("other hosts, look-alikes and sub-domains are refused", () => {
  for (const host of [
    "evil.com", "fireflies.ai", "www.fireflies.ai", "api.fireflies.ai", "app.fireflies.ai.evil.com", "evil.com/app.fireflies.ai",
    "app-fireflies.ai", "appxfireflies.ai", "app.fireflies.ai.", "sub.app.fireflies.ai", "app.fireflies.co",
  ]) {
    refused(`https://${host}/view/${ID}`);
  }
});

test("a non-https scheme, a port or embedded credentials are refused", () => {
  refused(`http://app.fireflies.ai/view/${ID}`);
  refused(`ftp://app.fireflies.ai/view/${ID}`);
  refused(`javascript:alert(1)//app.fireflies.ai/view/${ID}`);
  refused(`file:///etc/passwd`);
  refused(`https://app.fireflies.ai:8443/view/${ID}`);
  refused(`https://user:pass@app.fireflies.ai/view/${ID}`);
  refused(`https://app.fireflies.ai@evil.com/view/${ID}`);
});

test("arbitrary and internal URLs are refused (the server never fetches what the user sends)", () => {
  for (const url of [
    "https://example.com/", "https://evil.com/view/" + ID, "http://169.254.169.254/latest/meta-data/", "http://localhost:4040/health",
    "http://127.0.0.1/", "https://internal.service.local/view/" + ID, "gopher://app.fireflies.ai/view/" + ID,
  ]) refused(url);
});

test("a missing or malformed meeting id is refused", () => {
  refused("https://app.fireflies.ai/");
  refused("https://app.fireflies.ai/view");
  refused("https://app.fireflies.ai/view/");
  refused("https://app.fireflies.ai/view/Title::");
  refused("https://app.fireflies.ai/view/short");
  refused(`https://app.fireflies.ai/view/${"A".repeat(65)}`);
  refused(`https://app.fireflies.ai/view/Title::${ID}-with-dash`);
  refused(`https://app.fireflies.ai/view/Title::${ID}%00`);
  refused(`https://app.fireflies.ai/view/..%2F..%2Fetc%2Fpasswd`);
});

test("the wrong path is refused, including extra segments", () => {
  refused(`https://app.fireflies.ai/dashboard/${ID}`);
  refused(`https://app.fireflies.ai/view/${ID}/extra`);
  refused(`https://app.fireflies.ai/api/view/${ID}`);
  refused(`https://app.fireflies.ai/views/${ID}`);
});

test("a very long URL is refused", () => {
  refused(`https://app.fireflies.ai/view/${"a".repeat(3000)}::${ID}`);
});
