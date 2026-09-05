-- Huddle events are internal telemetry with an evolving vocabulary: routing,
-- backchannel, floor, turn_committed and now participant_joined were all being
-- rejected by the original fixed CHECK and lost. Drop the constraint — the
-- writers are ours and the column is read by type, never validated against a
-- closed set.
ALTER TABLE huddle_events DROP CONSTRAINT IF EXISTS huddle_events_type_check;
