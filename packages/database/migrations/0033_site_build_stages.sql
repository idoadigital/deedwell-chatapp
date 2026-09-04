-- Every stage of the website generation pipeline writes its structured
-- output here: what the reference analysis said, the design tokens, each
-- page's composition plan, the critic's report. Keyed by the hash of the
-- stage's input so an unchanged stage is reused rather than regenerated,
-- and a single stage can be reset (row deleted) and re-run on its own.
CREATE TABLE site_build_stages (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES organizations(id),
  site_id     uuid NOT NULL REFERENCES sites(id),
  run_id      uuid,
  stage       text NOT NULL,
  -- "" for site-wide stages, the page slug for per-page ones
  scope       text NOT NULL DEFAULT '',
  input_hash  text NOT NULL,
  output      jsonb NOT NULL,
  model       text,
  duration_ms integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, stage, scope)
);
CREATE INDEX site_build_stages_site_idx ON site_build_stages (site_id, created_at DESC);
ALTER TABLE site_build_stages ENABLE ROW LEVEL SECURITY;
CREATE POLICY site_build_stages_tenant ON site_build_stages
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON site_build_stages TO deedwell_app;
