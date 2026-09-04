-- Site Generation Settings (Platform Admin). Two things the website builder
-- reads at brief time: the sections every generated site must carry to
-- satisfy grant-approval requirements, and a library of reference
-- screenshots, one of which is picked at random as the design reference
-- for each new site.

-- Keyed settings so the next platform-level setting needs no migration.
CREATE TABLE platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}',
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER platform_settings_updated BEFORE UPDATE ON platform_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- No tenant_id and therefore no RLS: writes are gated by requirePlatformAdmin
-- at the route layer, the same as platform_integrations. The workflow engine
-- reads it on every tenant's behalf, which is why deedwell_app has SELECT.
GRANT SELECT, INSERT, UPDATE ON platform_settings TO deedwell_app;

CREATE TABLE site_reference_templates (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_reference_templates_status_idx
  ON site_reference_templates (status, created_at DESC);
CREATE TRIGGER site_reference_templates_updated BEFORE UPDATE ON site_reference_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Removal is archiving, never a DELETE: a site brief may still cite a template.
GRANT SELECT, INSERT, UPDATE ON site_reference_templates TO deedwell_app;

-- Which reference a site was generated from, so an admin can trace a look
-- back to the template that inspired it.
ALTER TABLE sites ADD COLUMN reference_template_id uuid REFERENCES site_reference_templates(id);
