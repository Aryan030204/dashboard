const mysql = require("mysql2/promise");

function createPool(config) {
  const { host, port, user, password, database, connectionLimit } = config.db;
  if (!host || !user || !database) {
    throw new Error("weekly-reports: WR_DB_HOST, WR_DB_USER and WR_DB_NAME must be set");
  }
  return mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    connectionLimit,
    waitForConnections: true,
    // Store and read UTC; the app formats dates for display.
    timezone: "Z",
    dateStrings: false,
  });
}

module.exports = { createPool };
