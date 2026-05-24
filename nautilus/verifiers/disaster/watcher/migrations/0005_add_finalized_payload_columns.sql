ALTER TABLE earthquake_events
  ADD COLUMN tee_result_json TEXT;

ALTER TABLE earthquake_events
  ADD COLUMN payload_bcs_hex TEXT;

ALTER TABLE earthquake_events
  ADD COLUMN signature TEXT;

ALTER TABLE earthquake_events
  ADD COLUMN public_key TEXT;

ALTER TABLE earthquake_events
  ADD COLUMN finalized_at_ms INTEGER;
