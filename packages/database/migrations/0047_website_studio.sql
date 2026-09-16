-- Website studio: the AI editor, autonomous QA, structured content (blog,
-- events, donations), custom domains and richer version history — all on
-- top of the existing sites / site_pages / site_releases model.

-- ---- versions -------------------------------------------------------------
-- A release already is a version. It now records what made it and a label
-- for the history list; a restore is a NEW release that points at the same
-- immutable files, so later versions are never destroyed.
ALTER TABLE site_releases ADD COLUMN kind text NOT NULL DEFAULT 'build'
  CHECK (kind IN ('build','edit','qa_repair','restore','content'));
ALTER TABLE site_releases ADD COLUMN label text;
ALTER TABLE site_releases ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE site_releases ADD COLUMN created_by_kind text NOT NULL DEFAULT 'system'
  CHECK (created_by_kind IN ('user','agent','system'));

-- ---- working state -------------------------------------------------------
-- Surgical edits live in an overrides layer beside the composition plans:
-- scoped CSS the editor wrote, applied at render time. Kept on the site so
-- every re-render (an edit, a QA repair, a rebuild) carries them.
ALTER TABLE sites ADD COLUMN edits jsonb NOT NULL DEFAULT '{"overrides":[]}';
ALTER TABLE sites ADD COLUMN qa_status text NOT NULL DEFAULT 'unknown'
  CHECK (qa_status IN ('unknown','running','passed','review','failed'));
ALTER TABLE sites ADD COLUMN qa_job_id uuid;
ALTER TABLE sites ADD COLUMN last_qa_at timestamptz;
ALTER TABLE sites ADD COLUMN donations jsonb NOT NULL DEFAULT '{}';
ALTER TABLE sites ADD COLUMN archived_at timestamptz;
-- A page can be taken out of the site without deleting its copy.
ALTER TABLE site_pages ADD COLUMN status text NOT NULL DEFAULT 'published'
  CHECK (status IN ('published','hidden'));

-- ---- agent jobs (edit + QA) ----------------------------------------------
-- One row per unit of agent work with a live, truthful timeline: steps are
-- appended as they actually start and finish (written outside the workflow
-- transaction so the dashboard sees them mid-step).
CREATE TABLE site_jobs (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES organizations(id),
  site_id        uuid NOT NULL REFERENCES sites(id),
  run_id         uuid REFERENCES workflow_runs(id),
  kind           text NOT NULL CHECK (kind IN ('edit','qa')),
  status         text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','analyzing','editing','building','testing','repairing','verifying','complete','failed')),
  instruction    text,
  context        jsonb NOT NULL DEFAULT '{}',   -- page, viewport, selection, scope
  steps          jsonb NOT NULL DEFAULT '[]',   -- [{key,label,status,startedAt,finishedAt,detail}]
  summary        text,
  error          text,
  result         jsonb NOT NULL DEFAULT '{}',
  release_before uuid REFERENCES site_releases(id),
  release_after  uuid REFERENCES site_releases(id),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
CREATE INDEX site_jobs_site_idx ON site_jobs (site_id, created_at DESC);
CREATE TRIGGER site_jobs_updated BEFORE UPDATE ON site_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The editor's conversation with the site, per site.
CREATE TABLE site_edit_messages (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES organizations(id),
  site_id    uuid NOT NULL REFERENCES sites(id),
  job_id     uuid REFERENCES site_jobs(id),
  role       text NOT NULL CHECK (role IN ('user','assistant')),
  body       text NOT NULL,
  context    jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_edit_messages_site_idx ON site_edit_messages (site_id, created_at);

-- QA findings, with evidence and the repair trail.
CREATE TABLE site_qa_findings (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES organizations(id),
  site_id     uuid NOT NULL REFERENCES sites(id),
  job_id      uuid NOT NULL REFERENCES site_jobs(id),
  severity    text NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  category    text NOT NULL,
  page        text,
  viewport    integer,
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  evidence    jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'detected'
              CHECK (status IN ('detected','repairing','fixed','verified','needs_review')),
  repair      jsonb NOT NULL DEFAULT '{}',
  attempts    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_qa_findings_job_idx ON site_qa_findings (job_id, severity);
CREATE TRIGGER site_qa_findings_updated BEFORE UPDATE ON site_qa_findings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---- structured content ----------------------------------------------------
-- Served dynamically by the site router (never regenerates the site).
CREATE TABLE site_posts (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES organizations(id),
  site_id            uuid NOT NULL REFERENCES sites(id),
  slug               text NOT NULL,
  title              text NOT NULL,
  excerpt            text NOT NULL DEFAULT '',
  content            text NOT NULL DEFAULT '',
  author             text,
  featured_image_key text,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  published_at       timestamptz,
  seo_title          text,
  seo_description    text,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, slug)
);
CREATE TRIGGER site_posts_updated BEFORE UPDATE ON site_posts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE site_events (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES organizations(id),
  site_id            uuid NOT NULL REFERENCES sites(id),
  slug               text NOT NULL,
  title              text NOT NULL,
  description        text NOT NULL DEFAULT '',
  featured_image_key text,
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz,
  location           text,
  mode               text NOT NULL DEFAULT 'in_person' CHECK (mode IN ('in_person','virtual','hybrid')),
  registration_url   text,
  cta_label          text,
  organizer          text,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled')),
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, slug)
);
CREATE TRIGGER site_events_updated BEFORE UPDATE ON site_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---- custom domains -------------------------------------------------------
CREATE TABLE site_domains (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES organizations(id),
  site_id            uuid NOT NULL REFERENCES sites(id),
  domain             text NOT NULL UNIQUE,
  status             text NOT NULL DEFAULT 'pending_dns'
                     CHECK (status IN ('pending_dns','verifying','ssl_provisioning','connected','error')),
  verification_token text NOT NULL,
  dns                jsonb NOT NULL DEFAULT '{}',   -- what the last check observed
  last_checked_at    timestamptz,
  last_error         text,
  connected_at       timestamptz,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_domains_site_idx ON site_domains (site_id);
CREATE TRIGGER site_domains_updated BEFORE UPDATE ON site_domains FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS + grants for the new tables
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_jobs','site_edit_messages','site_qa_findings','site_posts','site_events','site_domains'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())',
      t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO deedwell_app', t);
  END LOOP;
END $$;
