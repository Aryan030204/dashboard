-- Migration: Create pnl_meta_ad_spend_rollup table
-- Run this against EACH brand database (same as 001/003/004), NOT the
-- analytics service's own central DB.
--
-- Daily Meta ad spend. Written by a separate pipeline (a different
-- project, not part of this repo) that polls the Meta Marketing API on its
-- own schedule, using the ad account/token saved via POST
-- /pnl/meta-ads/connect (meta_ads_credentials — that table lives in the
-- central DB via mainSequelize.js and is untouched by this migration).
--
-- The analytics service only ever SELECTs from this table (see
-- pnlAdSpendRollup.service.js) — it no longer calls the Meta Graph API
-- directly from the P&L request path.

CREATE TABLE IF NOT EXISTS `pnl_meta_ad_spend_rollup` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `date` DATE NOT NULL,
  `ad_account_id` VARCHAR(64) NULL,
  `spend` DECIMAL(14,4) NOT NULL DEFAULT 0,
  `currency` VARCHAR(8) NOT NULL DEFAULT 'INR',
  `synced_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_pnl_meta_ad_spend_date` (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
