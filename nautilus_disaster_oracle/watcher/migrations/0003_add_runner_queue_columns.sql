ALTER TABLE earthquake_events
  ADD COLUMN runner_job_id TEXT;

ALTER TABLE earthquake_events
  ADD COLUMN runner_queued_at_ms INTEGER;

ALTER TABLE earthquake_events
  ADD COLUMN runner_attempt INTEGER;

ALTER TABLE earthquake_events
  ADD COLUMN runner_id TEXT;

ALTER TABLE earthquake_events
  ADD COLUMN runner_started_at_ms INTEGER;

ALTER TABLE earthquake_events
  ADD COLUMN runner_stopped_at_ms INTEGER;

ALTER TABLE earthquake_events
  ADD COLUMN runner_timeout_at_ms INTEGER;

ALTER TABLE earthquake_events
  ADD COLUMN runner_error_message TEXT;

ALTER TABLE earthquake_events
  ADD COLUMN runner_stop_error TEXT;

CREATE INDEX IF NOT EXISTS idx_earthquake_events_runner_job_id
  ON earthquake_events (runner_job_id);
