CREATE TABLE IF NOT EXISTS earthquake_events (
  source_event_id TEXT PRIMARY KEY,
  event_uid TEXT,
  status TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at_ms INTEGER,
  finalization_deadline_at_ms INTEGER,
  latest_revision INTEGER DEFAULT 0,
  last_seen_at_ms INTEGER NOT NULL,
  source_updated_at_ms INTEGER,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_earthquake_events_status_next_retry
  ON earthquake_events (status, next_retry_at_ms);

CREATE INDEX IF NOT EXISTS idx_earthquake_events_updated
  ON earthquake_events (updated_at_ms);
