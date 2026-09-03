-- Content Studio: the deedwell.org dashboard's "Content" surface.
--
-- A content project is one campaign — one user prompt, one marketing
-- strategy derived from it, and the four-to-six finished designs that come
-- out the other side. Images are NOT stored here: they go through the same
-- `files` table and storage adapter as every other upload, so tenant
-- isolation, the storage key scheme and cleanup all stay in one place.
-- content_assets is the join that keeps their order and the prompt each
-- one was generated from, which is what makes a result reproducible.

CREATE TABLE content_projects (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES organizations(id),
  project_id  uuid REFERENCES projects(id),
  kind        text NOT NULL CHECK (kind IN ('social', 'flyer', 'buying_guide', 'event_promo')),
  title       text NOT NULL,
  prompt      text NOT NULL,
  -- The strategy the model produced before any image was drawn: audience,
  -- message, tone, palette, the per-design briefs. Kept so a campaign can be
  -- explained after the fact and regenerated without re-deriving it.
  strategy    jsonb,
  status      text NOT NULL DEFAULT 'generating'
              CHECK (status IN ('generating', 'ready', 'failed')),
  error       text,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_projects_tenant_idx ON content_projects (tenant_id, created_at DESC);
ALTER TABLE content_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY content_projects_tenant ON content_projects
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON content_projects TO deedwell_app;

CREATE TABLE content_assets (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES organizations(id),
  content_project_id uuid NOT NULL REFERENCES content_projects(id) ON DELETE CASCADE,
  file_id            uuid REFERENCES files(id),
  position           int NOT NULL,
  -- The exact image prompt used, so a design can be regenerated or refined
  -- without guessing at what produced it.
  prompt             text NOT NULL,
  caption            text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_assets_project_idx ON content_assets (content_project_id, position);
ALTER TABLE content_assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY content_assets_tenant ON content_assets
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT ON content_assets TO deedwell_app;

-- The OpenAI credential the Content Studio generates with. Managed from
-- Platform Admin rather than an env var, so rotating it does not need a
-- redeploy — and so it is never sitting in a Cloud Run config that everyone
-- with console access can read. One platform-wide key, same shape and same
-- AES-GCM envelope as platform_stripe_config; no tenant_id, so no RLS
-- (requirePlatformAdmin gates it at the route layer, like api_keys).
-- Keyed by provider so a second one (an image vendor, say) needs no migration.
CREATE TABLE platform_provider_keys (
  id             uuid PRIMARY KEY,
  provider       text NOT NULL CHECK (provider IN ('openai')),
  encrypted_key  bytea NOT NULL,
  key_iv         bytea NOT NULL,
  key_tag        bytea NOT NULL,
  key_version    integer NOT NULL DEFAULT 1,
  key_last4      text NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  set_by         uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);
CREATE UNIQUE INDEX platform_provider_keys_active_idx
  ON platform_provider_keys (provider) WHERE status = 'active';
GRANT SELECT, INSERT, UPDATE ON platform_provider_keys TO deedwell_app;
