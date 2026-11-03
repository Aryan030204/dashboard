// One logger for the whole service, so a single upload can be followed from the browser request to the last
// slide in the bucket by grepping `docker logs` for its report id (or request id).
//
// A line looks like:
//   2026-11-03T13:46:08.123Z INFO  [worker.convert] soffice finished {"report":26,"exit":0,"ms":41230}
//
// Levels: debug < info < warn < error. WEEKLY_REPORTS_LOG_LEVEL picks the lowest one that is written
// (default info; "debug" adds per-object S3 calls and per-poll noise; "silent" writes nothing, which is the
// default under `node --test`). Never pass secrets, tokens or request headers in the fields.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const MAX_STRING = 2000;
const STACK_LINES = 8;

function currentLevel() {
  const wanted = String(process.env.WEEKLY_REPORTS_LOG_LEVEL || "").trim().toLowerCase();
  if (LEVELS[wanted]) return LEVELS[wanted];
  return process.env.NODE_TEST_CONTEXT ? LEVELS.silent : LEVELS.info;
}

function clip(value, max = MAX_STRING) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}... (${text.length - max} more characters)` : text;
}

// Everything useful about a failure, in a form that survives JSON: type, code, HTTP/errno/syscall (Node and AWS
// errors carry these), the message, a short stack, and the underlying cause.
function describeError(err) {
  if (err === null || err === undefined) return { message: "unknown error" };
  if (typeof err !== "object") return { message: clip(err) };
  const out = { name: err.name, message: clip(err.message || String(err)) };
  for (const key of ["code", "status", "statusCode", "errno", "syscall", "path"]) {
    if (err[key] !== undefined && err[key] !== null) out[key] = err[key];
  }
  if (err.$metadata) {
    out.aws = {
      httpStatus: err.$metadata.httpStatusCode,
      requestId: err.$metadata.requestId,
      attempts: err.$metadata.attempts,
    };
  }
  if (err.sqlMessage) out.sql = clip(err.sqlMessage, 500); // MySQL: the server's own message, never the query values
  if (err.stack) out.stack = String(err.stack).split("\n").slice(0, STACK_LINES).map((l) => l.trim());
  if (err.cause) out.cause = describeError(err.cause);
  return out;
}

function prepare(fields) {
  if (!fields) return "";
  const copy = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (key === "err" || key === "error") copy.error = value instanceof Error || (value && value.message) ? describeError(value) : value;
    else if (typeof value === "string") copy[key] = clip(value);
    else copy[key] = value;
  }
  try {
    return ` ${JSON.stringify(copy)}`;
  } catch (_) {
    return " {\"fields\":\"not serialisable\"}";
  }
}

function createLogger(scope, { sink = console } = {}) {
  const write = (level, method) => (message, fields) => {
    if (LEVELS[level] < currentLevel()) return;
    sink[method](`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${prepare(fields)}`);
  };
  const logger = {
    debug: write("debug", "log"),
    info: write("info", "log"),
    warn: write("warn", "warn"),
    error: write("error", "error"),
    // A logger for a sub-area that keeps the same sink: createLogger("worker").child("convert") -> [worker.convert]
    child: (name) => createLogger(`${scope}.${name}`, { sink }),
  };
  return logger;
}

// Accepts whatever a caller or test injected (any subset of debug/info/warn/error, or nothing) and always
// returns something safe to call.
function ensureLogger(candidate, scope = "weekly-reports") {
  if (candidate && ["debug", "info", "warn", "error"].every((m) => typeof candidate[m] === "function") && typeof candidate.child === "function") {
    return candidate;
  }
  if (!candidate) return createLogger(scope);
  const noop = () => {};
  const pick = (m) => (typeof candidate[m] === "function" ? (message, fields) => candidate[m](message, fields) : noop);
  const wrapped = { debug: pick("debug"), info: pick("info"), warn: pick("warn"), error: pick("error") };
  wrapped.child = () => wrapped;
  return wrapped;
}

// Milliseconds since this was called.
function stopwatch() {
  const started = Date.now();
  return () => Date.now() - started;
}

module.exports = { createLogger, ensureLogger, describeError, stopwatch, clip };
