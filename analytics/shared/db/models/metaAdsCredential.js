// meta_ads_credentials Sequelize model definition.
// One row per brand, storing that brand's own Meta (Facebook) Ads API
// access token so ad spend can be pulled per-brand instead of from a single
// shared env var.

function defineMetaAdsCredentialModel(sequelize, DataTypes, Sequelize) {
  return sequelize.define(
    "meta_ads_credentials",
    {
      id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      brand_key: { type: DataTypes.STRING(32), allowNull: false, unique: true },
      ad_account_id: { type: DataTypes.STRING(64), allowNull: false },
      access_token_encrypted: { type: DataTypes.TEXT, allowNull: false },
      token_expires_at: { type: DataTypes.DATE, allowNull: true },
      last_verified_at: { type: DataTypes.DATE, allowNull: true },
      last_error: { type: DataTypes.STRING(500), allowNull: true },
      updated_by_email: { type: DataTypes.STRING(255), allowNull: true },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
      updated_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
    },
    {
      tableName: "meta_ads_credentials",
      timestamps: false,
      indexes: [{ unique: true, fields: ["brand_key"], name: "uniq_meta_ads_brand_key" }],
    },
  );
}

module.exports = { defineMetaAdsCredentialModel };
