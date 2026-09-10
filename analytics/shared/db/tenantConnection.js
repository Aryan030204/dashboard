// Canonical location. Moved from lib/tenantConnection.js
// lib/tenantConnection.js now re-exports from here.

const mysql = require('mysql2/promise');
const mysqlCore = require('mysql2');
const { QueryTypes } = require('sequelize');
const { recordMysqlConnectionError, captureError } = require('../../observability');

const POOL_MAX = Number(process.env.BRAND_POOL_MAX || 15);
const POOL_IDLE = Number(process.env.BRAND_POOL_IDLE || 600_000);
const POOL_MIN = Number(process.env.BRAND_POOL_MIN || 1);

const pools = new Map();
let closed = false;

function poolKey({ host, port, user }) {
  return `${host}:${port || 3306}:${user || ''}`;
}

function formatSql(sql, replacements) {
  if (!replacements) return sql;
  return mysqlCore.format(sql, replacements);
}

function ensurePool(route) {
  if (closed) throw new Error('tenant pools closed');
  const key = poolKey(route);
  if (pools.has(key)) return pools.get(key);

  const pool = mysql.createPool({
    host: route.host,
    port: route.port || 3306,
    user: route.user,
    password: route.password,
    waitForConnections: true,
    connectionLimit: POOL_MAX,
    maxIdle: POOL_MIN,
    idleTimeout: POOL_IDLE,
    queueLimit: 0,
    enableKeepAlive: true,
    timezone: 'Z',
    dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });

  pools.set(key, pool);
  return pool;
}

async function runQuery(pool, route, sql, options = {}) {
  let conn;
  try {
    conn = await pool.getConnection();
  } catch (err) {
    recordMysqlConnectionError(route.brandId || route.dbName || 'unknown');
    captureError(err, null, {
      type: 'mysql_connection',
      brand: route.brandId || route.dbName || 'unknown',
    });
    throw err;
  }
  try {
    if (route.dbName) {
      await conn.query('USE ??', [route.dbName]);
    }
    const finalSql = options.replacements ? formatSql(sql, options.replacements) : sql;
    const [rows] = await conn.query(finalSql);
    if (options.type === QueryTypes.SELECT) return rows;
    return rows;
  } finally {
    conn.release();
  }
}

function getTenantConnection(route) {
  const pool = ensurePool(route);
  return {
    key: route.brandId,
    dbName: route.dbName,
    sequelize: {
      // Brand identity, so downstream services can namespace per-brand caches
      // from the bare connection object they are handed.
      dbName: route.dbName,
      brandId: route.brandId,
      query: (sql, options = {}) => runQuery(pool, route, sql, options),
      authenticate: async () => {
        await runQuery(pool, route, 'SELECT 1');
        return true;
      },
      close: async () => {},
    },
    models: {},
  };
}

async function closeAllTenantConnections() {
  closed = true;
  const closers = [];
  for (const p of pools.values()) {
    try { closers.push(p.end()); } catch { /* ignore */ }
  }
  pools.clear();
  await Promise.allSettled(closers);
}

module.exports = { getTenantConnection, closeAllTenantConnections };
