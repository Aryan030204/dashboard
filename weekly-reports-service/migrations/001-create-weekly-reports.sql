-- Weekly Reports (central MySQL). Run once by hand, like the other services' migrations.
-- Requires MySQL 8 (the worker claims jobs with FOR UPDATE SKIP LOCKED).

CREATE TABLE IF NOT EXISTS weekly_reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  brand_key VARCHAR(32) NOT NULL,
  title VARCHAR(200) NOT NULL,
  reporting_week VARCHAR(40) NOT NULL,
  version INT UNSIGNED NOT NULL,
  source_type ENUM('pptx','ppt') NOT NULL,
  source_storage_key VARCHAR(512) NOT NULL DEFAULT '',
  source_sha256 CHAR(64) NULL,
  source_size_bytes BIGINT UNSIGNED NULL,
  status ENUM('PROCESSING','READY','PUBLISHED','UNPUBLISHED','FAILED') NOT NULL DEFAULT 'PROCESSING',
  slide_count INT UNSIGNED NULL,
  error_code VARCHAR(64) NULL,
  error_detail VARCHAR(1000) NULL,
  -- Job claim. A row is created already "locked" while its file is still uploading to S3;
  -- the API releases it (locked_at = NULL) once the source is stored, then a worker claims it.
  locked_at DATETIME NULL,
  locked_by VARCHAR(64) NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  uploaded_by VARCHAR(64) NOT NULL,
  published_by VARCHAR(64) NULL,
  uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME NULL,
  deleted_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_brand_week_version (brand_key, reporting_week, version),
  KEY idx_brand_status_published (brand_key, status, published_at),
  KEY idx_claim (status, locked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS weekly_report_slides (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  report_id BIGINT UNSIGNED NOT NULL,
  slide_number INT UNSIGNED NOT NULL,
  image_storage_key VARCHAR(512) NOT NULL,
  thumbnail_storage_key VARCHAR(512) NOT NULL,
  width INT UNSIGNED NULL,
  height INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_report_slide (report_id, slide_number),
  CONSTRAINT fk_wr_slides_report FOREIGN KEY (report_id) REFERENCES weekly_reports (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS weekly_report_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  brand_key VARCHAR(32) NOT NULL,
  report_id BIGINT UNSIGNED NULL,
  user_id VARCHAR(64) NULL,
  action VARCHAR(40) NOT NULL,
  metadata JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_events_brand_time (brand_key, created_at),
  KEY idx_events_report (report_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
