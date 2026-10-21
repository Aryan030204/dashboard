-- Weekly Reports: allow PDF uploads next to PPT/PPTX.
-- Run ONCE, after 001-003, against the same database. Safe to run again (it only widens the list).
-- Existing rows keep their values; no data changes.

ALTER TABLE weekly_reports
  MODIFY COLUMN source_type ENUM('pptx','ppt','pdf') NOT NULL;
