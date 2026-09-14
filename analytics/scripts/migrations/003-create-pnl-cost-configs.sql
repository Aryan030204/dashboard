-- Migration: Create pnl_cost_configs table
-- Run this against EACH brand database (same as 001-create-hourly-product-sessions.sql),
-- NOT the analytics service's own central DB.
--
-- Backs the "Brand Cost Configuration" section of the P&L page
-- (client/dashboard/src/pages/Pnl/components/PnlConfigSection.jsx): manual
-- cost inputs for categories that aren't derivable from order data (rent,
-- salaries, packaging, etc). Each row is one configured cost for one
-- category, either a flat currency amount or a percentage of Net Sales for
-- the period (value_type decides which — see pnlCostConfig.service.js,
-- which is the only place `value` gets interpreted).
--
-- `category` is a free-text key, not an ENUM, so new cost categories don't
-- need a migration — it must match one of the keys pnl.service.js knows how
-- to fold into the P&L (see CATEGORY_FIELD_MAP), unrecognized categories
-- are ignored by the summary endpoint.
--
-- Only one row is "active" per category at a time for a given date: when
-- multiple rows overlap, pnlCostConfig.service.js takes the one with the
-- latest effective_from. Superseding a value should set the old row's
-- effective_to (or is_active = 0) rather than deleting it, to preserve
-- history for past periods.

CREATE TABLE IF NOT EXISTS `pnl_cost_configs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `category` VARCHAR(64) NOT NULL,
  `label` VARCHAR(120) NOT NULL,
  `value_type` ENUM('flat','percentage') NOT NULL DEFAULT 'flat',
  `value` DECIMAL(14,4) NOT NULL,
  `frequency` ENUM('recurring','one_time') NOT NULL DEFAULT 'recurring',
  `effective_from` DATE NOT NULL,
  `effective_to` DATE NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `notes` VARCHAR(500) NULL,
  `created_by_email` VARCHAR(255) NULL,
  `updated_by_email` VARCHAR(255) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pnl_cost_configs_category_lookup` (`category`, `is_active`, `effective_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
