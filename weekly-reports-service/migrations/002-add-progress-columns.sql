-- Weekly Reports: processing progress shown in the UI ("Preparing slides 7 of 15, 8 remaining").
-- Run ONCE, after 001, against the same database. (MySQL has no "ADD COLUMN IF NOT EXISTS",
-- so a second run fails with "Duplicate column name"; that is harmless.)

ALTER TABLE weekly_reports
  ADD COLUMN stage VARCHAR(32) NULL AFTER status,
  ADD COLUMN slides_total INT UNSIGNED NULL AFTER slide_count,
  ADD COLUMN slides_done INT UNSIGNED NULL AFTER slides_total;
