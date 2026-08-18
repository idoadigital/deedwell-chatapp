-- Mission Fit and Application Viability as two independent, separately
-- displayed values, alongside the existing composite bid/no-bid score
-- (kept for backward compatibility with existing readers).

ALTER TABLE bid_decisions ADD COLUMN mission_fit_score numeric;
ALTER TABLE bid_decisions ADD COLUMN mission_fit_rationale text;
ALTER TABLE bid_decisions ADD COLUMN viability text
  CHECK (viability IN ('apply', 'monitor', 'closed', 'not_eligible'));
ALTER TABLE bid_decisions ADD COLUMN viability_rationale text;
