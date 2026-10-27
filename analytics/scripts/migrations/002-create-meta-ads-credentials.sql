-- SUPERSEDED: Meta credentials now live in Mongo (arch-auth database,
-- `meta_ads_credentials` collection, one document per brand — see
-- analytics/shared/db/models/MetaAdsCredential.mongo.js) so the pipeline's
-- P&L worker can read them next to total_config and google_ads_credentials.
-- Nothing reads or writes this MySQL table any more; kept for history only.
-- Brands connected before the move need to reconnect from the P&L page.
--
-- Migration: Create meta_ads_credentials table
-- Run this against the analytics service's own central DB (the DB pointed
-- to by DB_HOST/DB_NAME in analytics/.env, i.e. mainSequelize), NOT a
-- per-brand database.
--
-- Stores one row per brand with that brand's own Meta (Facebook) Ads API
-- access token (AES-256-CBC encrypted with PASSWORD_AES_KEY, see
-- analytics/shared/utils/crypto.js), so ad spend can be pulled per-brand
-- from the P&L page instead of relying on a single shared env var.

CREATE TABLE IF NOT EXISTS `meta_ads_credentials` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `brand_key` VARCHAR(32) NOT NULL,
  `ad_account_id` VARCHAR(64) NOT NULL,
  `access_token_encrypted` TEXT NOT NULL,
  `token_expires_at` DATETIME NULL,
  `last_verified_at` DATETIME NULL,
  `last_error` VARCHAR(500) NULL,
  `updated_by_email` VARCHAR(255) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_meta_ads_brand_key` (`brand_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
