// Same gateway contract as weekly-reports-service / daily-insights-service: the gateway signs userId|brand|role|ts
// with the shared secret. Fail closed: no secret means the request cannot be proven to come from the gateway, so it is
// rejected unless ALLOW_INSECURE_AUTH=true (local dev / tests only).
// Authorization follows the rest of Datum: the gateway puts the caller's per-brand permissions in x-permissions
// (elevated roles get "all"); a route needs `ndd_sla_panel` (or "all", or an elevated role). The brand always comes
// from the signed header and scopes every query.
const crypto = require("crypto");

const PERMISSION = "ndd_sla_panel";
const UPLOAD_PERMISSION = "ndd_sla_upload"; // manual upload of the GoKwik + EasyCom files (elevated roles always pass)
const ELEVATED = ["author", "admin", "super_admin"];
const parseList = (value) => String(value || "").split(",").map((i) => i.trim()).filter(Boolean);

function verifyGatewaySignature(req, config) {
  if (!config.gatewaySharedSecret) return config.allowInsecureAuth === true;
  const userId = req.headers["x-user-id"] || "";
  const brand = req.headers["x-brand-id"] || "";
  const role = req.headers["x-role"] || req.headers["x-user-role"] || "";
  const ts = req.headers["x-gw-ts"] || "";
  const sig = req.headers["x-gw-sig"] || "";
  if (!userId || !brand || !role || !ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = crypto.createHmac("sha256", config.gatewaySharedSecret).update([userId, brand, role, ts].join("|")).digest("hex");
  const left = Buffer.from(expected);
  const right = Buffer.from(String(sig));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function buildAuthMiddleware(config) {
  return function authMiddleware(req, res, next) {
    if (!verifyGatewaySignature(req, config)) {
      return res.status(401).json({ error: "Unauthorized", code: "INVALID_GATEWAY_SIGNATURE" });
    }
    const principal = {
      user_id: String(req.headers["x-user-id"] || ""),
      role: String(req.headers["x-role"] || req.headers["x-user-role"] || "viewer").toLowerCase(),
      permissions: parseList(req.headers["x-permissions"]),
      brand_key: String(req.headers["x-brand-id"] || "").toUpperCase(),
    };
    if (!principal.user_id || !principal.brand_key) {
      return res.status(401).json({ error: "Unauthorized", code: "MISSING_IDENTITY" });
    }
    principal.isAuthor = ELEVATED.includes(principal.role);
    req.principal = principal;
    return next();
  };
}

function requirePermission(permission) {
  return function permissionMiddleware(req, res, next) {
    const p = req.principal;
    if (!p) return res.status(401).json({ error: "Unauthorized", code: "MISSING_IDENTITY" });
    if (p.isAuthor || p.permissions.includes("all") || p.permissions.includes(permission)) return next();
    return res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
  };
}

// Strictly role-gated: no granted permission (not even "all") substitutes for an elevated role.
function requireAuthor(req, res, next) {
  const p = req.principal;
  if (!p) return res.status(401).json({ error: "Unauthorized", code: "MISSING_IDENTITY" });
  if (!p.isAuthor) return res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
  return next();
}

module.exports = { buildAuthMiddleware, verifyGatewaySignature, requirePermission, requireAuthor, PERMISSION, UPLOAD_PERMISSION };
