const mysql = require("mysql2/promise");

// dateStrings: true is deliberate. DATE/DATETIME columns come back as the literal strings stored ("2026-11-19",
// "2026-11-19 12:00:00"): order_at and the windows are wall-clock values in the report timezone and must never be
// shifted by a driver timezone conversion. UTC columns (locked_at, created_at...) are written with UTC_TIMESTAMP().
function createPool(config) {
  const { host, port, user, password, database, connectionLimit } = config.db;
  if (!host || !user || !database) {
    throw new Error("ndd-sla: NDD_DB_HOST, NDD_DB_USER and NDD_DB_NAME must be set");
  }
  return mysql.createPool({
    host, port, user, password, database, connectionLimit,
    waitForConnections: true,
    timezone: "Z",
    dateStrings: true,
  });
}

module.exports = { createPool };
