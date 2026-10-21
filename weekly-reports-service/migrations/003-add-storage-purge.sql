-- Weekly Reports: track that a deleted/cancelled report's files have been removed from S3.
-- Run ONCE, after 001 and 002, against the same database.
--
-- The API deletes a report's files immediately when it can. If S3 is unreachable, or a worker was
-- still using the files, the row is left with storage_purged_at NULL and the worker's cleanup sweep
-- retries until it succeeds. Rows deleted before this migration are picked up by that sweep too, so
-- their files are removed from the bucket the first time the worker runs.

ALTER TABLE weekly_reports
  ADD COLUMN storage_purged_at DATETIME NULL AFTER deleted_at,
  ADD KEY idx_purge (deleted_at, storage_purged_at);
