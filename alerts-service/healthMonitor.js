const DEFAULT_REGISTER_URL = "http://health-monitor-service:4015/register";
const DEFAULT_EVENTS_URL = "http://health-monitor-service:4015/events";
const DEFAULT_EVENT_TIMEOUT_MS = 5000;
const DEFAULT_SUCCESS_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_PAYLOAD_MAX_LENGTH = 2000;
const DEFAULT_HEADER_MAX_LENGTH = 300;
const SENSITIVE_KEY_PATTERN = /(authorization|cookie|token|password|secret|api[-_]?key|set-cookie)/i;

function getLogger(logger) {
  return logger || console;
}

function toPositiveNumber(value, fallback) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : fallback;
}

function getStack(target) {
  return target?._router?.stack || target?.router?.stack || target?.stack || [];
}

function normalizePath(pathValue) {
  const raw = Array.isArray(pathValue) ? pathValue[0] : pathValue;
  if (!raw) return "/";
  const normalized = String(raw).trim();
  if (!normalized) return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function joinPaths(basePath, routePath) {
  const base = normalizePath(basePath);
  const route = normalizePath(routePath);
  if (base === "/") return route;
  if (route === "/") return base;
  return `${base.replace(/\/$/, "")}${route}`.replace(/\/{2,}/g, "/");
}

function cleanNames(names) {
  return [...new Set(
    (names || [])
      .map((name) => String(name || "").trim())
      .filter((name) => name && name !== "<anonymous>" && name !== "anonymous"),
  )];
}

function inferAuthRequired(middlewareNames) {
  return middlewareNames.some((name) => /(auth|author|permission|trusted|apikey|gateway)/i.test(name));
}

function inferRouteType(method, path, authRequired) {
  if (path === "/health") return "health";
  if (path === "/health/monitor") return "probe";
  if (path.includes("/metrics")) return "internal_only";
  if (authRequired) return "auth";
  return method === "GET" ? "read" : "mutating";
}

function inferMonitoringRecommendation(method, path, authRequired) {
  if (path === "/health" || path === "/health/monitor") {
    return "direct_health_candidate";
  }
  if (authRequired || method !== "GET") {
    return "probe_only";
  }
  return "manual_review";
}

function inferSuccessHint(method, path) {
  if (path === "/health" || path === "/health/monitor") {
    return "2xx";
  }
  return method === "GET" ? "2xx_candidate" : "manual_review";
}

function collectRoutes(target, {
  mountPath = "/",
  sourceModule = "",
  mountMiddlewareNames = [],
} = {}) {
  const discovered = new Map();

  for (const layer of getStack(target)) {
    if (!layer?.route?.path) {
      continue;
    }

    const path = joinPaths(mountPath, layer.route.path);
    const middlewareNames = cleanNames([
      ...mountMiddlewareNames,
      ...layer.route.stack.map((entry) => entry.name),
    ]);
    const authRequired = inferAuthRequired(middlewareNames);
    const controllerHint = middlewareNames[middlewareNames.length - 1] || "";

    for (const method of Object.keys(layer.route.methods || {})) {
      if (!layer.route.methods[method]) continue;
      const normalizedMethod = method.toUpperCase();
      const key = `${normalizedMethod} ${path}`;
      discovered.set(key, {
        path,
        method: normalizedMethod,
        sourceModule,
        controllerHint,
        middlewareNames,
        hasPathParams: path.includes("/:"),
        routeType: inferRouteType(normalizedMethod, path, authRequired),
        authRequired,
        authInference: middlewareNames.length ? "inferred" : "unknown",
        monitoringRecommendation: inferMonitoringRecommendation(normalizedMethod, path, authRequired),
        successHint: inferSuccessHint(normalizedMethod, path),
      });
    }
  }

  return [...discovered.values()];
}

function truncate(value, maxLength) {
  const text = String(value ?? "");
  if (!maxLength || text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function redactValue(value, maxLength) {
  if (value == null) return value;
  if (typeof value === "string") return truncate(value, maxLength);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 25).map((entry) => redactValue(entry, maxLength));
  if (Buffer.isBuffer(value)) return `[buffer:${value.length}]`;
  if (typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : redactValue(entry, maxLength);
    }
    return result;
  }
  return truncate(value, maxLength);
}

function sanitizeHeaders(headers, maxLength) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : truncate(Array.isArray(value) ? value.join(",") : value, maxLength);
  }
  return result;
}

function extractRoutePath(req) {
  const routePath = req.route?.path;
  if (routePath) {
    return joinPaths(req.baseUrl || "/", routePath);
  }

  return normalizePath(req.path || req.originalUrl || "/");
}

function buildCorrelationId(req) {
  return String(req.headers["x-request-id"] || req.headers["x-correlation-id"] || "").trim();
}

function buildRequestContext(req, maxLength) {
  return {
    headers: sanitizeHeaders(req.headers || {}, maxLength),
    params: redactValue(req.params || {}, maxLength),
    query: redactValue(req.query || {}, maxLength),
    body: redactValue(req.body, maxLength),
    ip: req.ip || "",
    userAgent: truncate(req.headers["user-agent"], maxLength),
  };
}

function detectMessage(body, fallback) {
  if (body && typeof body === "object") {
    return truncate(body.message || body.error || body.functionalMessage || fallback || "", DEFAULT_PAYLOAD_MAX_LENGTH);
  }
  return truncate(body || fallback || "", DEFAULT_PAYLOAD_MAX_LENGTH);
}

function detectErrorCode(body) {
  if (body && typeof body === "object") {
    return String(body.errorCode || body.code || body.error || "").trim();
  }
  return "";
}

function detectErrorType(body, statusCode) {
  if (body && typeof body === "object") {
    return String(body.errorType || body.type || "").trim();
  }
  return statusCode >= 500 ? "application_error" : "client_error";
}

// A failing endpoint turns every request into one more outbound call. Cap how many are in
// flight so a burst of errors cannot fill the process's connection and DNS capacity.
const MAX_IN_FLIGHT_POSTS = 5;
let inFlightPosts = 0;

function postJson(url, payload, timeoutMs, logger, logKey) {
  if (inFlightPosts >= MAX_IN_FLIGHT_POSTS) return;
  inFlightPosts += 1;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal:
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(timeoutMs)
        : undefined,
  }).catch((error) => {
    logger.warn?.(`[health-monitor] ${logKey} skipped`, { error: error.message });
  }).finally(() => {
    inFlightPosts -= 1;
  });
}

function createHealthMonitorReporter({ serviceName, baseUrl, logger }) {
  const log = getLogger(logger);
  const eventsUrl = process.env.HEALTH_MONITOR_EVENTS_URL || DEFAULT_EVENTS_URL;
  const eventTimeoutMs = toPositiveNumber(
    process.env.HEALTH_MONITOR_EVENT_TIMEOUT_MS,
    DEFAULT_EVENT_TIMEOUT_MS,
  );
  const successCacheTtlMs = toPositiveNumber(
    process.env.HEALTH_MONITOR_SUCCESS_CACHE_TTL_MS,
    DEFAULT_SUCCESS_CACHE_TTL_MS,
  );
  const payloadMaxLength = toPositiveNumber(
    process.env.HEALTH_MONITOR_EVENT_PAYLOAD_MAX_LENGTH,
    DEFAULT_PAYLOAD_MAX_LENGTH,
  );
  const headerMaxLength = toPositiveNumber(
    process.env.HEALTH_MONITOR_EVENT_HEADER_VALUE_MAX_LENGTH,
    DEFAULT_HEADER_MAX_LENGTH,
  );
  const recentFailures = new Map();
  // One failure event per route and status code every FAILURE_POST_INTERVAL_MS. Without
  // this, a route that fails 5 times a second sends 5 events a second.
  const FAILURE_POST_INTERVAL_MS = 30000;
  const lastFailurePost = new Map();

  function hasRecentFailure(key) {
    const expiresAt = recentFailures.get(key);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      recentFailures.delete(key);
      return false;
    }
    return true;
  }

  function markRecentFailure(key) {
    recentFailures.set(key, Date.now() + successCacheTtlMs);
  }

  return function healthMonitorReporter(req, res, next) {
    const startedAt = Date.now();
    let responseBody;
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    res.json = (body) => {
      responseBody = body;
      return originalJson(body);
    };

    res.send = (body) => {
      if (responseBody === undefined) {
        responseBody = body;
      }
      return originalSend(body);
    };

    res.on("finish", () => {
      const normalizedPath = extractRoutePath(req);
      if (req.method === "OPTIONS") return;
      if (normalizedPath === "/health" || normalizedPath === "/health/monitor") return;
      if (res.statusCode === 404 && !req.route) return;

      const method = String(req.method || "GET").toUpperCase();
      const routeKey = `${method} ${normalizedPath}`;
      const latency = Date.now() - startedAt;

      if (res.statusCode >= 400) {
        const sanitizedBody = redactValue(responseBody, payloadMaxLength);
        markRecentFailure(routeKey);
        const failureKey = `${routeKey}|${res.statusCode}`;
        const lastPost = lastFailurePost.get(failureKey) || 0;
        if (Date.now() - lastPost < FAILURE_POST_INTERVAL_MS) return;
        lastFailurePost.set(failureKey, Date.now());
        postJson(`${eventsUrl}/failures`, {
          serviceName,
          baseUrl,
          method,
          path: normalizePath(req.path || normalizedPath),
          normalizedPath,
          statusCode: res.statusCode,
          errorCode: detectErrorCode(sanitizedBody),
          errorType: detectErrorType(sanitizedBody, res.statusCode),
          message: detectMessage(sanitizedBody, res.statusMessage),
          responseBody: sanitizedBody,
          responseHeaders: sanitizeHeaders(
            typeof res.getHeaders === "function" ? res.getHeaders() : {},
            headerMaxLength,
          ),
          latency,
          requestContext: buildRequestContext(req, payloadMaxLength),
          correlationId: buildCorrelationId(req),
          timestamp: new Date().toISOString(),
        }, eventTimeoutMs, log, "failure event");
        return;
      }

      if (res.statusCode >= 200 && res.statusCode < 300 && hasRecentFailure(routeKey)) {
        recentFailures.delete(routeKey);
        postJson(`${eventsUrl}/successes`, {
          serviceName,
          baseUrl,
          method,
          path: normalizePath(req.path || normalizedPath),
          normalizedPath,
          statusCode: res.statusCode,
          message: "route_recovered",
          latency,
          requestContext: {
            params: redactValue(req.params || {}, payloadMaxLength),
            query: redactValue(req.query || {}, payloadMaxLength),
          },
          correlationId: buildCorrelationId(req),
          timestamp: new Date().toISOString(),
        }, eventTimeoutMs, log, "success event");
      }
    });

    next();
  };
}

async function registerWithHealthMonitor(payload, logger = console) {
  const log = getLogger(logger);
  const registerUrl = process.env.HEALTH_MONITOR_REGISTER_URL || DEFAULT_REGISTER_URL;
  try {
    const response = await fetch(registerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal:
        typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(5000)
          : undefined,
    });
    const text = await response.text();
    if (!response.ok) {
      log.warn?.("[health-monitor] registration failed", { status: response.status, body: text });
      return false;
    }
    log.info?.("[health-monitor] registration complete", { body: text });
    return true;
  } catch (error) {
    log.warn?.("[health-monitor] registration skipped", { error: error.message });
    return false;
  }
}

module.exports = {
  collectRoutes,
  createHealthMonitorReporter,
  registerWithHealthMonitor,
};
