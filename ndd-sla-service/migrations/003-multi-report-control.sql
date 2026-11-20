-- NDD / SLA Reports: several reports per date + pause/cancel. Run ONCE by hand, after 001 and 002 and BEFORE deploying
-- the version that has the /runs/:id routes (a second run fails harmlessly on "Duplicate column").
--
-- report_seq: 1 = the automated report for the date; every manual upload adds the next number (nothing is overwritten).
-- control:    what the owner of the run asked for; the process holding the run reads it at its next checkpoint.
--             PAUSE holds the run in place (auto-cancelled after NDD_SLA_PAUSE_MAX_MINUTES), CANCEL stops it for good.
ALTER TABLE ndd_sla_runs
  ADD COLUMN report_seq INT UNSIGNED NOT NULL DEFAULT 1 AFTER report_type,
  ADD COLUMN control ENUM('NONE','PAUSE','CANCEL') NOT NULL DEFAULT 'NONE' AFTER error_detail,
  ADD COLUMN paused_at DATETIME NULL AFTER control,
  MODIFY COLUMN status ENUM('SCHEDULED','WAITING_FOR_GOKWIK','GOKWIK_RECEIVED','EASYCOM_FETCHING','PROCESSING',
                            'COMPLETED','GOKWIK_TIMEOUT','EASYCOM_FAILED','PROCESSING_FAILED','CANCELLED')
                           NOT NULL DEFAULT 'SCHEDULED',
  DROP INDEX uq_run,
  ADD UNIQUE KEY uq_run (brand_key, report_date, report_type, report_seq);

-- The unfiltered orders list is ordered by (order_at, reference_code); idx_list has client_location second, so it
-- cannot serve that order without a filesort.
ALTER TABLE ndd_sla_orders ADD KEY idx_time (run_id, generation, order_at, reference_code);
