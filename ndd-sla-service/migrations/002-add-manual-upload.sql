-- NDD / SLA Reports: manual upload mode. Run ONCE by hand, after 001 and BEFORE deploying the version that has the
-- upload endpoint (MySQL has no ADD COLUMN IF NOT EXISTS, so a second run fails harmlessly on "Duplicate column").
--
-- source_mode: 'AUTO'   = the worker finds the GoKwik email and calls EasyCom (the original flow)
--              'MANUAL' = an author uploaded both files; the worker never claims such a run.
-- The uploaded files themselves are never stored: they are streamed through the processor and deleted.
ALTER TABLE ndd_sla_runs
  ADD COLUMN source_mode             VARCHAR(8)   NOT NULL DEFAULT 'AUTO' AFTER report_type,
  ADD COLUMN easycom_source_filename VARCHAR(255) NULL AFTER source_received_at,
  ADD COLUMN uploaded_by             VARCHAR(64)  NULL AFTER easycom_source_filename;
