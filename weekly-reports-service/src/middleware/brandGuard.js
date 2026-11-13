const { httpError } = require("../errors");

// The brand is whatever the gateway signed (x-brand-id). A brand supplied anywhere else (query string or body) must
// agree with it and is never used to choose a brand. Same rule as the Weekly Reports router; kept here as a
// separate copy so that existing router is not touched.
function assertBrandInputsAgree(req) {
  const signed = req.principal.brand_key;
  const candidates = [
    req.query && req.query.brand_key,
    req.query && req.query.brand_id,
    req.body && req.body.brand_key,
    req.body && req.body.brand_id,
    req.body && req.body.brandKey,
  ];
  for (const value of candidates) {
    if (value === undefined || value === null || value === "") continue;
    if (String(value).toUpperCase() !== signed) {
      throw httpError(400, "BRAND_MISMATCH", "The brand in the request does not match the current brand.");
    }
  }
}

function brandGuard(req, _res, next) {
  try {
    assertBrandInputsAgree(req);
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { brandGuard, assertBrandInputsAgree };
