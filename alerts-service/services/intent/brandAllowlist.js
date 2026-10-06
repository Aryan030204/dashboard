// Brand allow-list for intent ingestion, read from environment variables only.
// No database access: the list is fixed at process start, so a brand change takes
// effect on the next deploy/restart.
//
//   INTENT_BRANDS_ALLOWLIST=bbb_shop,pts_shop,shyle_shop
//     Brands accepted by /track. Membership is the "active" flag: a brand that is
//     not listed is unknown or inactive and gets 400.
//
//   INTENT_BRAND_TIMEZONES=bbb_shop=Asia/Kolkata,pts_shop=Asia/Kolkata
//     IANA timezone per listed brand, used to store occurred_at in store-local time.

const BRAND_ID_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

function isValidIanaTimezone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Returns { brands: [ids], timezones: Map<id, zone>, errors: [] }. Pure function of
// the env object, so it can be tested without process.env.
function parseBrandAllowlist(env = process.env) {
  const errors = [];
  const brands = [];
  const seen = new Set();

  const rawList = (env.INTENT_BRANDS_ALLOWLIST || "").trim();
  if (!rawList) {
    errors.push("INTENT_BRANDS_ALLOWLIST is required (comma-separated brand ids, e.g. bbb_shop,pts_shop)");
  } else {
    for (const item of rawList.split(",")) {
      const id = item.trim();
      if (!id) {
        errors.push("INTENT_BRANDS_ALLOWLIST contains an empty entry");
        continue;
      }
      if (!BRAND_ID_PATTERN.test(id)) {
        errors.push(`INTENT_BRANDS_ALLOWLIST entry "${id}" is not a valid brand id`);
        continue;
      }
      if (seen.has(id)) {
        errors.push(`INTENT_BRANDS_ALLOWLIST lists "${id}" more than once`);
        continue;
      }
      seen.add(id);
      brands.push(id);
    }
  }

  const timezones = new Map();
  for (const item of (env.INTENT_BRAND_TIMEZONES || "").split(",")) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      errors.push(`INTENT_BRAND_TIMEZONES entry "${trimmed}" must be brand_id=IANA_zone`);
      continue;
    }
    const id = trimmed.slice(0, eq).trim();
    const zone = trimmed.slice(eq + 1).trim();
    if (!seen.has(id)) {
      errors.push(`INTENT_BRAND_TIMEZONES names "${id}", which is not in INTENT_BRANDS_ALLOWLIST`);
      continue;
    }
    if (!isValidIanaTimezone(zone)) {
      errors.push(`INTENT_BRAND_TIMEZONES zone "${zone}" for "${id}" is not a valid IANA timezone`);
      continue;
    }
    timezones.set(id, zone);
  }

  for (const id of brands) {
    if (!timezones.has(id)) {
      errors.push(`brand "${id}" has no timezone; add ${id}=<IANA zone> to INTENT_BRAND_TIMEZONES`);
    }
  }

  return { brands, timezones, errors };
}

// Same surface the ingestors used from the old snapshot: getBrand + isKnownBrand.
function createBrandAllowlist(env = process.env) {
  const { brands, timezones, errors } = parseBrandAllowlist(env);
  if (errors.length) {
    throw new Error(`invalid brand allow-list: ${errors.join("; ")}`);
  }
  const known = new Map(
    brands.map((id) => [id, { active: true, store_timezone_iana: timezones.get(id) }]),
  );
  return {
    getBrand: (brandId) => known.get(brandId) || null,
    isKnownBrand: (brandId) => known.has(brandId),
    listBrands: () => [...brands],
  };
}

module.exports = { parseBrandAllowlist, createBrandAllowlist };
