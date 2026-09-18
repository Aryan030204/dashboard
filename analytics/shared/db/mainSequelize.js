// Main Sequelize instance for the analytics service primary DB.
// Canonical location. Extracted from app.js.

const { Sequelize, DataTypes } = require("sequelize");
const { defineApiKeyModel } = require("./models/apiKey");
const { defineDashboardLayoutModel } = require("./models/dashboardLayout");

const DB_HOST = process.env.DB_PROXY_HOST || process.env.DB_HOST;
const DB_PORT = Number(process.env.DB_PROXY_PORT || process.env.DB_PORT || 3306);

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  {
    host: DB_HOST,
    port: DB_PORT,
    dialect: "mysql",
    dialectModule: require("mysql2"),
    timezone: "+00:00",
    pool: {
      max: Number(process.env.DB_POOL_MAX || 1),
      min: Number(process.env.DB_POOL_MIN || 0),
      idle: Number(process.env.DB_POOL_IDLE || 2000),
      acquire: Number(process.env.DB_POOL_ACQUIRE || 30000),
      evict: Number(process.env.DB_POOL_EVICT || 1000),
    },
    logging: false,
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false,
      },
      connectAttributes: {
        program_name: "dashboard-main",
        service: "dashboard-api",
        env: process.env.NODE_ENV || "development",
      },
    },
  },
);

defineApiKeyModel(sequelize, DataTypes, Sequelize);
defineDashboardLayoutModel(sequelize, DataTypes, Sequelize);

module.exports = { sequelize };
