ALTER TABLE earthquake_events
  ADD COLUMN relayer_preview_status TEXT;

ALTER TABLE earthquake_events
  ADD COLUMN relayer_request_json TEXT;

ALTER TABLE earthquake_events
  ADD COLUMN relayer_error_code TEXT;

ALTER TABLE earthquake_events
  ADD COLUMN relayer_error_message TEXT;

ALTER TABLE earthquake_events
  ADD COLUMN relayer_preview_updated_at_ms INTEGER;
