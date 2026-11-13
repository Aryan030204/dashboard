-- Meeting Pointers, Phase 1 (central MySQL 8): meetings imported from Fireflies, their raw action items, the
-- import job queue and an audit trail. Run ONCE, after 001-005, against the same database. Apply it BEFORE
-- deploying the matching API/worker build. Safe to run again (CREATE TABLE IF NOT EXISTS).
--
-- Every tenant-owned row carries brand_key and every query filters on it. Nothing here references Todoist.

CREATE TABLE IF NOT EXISTS meeting_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  brand_key VARCHAR(32) NOT NULL,
  -- MongoDB _id (as text) of the fireflies_connections document used for the import.
  fireflies_connection_id VARCHAR(32) NULL,
  -- Fireflies' meeting id and transcript id are the same value. Binary collation: ids are case-sensitive.
  fireflies_transcript_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  title VARCHAR(500) NOT NULL,
  meeting_date DATETIME NULL,
  organizer VARCHAR(320) NULL,
  attendees JSON NULL,
  summary MEDIUMTEXT NULL,
  source_url VARCHAR(1000) NULL,
  imported_by VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The same Fireflies meeting can exist once PER BRAND, never twice within a brand.
  UNIQUE KEY uq_meeting_brand_transcript (brand_key, fireflies_transcript_id),
  KEY idx_meeting_brand_date (brand_key, meeting_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The import job queue (restart-safe: all state is in this table; the worker claims rows with FOR UPDATE SKIP LOCKED).
CREATE TABLE IF NOT EXISTS meeting_imports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  brand_key VARCHAR(32) NOT NULL,
  fireflies_transcript_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  source_url VARCHAR(1000) NULL,
  status ENUM('QUEUED','FETCHING','IMPORTED','INVALID_LINK','NOT_FOUND','ACCESS_DENIED','DUPLICATE','FETCH_FAILED') NOT NULL DEFAULT 'QUEUED',
  error_code VARCHAR(64) NULL,
  error_message VARCHAR(500) NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_at DATETIME NULL,
  locked_by VARCHAR(64) NULL,
  meeting_id BIGINT UNSIGNED NULL,
  requested_by VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  -- Non-NULL only while the import is QUEUED or FETCHING. The UNIQUE key below therefore stops two imports of the
  -- same meeting running at once (race-free, no SELECT-then-INSERT) while allowing a retry after a failure.
  active_key VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    GENERATED ALWAYS AS (IF(status IN ('QUEUED','FETCHING'), CONCAT(brand_key COLLATE utf8mb4_bin, ':', fireflies_transcript_id), NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_meeting_import_active (active_key),
  KEY idx_import_claim (status, locked_at, next_attempt_at),
  KEY idx_import_brand (brand_key, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per Fireflies action item. original_text is the immutable source text: no code path updates it.
-- The refined_* / assignee / due_date / priority / category / labels columns stay NULL until the review step exists.
CREATE TABLE IF NOT EXISTS meeting_pointers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  brand_key VARCHAR(32) NOT NULL,
  meeting_id BIGINT UNSIGNED NOT NULL,
  source_key VARCHAR(64) NOT NULL,
  original_text TEXT NOT NULL,
  refined_title VARCHAR(300) NULL,
  refined_description TEXT NULL,
  assignee VARCHAR(200) NULL,
  due_date DATE NULL,
  priority VARCHAR(16) NULL,
  category VARCHAR(64) NULL,
  labels JSON NULL,
  review_state ENUM('PENDING_REVIEW','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING_REVIEW',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pointer_meeting_source (meeting_id, source_key),
  KEY idx_pointer_brand_meeting (brand_key, meeting_id),
  CONSTRAINT fk_pointer_meeting FOREIGN KEY (meeting_id) REFERENCES meeting_records (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audit trail. Never holds secrets (no API key, no AES key).
CREATE TABLE IF NOT EXISTS meeting_pointer_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  brand_key VARCHAR(32) NULL,
  actor VARCHAR(64) NULL,
  action VARCHAR(48) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_id VARCHAR(64) NULL,
  before_state JSON NULL,
  after_state JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mpe_brand_time (brand_key, created_at),
  KEY idx_mpe_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rollback (manual, destroys the imported meeting data):
--   DROP TABLE meeting_pointer_events;
--   DROP TABLE meeting_pointers;
--   DROP TABLE meeting_imports;
--   DROP TABLE meeting_records;
