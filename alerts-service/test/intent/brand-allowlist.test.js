const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseBrandAllowlist, createBrandAllowlist } = require('../../services/intent/brandAllowlist');

const ENV = {
  INTENT_BRANDS_ALLOWLIST: 'bbb_shop,pts_shop,shyle_shop',
  INTENT_BRAND_TIMEZONES: 'bbb_shop=Asia/Kolkata,pts_shop=Asia/Kolkata,shyle_shop=Asia/Kolkata',
};

test('a listed brand is known and active, with its timezone', () => {
  const allow = createBrandAllowlist(ENV);
  assert.equal(allow.isKnownBrand('bbb_shop'), true);
  assert.deepEqual(allow.getBrand('bbb_shop'), { active: true, store_timezone_iana: 'Asia/Kolkata' });
  assert.deepEqual(allow.listBrands(), ['bbb_shop', 'pts_shop', 'shyle_shop']);
});

test('an unknown brand is rejected', () => {
  const allow = createBrandAllowlist(ENV);
  assert.equal(allow.isKnownBrand('unknown_shop'), false);
  assert.equal(allow.getBrand('unknown_shop'), null);
});

test('an inactive brand is rejected: a brand removed from the list is no longer accepted', () => {
  const allow = createBrandAllowlist({
    INTENT_BRANDS_ALLOWLIST: 'bbb_shop,pts_shop',
    INTENT_BRAND_TIMEZONES: 'bbb_shop=Asia/Kolkata,pts_shop=Asia/Kolkata',
  });
  assert.equal(allow.isKnownBrand('shyle_shop'), false);
  assert.equal(allow.isKnownBrand('bbb_shop'), true);
});

test('brand ids are matched exactly, not by prefix or case', () => {
  const allow = createBrandAllowlist(ENV);
  assert.equal(allow.isKnownBrand('bbb'), false);
  assert.equal(allow.isKnownBrand('BBB_SHOP'), false);
  assert.equal(allow.isKnownBrand('bbb_shop_extra'), false);
});

test('whitespace around entries is ignored', () => {
  const allow = createBrandAllowlist({
    INTENT_BRANDS_ALLOWLIST: ' bbb_shop , pts_shop ',
    INTENT_BRAND_TIMEZONES: ' bbb_shop = Asia/Kolkata , pts_shop=Asia/Kolkata ',
  });
  assert.deepEqual(allow.listBrands(), ['bbb_shop', 'pts_shop']);
  assert.equal(allow.getBrand('pts_shop')?.store_timezone_iana, 'Asia/Kolkata');
});

test('a missing allow-list fails with a clear message', () => {
  const { errors } = parseBrandAllowlist({ INTENT_BRAND_TIMEZONES: 'bbb_shop=Asia/Kolkata' });
  assert.ok(errors.some((e) => e.includes('INTENT_BRANDS_ALLOWLIST is required')));
  assert.throws(() => createBrandAllowlist({}), /invalid brand allow-list/);
});

test('a listed brand without a timezone fails at startup', () => {
  const { errors } = parseBrandAllowlist({
    INTENT_BRANDS_ALLOWLIST: 'bbb_shop,pts_shop',
    INTENT_BRAND_TIMEZONES: 'bbb_shop=Asia/Kolkata',
  });
  assert.ok(errors.some((e) => e.includes('brand "pts_shop" has no timezone')));
});

test('an invalid IANA timezone fails at startup', () => {
  const { errors } = parseBrandAllowlist({
    INTENT_BRANDS_ALLOWLIST: 'bbb_shop',
    INTENT_BRAND_TIMEZONES: 'bbb_shop=Mars/Olympus',
  });
  assert.ok(errors.some((e) => e.includes('not a valid IANA timezone')));
});

test('a timezone for a brand not in the allow-list fails', () => {
  const { errors } = parseBrandAllowlist({
    INTENT_BRANDS_ALLOWLIST: 'bbb_shop',
    INTENT_BRAND_TIMEZONES: 'bbb_shop=Asia/Kolkata,ghost_shop=Asia/Kolkata',
  });
  assert.ok(errors.some((e) => e.includes('"ghost_shop", which is not in INTENT_BRANDS_ALLOWLIST')));
});

test('duplicate and malformed entries fail', () => {
  const dup = parseBrandAllowlist({ INTENT_BRANDS_ALLOWLIST: 'bbb_shop,bbb_shop', INTENT_BRAND_TIMEZONES: 'bbb_shop=Asia/Kolkata' });
  assert.ok(dup.errors.some((e) => e.includes('more than once')));

  const bad = parseBrandAllowlist({ INTENT_BRANDS_ALLOWLIST: 'bbb shop', INTENT_BRAND_TIMEZONES: '' });
  assert.ok(bad.errors.some((e) => e.includes('not a valid brand id')));

  const empty = parseBrandAllowlist({ INTENT_BRANDS_ALLOWLIST: 'bbb_shop,,pts_shop', INTENT_BRAND_TIMEZONES: 'bbb_shop=Asia/Kolkata,pts_shop=Asia/Kolkata' });
  assert.ok(empty.errors.some((e) => e.includes('empty entry')));
});

test('the allow-list module does not touch Mongo or any database', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'services', 'intent', 'brandAllowlist.js'),
    'utf8',
  );
  assert.equal(/mongoose|require\(['"]\.\.?\/.*models|PipelineCreds|arch-auth/.test(source), false);
});
