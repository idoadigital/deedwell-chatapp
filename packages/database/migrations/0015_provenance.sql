-- Real provenance for org_facts, and a conflict record instead of a silent
-- overwrite when two documents disagree on the same fact.

ALTER TABLE org_facts ADD COLUMN source_file_id uuid REFERENCES files(id);
ALTER TABLE org_facts ADD COLUMN source_location text;
ALTER TABLE org_facts ADD COLUMN source_quote text;
ALTER TABLE org_facts ADD COLUMN extracted_by_agent text;

-- org_facts stays "current value" (every reader — fetch_org_facts, claim
-- verification, both GET routes — expects one row per key). Disagreement is
-- tracked here instead, and left for a human to resolve rather than
-- overwritten silently.
CREATE TABLE org_fact_conflicts (
  id                      uuid PRIMARY KEY,
  tenant_id               uuid NOT NULL REFERENCES organizations(id),
  fact_key                text NOT NULL,
  current_value           text NOT NULL,
  current_status          text NOT NULL,
  current_source_file_id  uuid REFERENCES files(id),
  proposed_value          text NOT NULL,
  proposed_status         text NOT NULL,
  proposed_source_file_id uuid REFERENCES files(id),
  proposed_source_quote   text,
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_value          text,
  resolved_by             uuid REFERENCES users(id),
  resolved_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_fact_conflicts_open_idx ON org_fact_conflicts (tenant_id, fact_key) WHERE status = 'open';
ALTER TABLE org_fact_conflicts ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_fact_conflicts_tenant ON org_fact_conflicts
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON org_fact_conflicts TO deedwell_app;
