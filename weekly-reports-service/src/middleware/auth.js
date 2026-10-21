const crypto = require("crypto");

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// Same contract as daily-insights-service: the gateway signs userId|brand|role|ts with the
// shared secret. Fail closed: no secret means we cannot prove the request came from the
// gateway, so reject, unless insecure auth is explicitly opted into (local dev / tests only).
function verifyGatewaySignature(req, config) {
  if (!config.gatewaySharedSecret) return config.allowInsecureAuth === true;
  const userId = req.headers["x-user-id"] || "";
  const brand = req.headers["x-brand-id"] || "";
  const role = req.headers["x-role"] || req.headers["x-user-role"] || "";
  const ts = req.headers["x-gw-ts"] || "";
  const sig = req.headers["x-gw-sig"] || "";
  if (!userId || !brand || !role || !ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const payload = [userId, brand, role, ts].join("|");
  const expected = crypto.createHmac("sha256", config.gatewaySharedSecret).update(payload).digest("hex");
  const left = Buffer.from(expected);
  const right = Buffer.from(String(sig));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function principalFromGatewayHeaders(req) {
  const role = String(req.headers["x-role"] || req.headers["x-user-role"] || "viewer").toLowerCase();
  return {
    user_id: String(req.headers["x-user-id"] || ""),
    email: String(req.headers["x-email"] || ""),
    role,
    isAuthor: ["author", "admin", "super_admin"].includes(role),
    brand_key: String(req.headers["x-brand-id"] || "").toUpperCase(),
    permissions: parseList(req.headers["x-permissions"]),
  };
}

function buildAuthMiddleware(config) {
  return function authMiddleware(req, res, next) {
    if (!verifyGatewaySignature(req, config)) {
      return res.status(401).json({ error: "Unauthorized", code: "INVALID_GATEWAY_SIGNATURE" });
    }
    const principal = principalFromGatewayHeaders(req);
    if (!principal.user_id || !principal.brand_key) {
      return res.status(401).json({ error: "Unauthorized", code: "MISSING_IDENTITY" });
    }
    req.principal = principal;
    return next();
  };
}

function requirePermission(permission) {
  return function permissionMiddleware(req, res, next) {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: "Unauthorized", code: "MISSING_IDENTITY" });
    if (principal.isAuthor || principal.permissions.includes("all") || principal.permissions.includes(permission)) {
      return next();
    }
    return res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
  };
}

// Strictly role-gated: no granted permission (including "all") can substitute for this.
// Manage actions (upload, publish, unpublish, delete, history) are never delegable to clients.
function requireAuthor(req, res, next) {
  const principal = req.principal;
  if (!principal) return res.status(401).json({ error: "Unauthorized", code: "MISSING_IDENTITY" });
  if (!principal.isAuthor) return res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
  return next();
}

module.exports = {
  buildAuthMiddleware,
  principalFromGatewayHeaders,
  verifyGatewaySignature,
  requirePermission,
  requireAuthor,
};
