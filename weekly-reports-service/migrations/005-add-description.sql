-- Weekly Reports: optional author-only description (about 100 words) per presentation.
-- Run ONCE, after 001-004, against the same database. Apply it BEFORE deploying the matching API build
-- (the API selects this column). MySQL has no "ADD COLUMN IF NOT EXISTS", so a second run fails with
-- "Duplicate column name"; that is harmless. Existing rows keep NULL; no data changes.

ALTER TABLE weekly_reports
  ADD COLUMN description TEXT NULL AFTER reporting_week;
