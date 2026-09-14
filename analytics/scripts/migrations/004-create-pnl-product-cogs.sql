-- Migration: Create pnl_product_cogs table
-- Run this against EACH brand database (same as 001/003), NOT the analytics
-- service's own central DB.
--
-- Per-product COGS config — the "cog per product" table. Complements
-- pnl_cost_configs (003), which holds the brand-level *total* COGS figure
-- (its `cogs` category row) used as-is by the P&L summary today. Turning
-- these per-product rates into that total requires joining against real
-- per-product sales/quantity data, which is out of scope here — that join
-- belongs to the separate rollup pipeline, not this service. This table is
-- just the config store the rollup pipeline (and, later, real reporting)
-- reads from.
--
-- Rows are populated by POST /pnl/product-cogs/upload (see
-- pnlProductCogs.service.js), which upserts by product_id + date range:
-- uploading a row for a product whose range overlaps an existing active row
-- replaces that row outright (no history kept for superseded rows).
--
-- value_type mirrors pnl_cost_configs: 'flat' is a per-unit currency cost,
-- 'percentage' is a percentage of that product's own Net Sales for the
-- period.

CREATE TABLE IF NOT EXISTS `pnl_product_cogs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` VARCHAR(64) NOT NULL,
  `product_title` VARCHAR(255) NULL,
  `value_type` ENUM('flat','percentage') NOT NULL DEFAULT 'flat',
  `value` DECIMAL(14,4) NOT NULL,
  `effective_from` DATE NOT NULL,
  `effective_to` DATE NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `source` ENUM('csv_upload','manual') NOT NULL DEFAULT 'manual',
  `uploaded_by_email` VARCHAR(255) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pnl_product_cogs_lookup` (`product_id`, `is_active`, `effective_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
