// AES-256-CBC for the stored Fireflies API key.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createAesCbc, CredentialCryptoError, ALGORITHM_LABEL } = require("../src/services/aesCbc");
const { TEST_AES_KEY } = require("./meetingHelpers");

const SECRET = "ff-live-key-0123456789-SECRET";
const OTHER_KEY = crypto.randomBytes(32).toString("hex");

test("encrypt then decrypt returns the original value", () => {
  const aes = createAesCbc(TEST_AES_KEY);
  const { ciphertext, iv } = aes.encrypt(SECRET);
  assert.equal(aes.decrypt(ciphertext, iv), SECRET);
  assert.equal(aes.algorithm, "AES-256-CBC");
  assert.equal(ALGORITHM_LABEL, "AES-256-CBC");
});

test("the ciphertext does not contain the plaintext and the IV is 16 random bytes", () => {
  const aes = createAesCbc(TEST_AES_KEY);
  const { ciphertext, iv } = aes.encrypt(SECRET);
  assert.ok(!ciphertext.includes(SECRET));
  assert.ok(!Buffer.from(ciphertext, "base64").toString("latin1").includes(SECRET));
  assert.equal(Buffer.from(iv, "base64").length, 16);
});

test("every encryption uses a different IV and produces a different ciphertext", () => {
  const aes = createAesCbc(TEST_AES_KEY);
  const a = aes.encrypt(SECRET);
  const b = aes.encrypt(SECRET);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
  const ivs = new Set(Array.from({ length: 50 }, () => aes.encrypt(SECRET).iv));
  assert.equal(ivs.size, 50);
});

test("the IV is required to decrypt: a different IV does not give the original value back", () => {
  const aes = createAesCbc(TEST_AES_KEY);
  const { ciphertext } = aes.encrypt(SECRET);
  const wrongIv = crypto.randomBytes(16).toString("base64");
  let result = null;
  try {
    result = aes.decrypt(ciphertext, wrongIv);
  } catch (err) {
    assert.ok(err instanceof CredentialCryptoError);
  }
  assert.notEqual(result, SECRET);
});

test("a wrong key fails safely and never returns the original value", () => {
  const { ciphertext, iv } = createAesCbc(TEST_AES_KEY).encrypt(SECRET);
  let result = null;
  try {
    result = createAesCbc(OTHER_KEY).decrypt(ciphertext, iv);
  } catch (err) {
    assert.ok(err instanceof CredentialCryptoError);
    assert.equal(err.code, "DECRYPT_FAILED");
  }
  assert.notEqual(result, SECRET);
});

test("invalid ciphertext or IV is rejected with a generic error that echoes nothing", () => {
  const aes = createAesCbc(TEST_AES_KEY);
  const { ciphertext, iv } = aes.encrypt(SECRET);
  const bad = [
    [ciphertext.slice(0, 10), iv], // not a whole number of blocks
    ["!!!not-base64!!!", iv],
    [ciphertext, "AAAA"], // IV of the wrong length
    [ciphertext, ""],
    ["", iv],
    [null, iv],
    [undefined, undefined],
  ];
  for (const [c, i] of bad) {
    assert.throws(
      () => aes.decrypt(c, i),
      (err) => err instanceof CredentialCryptoError && err.code === "DECRYPT_FAILED" && !String(err.message).includes(SECRET) && !String(err.message).includes(TEST_AES_KEY),
    );
  }
});

test("only a 32-byte key is accepted (64 hex characters or base64), nothing is padded or truncated", () => {
  const raw = crypto.randomBytes(32);
  assert.doesNotThrow(() => createAesCbc(raw.toString("hex")));
  const fromBase64 = createAesCbc(raw.toString("base64"));
  const fromHex = createAesCbc(raw.toString("hex"));
  const sealed = fromHex.encrypt(SECRET);
  assert.equal(fromBase64.decrypt(sealed.ciphertext, sealed.iv), SECRET, "hex and base64 spellings are the same key");

  for (const bad of ["", "   ", undefined, null, "short", "a".repeat(63), "a".repeat(65), "g".repeat(64), "x".repeat(32), crypto.randomBytes(16).toString("hex"), crypto.randomBytes(16).toString("base64")]) {
    assert.throws(() => createAesCbc(bad), (err) => err instanceof CredentialCryptoError && ["KEY_MISSING", "KEY_INVALID"].includes(err.code), `should reject ${JSON.stringify(bad)}`);
  }
});

test("error messages never contain the key", () => {
  try {
    createAesCbc("zzzz-not-a-valid-key");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(!String(err.message).includes("zzzz-not-a-valid-key"));
  }
});

test("an empty or non-text plaintext is refused", () => {
  const aes = createAesCbc(TEST_AES_KEY);
  for (const bad of ["", null, undefined, 123, {}]) assert.throws(() => aes.encrypt(bad), CredentialCryptoError);
});

test("the cipher really is AES-256-CBC (matches Node's own implementation)", () => {
  const aes = createAesCbc(TEST_AES_KEY);
  const { ciphertext, iv } = aes.encrypt(SECRET);
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(TEST_AES_KEY, "hex"), Buffer.from(iv, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  assert.equal(plain, SECRET);
});
