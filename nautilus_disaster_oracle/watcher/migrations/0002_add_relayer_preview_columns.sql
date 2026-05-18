ALTER TABLE earthquake_events
  ADD COLUMN relayer_mode TEXT;

ALTER TABLE earthquake_events
  ADD COLUMN relayer_status TEXT;

ALTER TABLE earthquake_events
  ADD COLUMN relayer_request_json TEXT;

ALTER TABLE earthquake_events
  ADD COLUMN relayer_digest TEXT;

ALTER TABLE earthquake_events
  ADD COLUMN relayer_error_code TEXT;

ALTER TABLE earthquake_events
  ADD COLUMN relayer_error_message TEXT;

ALTER TABLE earthquake_events
  ADD COLUMN relayer_updated_at_ms INTEGER;

ALTER TABLE earthquake_events
  ADD COLUMN relayer_submitted_at_ms INTEGER;
