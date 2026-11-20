-- NDD / SLA Reports: central MySQL 8 (same server/database as weekly-reports; tables are namespaced ndd_sla_*).
-- Run ONCE by hand, BEFORE deploying ndd-sla-service. There is no migration runner in this repo; the service's
-- startup schema check logs an ERROR naming this file if a table is missing. Every statement is
-- CREATE TABLE IF NOT EXISTS, so a second run is harmless.
--
-- Timestamps: created_at/updated_at/locked_at/... are UTC. order_at / *_window_* / order_date / order_hour are
-- WALL-CLOCK values in the report timezone (NDD_SLA_TIMEZONE), because the business windows (12 PM, 3 PM) are
-- clock times. They are stored and compared as naive DATETIME on purpose.

-- One row per brand per report date: the run's identity, state, explicit windows, source metadata and counts.
CREATE TABLE IF NOT EXISTS ndd_sla_runs (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  brand_key            VARCHAR(32)     NOT NULL,
  report_date          DATE            NOT NULL,
  report_type          VARCHAR(16)     NOT NULL DEFAULT 'NDD_SLA',

  status               ENUM('SCHEDULED','WAITING_FOR_GOKWIK','GOKWIK_RECEIVED','EASYCOM_FETCHING','PROCESSING',
                            'COMPLETED','GOKWIK_TIMEOUT','EASYCOM_FAILED','PROCESSING_FAILED')
                                       NOT NULL DEFAULT 'SCHEDULED',
  attempts             INT UNSIGNED    NOT NULL DEFAULT 0,
  next_attempt_at      DATETIME        NULL,
  locked_at            DATETIME        NULL,
  locked_by            VARCHAR(80)     NULL,
  error_code           VARCHAR(48)     NULL,
  error_detail         VARCHAR(500)    NULL,

  -- The exact intervals this report used (half-open [start, end)). Stored so midnight/anchor questions are auditable.
  ndd_window_start     DATETIME        NOT NULL,
  ndd_window_end       DATETIME        NOT NULL,
  other_window_start   DATETIME        NOT NULL,
  other_window_end     DATETIME        NOT NULL,

  -- Source file metadata only. The CSV itself is never stored in MySQL.
  gmail_message_id     VARCHAR(64)     NULL,
  gmail_attachment_id  VARCHAR(512)    NULL,
  source_filename      VARCHAR(255)    NULL,
  source_bytes         BIGINT UNSIGNED NULL,
  source_sha256        CHAR(64)        NULL,
  source_received_at   DATETIME        NULL,
  duplicate_messages   INT UNSIGNED    NOT NULL DEFAULT 0,

  easycom_pages        INT UNSIGNED    NOT NULL DEFAULT 0,
  easycom_fetched      INT UNSIGNED    NOT NULL DEFAULT 0,

  rows_in              INT UNSIGNED    NOT NULL DEFAULT 0,
  rows_wrong_client    INT UNSIGNED    NOT NULL DEFAULT 0,
  rows_wrong_status    INT UNSIGNED    NOT NULL DEFAULT 0,
  rows_out_of_window   INT UNSIGNED    NOT NULL DEFAULT 0,
  rows_duplicate       INT UNSIGNED    NOT NULL DEFAULT 0,
  rows_invalid         INT UNSIGNED    NOT NULL DEFAULT 0,
  rows_kept            INT UNSIGNED    NOT NULL DEFAULT 0,
  rows_unmatched       INT UNSIGNED    NOT NULL DEFAULT 0,
  sla_met              INT UNSIGNED    NOT NULL DEFAULT 0,
  sla_breached         INT UNSIGNED    NOT NULL DEFAULT 0,

  gmail_ms             INT UNSIGNED    NULL,
  easycom_ms           INT UNSIGNED    NULL,
  process_ms           INT UNSIGNED    NULL,

  -- generation = last attempt; active_generation = what the API serves (0 = nothing completed yet).
  generation           INT UNSIGNED    NOT NULL DEFAULT 0,
  active_generation    INT UNSIGNED    NOT NULL DEFAULT 0,

  started_at           DATETIME        NULL,
  completed_at         DATETIME        NULL,
  created_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_run (brand_key, report_date, report_type),
  -- The same Gmail message can never feed two runs (NULL until a message is chosen; MySQL allows many NULLs).
  UNIQUE KEY uq_msg (brand_key, gmail_message_id),
  KEY idx_claim (status, next_attempt_at, locked_at),
  KEY idx_list (brand_key, report_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per Reference Code per generation. The clustered PK keeps a run's rows contiguous and makes
-- duplicates impossible. brand_key is deliberately NOT repeated here: every read goes through a run row that was
-- looked up by (brand from the signed header, report_date).
CREATE TABLE IF NOT EXISTS ndd_sla_orders (
  run_id              BIGINT UNSIGNED NOT NULL,
  generation          INT UNSIGNED    NOT NULL,
  reference_code      VARCHAR(64)     NOT NULL,
  client_location     ENUM('AJMAL_SONS','EMIZA_GGN') NOT NULL,
  order_at            DATETIME        NOT NULL,
  order_date          DATE            NOT NULL,
  order_hour          TINYINT UNSIGNED NOT NULL,
  courier             VARCHAR(80)     NOT NULL,
  is_ndd              TINYINT(1)      NOT NULL,
  -- NULL = no real pickup timestamp. NEVER the Excel 1900 placeholder (that exists only in an export).
  shipment_picked_at  DATETIME        NULL,
  sla_status          ENUM('MET','BREACHED') NOT NULL,

  PRIMARY KEY (run_id, generation, reference_code),
  KEY idx_list (run_id, generation, client_location, order_at, reference_code),
  CONSTRAINT fk_ndd_sla_orders_run FOREIGN KEY (run_id) REFERENCES ndd_sla_runs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Precomputed hourly counts. Percentages are derived by the API from these counts, not stored.
CREATE TABLE IF NOT EXISTS ndd_sla_summary (
  run_id          BIGINT UNSIGNED NOT NULL,
  generation      INT UNSIGNED    NOT NULL,
  client_location ENUM('AJMAL_SONS','EMIZA_GGN') NOT NULL,
  order_date      DATE            NOT NULL,
  order_hour      TINYINT UNSIGNED NOT NULL,
  met_count       INT UNSIGNED    NOT NULL DEFAULT 0,
  breached_count  INT UNSIGNED    NOT NULL DEFAULT 0,
  total_count     INT UNSIGNED    NOT NULL DEFAULT 0,

  PRIMARY KEY (run_id, generation, client_location, order_date, order_hour),
  CONSTRAINT fk_ndd_sla_summary_run FOREIGN KEY (run_id) REFERENCES ndd_sla_runs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- State-transition audit trail (same idea as weekly_report_events).
CREATE TABLE IF NOT EXISTS ndd_sla_events (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id       BIGINT UNSIGNED NOT NULL,
  at           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  from_status  VARCHAR(24)     NULL,
  to_status    VARCHAR(24)     NOT NULL,
  actor        VARCHAR(64)     NOT NULL DEFAULT 'system',
  metadata     JSON            NULL,

  PRIMARY KEY (id),
  KEY idx_run (run_id, at),
  CONSTRAINT fk_ndd_sla_events_run FOREIGN KEY (run_id) REFERENCES ndd_sla_runs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Encrypted third-party credentials (AES-256-CBC via PASSWORD_AES_KEY, same helper convention as analytics and
-- tenant-router). One row per brand and provider. The token is decrypted in memory only and never logged;
-- token_suffix (last 4 characters) is the only value ever shown.
CREATE TABLE IF NOT EXISTS ndd_sla_credentials (
  brand_key        VARCHAR(32)  NOT NULL,
  provider         ENUM('GMAIL','EASYCOM') NOT NULL,
  token_encrypted  TEXT         NOT NULL,
  token_suffix     VARCHAR(8)   NOT NULL DEFAULT '',
  account_email    VARCHAR(255) NULL,
  last_verified_at DATETIME     NULL,
  last_error       VARCHAR(500) NULL,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (brand_key, provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
