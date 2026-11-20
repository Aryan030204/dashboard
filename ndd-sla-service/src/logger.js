// Same line format as weekly-reports-service. Never pass tokens, credentials or headers in the fields.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function currentLevel() {
  const wanted = String(process.env.NDD_SLA_LOG_LEVEL || "").trim().toLowerCase();
  if (LEVELS[wanted]) return LEVELS[wanted];
  return process.env.NODE_TEST_CONTEXT ? LEVELS.silent : LEVELS.info;
}

function describeError(err) {
  if (err === null || err === undefined) return { message: "unknown error" };
  if (typeof err !== "object") return { message: String(err).slice(0, 2000) };
  const out = { name: err.name, message: String(err.message || err).slice(0, 2000) };
  for (const key of ["code", "status", "errno", "syscall"]) if (err[key] != null) out[key] = err[key];
  if (err.sqlMessage) out.sql = String(err.sqlMessage).slice(0, 500);
  if (err.stack) out.stack = String(err.stack).split("\n").slice(0, 6).map((l) => l.trim());
  return out;
}

function createLogger(scope, { sink = console } = {}) {
  const write = (level, method) => (message, fields) => {
    if (LEVELS[level] < currentLevel()) return;
    let extra = "";
    if (fields) {
      const copy = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        copy[k] = k === "error" || k === "err" ? describeError(v) : v;
      }
      try {
        extra = ` ${JSON.stringify(copy)}`;
      } catch (_) {
        extra = ' {"fields":"not serialisable"}';
      }
    }
    sink[method](`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${extra}`);
  };
  return {
    debug: write("debug", "log"),
    info: write("info", "log"),
    warn: write("warn", "warn"),
    error: write("error", "error"),
    child: (name) => createLogger(`${scope}.${name}`, { sink }),
  };
}

function ensureLogger(candidate, scope = "ndd-sla") {
  if (candidate && ["debug", "info", "warn", "error", "child"].every((m) => typeof candidate[m] === "function")) return candidate;
  return createLogger(scope);
}

module.exports = { createLogger, ensureLogger, describeError };
