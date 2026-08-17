-- The user's IANA timezone, learned from their client on each message. Lets
-- agents state "today" and deadline distances in the user's local time; voice
-- huddle turns (no per-turn client payload) reuse the last known value.
ALTER TABLE users ADD COLUMN timezone text;
