-- Migration: Create pnl_meta_ad_spend_rollup table
-- Run this against EACH brand database (same as 001/003/004), NOT the
-- analytics service's own central DB.
--
-- Daily Meta ad spend. Written by the pipeline's P&L worker (the
-- aws-pipeline-ec2 repo, migrations/004_pnl_ad_spend_rollups.sql is the
-- canonical DDL for this table and its Google twin) using the ad
-- account/token saved via POST /pnl/meta-ads/connect (Mongo
-- meta_ads_credentials). Kept here so a brand DB can be prepared from this
-- repo too; the pipeline's version makes `currency` nullable.
--
-- The analytics service only ever SELECTs from this table (see
-- pnl.service.js) — it never calls the Meta Graph API from the P&L request
-- path.

CREATE TABLE IF NOT EXISTS `pnl_meta_ad_spend_rollup` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `date` DATE NOT NULL,
  `ad_account_id` VARCHAR(64) NULL,
  `spend` DECIMAL(14,4) NOT NULL DEFAULT 0,
  `currency` VARCHAR(8) NULL,
  `synced_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_pnl_meta_ad_spend_date` (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
