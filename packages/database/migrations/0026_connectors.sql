-- Tenant-scoped external service connections ("Connectors").
--
-- One row per (tenant, provider, provider account). Deliberately NOT a single
-- global Meta/Google app connection shared across customers: every row carries
-- tenant_id, RLS pins it to app_tenant(), and every route reads through the
-- tenant-scoped pool. One workspace can never see or use another's connection.
--
-- Tokens are AES-GCM sealed with the same envelope as google_oauth_connections
-- and platform_stripe_config (ciphertext + iv + tag + key_version), and never
-- leave the server: no route returns them, and the API shape exposed to the
-- browser is account name / status / dates only.
--
-- provider is open text rather than a CHECK so a new connector is a code change
-- and a registry entry, not a migration.

CREATE TABLE connector_connections (
  id                       uuid PRIMARY KEY,
  tenant_id                uuid NOT NULL REFERENCES organizations(id),
  provider                 text NOT NULL,
  -- The specific thing connected under that provider: a Facebook Page, an
  -- Instagram professional account, a Google account.
  connector_type           text NOT NULL,
  provider_account_id      text NOT NULL,
  provider_account_name    text,
  provider_account_handle  text,
  provider_account_avatar_url text,

  encrypted_access_token   bytea NOT NULL,
  access_iv                bytea NOT NULL,
  access_tag               bytea NOT NULL,
  encrypted_refresh_token  bytea,
  refresh_iv               bytea,
  refresh_tag              bytea,
  key_version              integer NOT NULL DEFAULT 1,
  token_expires_at         timestamptz,

  scopes                   text[] NOT NULL DEFAULT '{}',
  -- needs_attention/expired are set by the token-health path when a provider
  -- rejects our credential, so scheduled work stops failing silently.
  status                   text NOT NULL DEFAULT 'connected'
                           CHECK (status IN ('connected', 'needs_attention', 'expired', 'disconnected')),
  status_detail            text,
  metadata                 jsonb NOT NULL DEFAULT '{}',

  connected_by_user_id     uuid NOT NULL REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  disconnected_at          timestamptz
);
-- At most one live connection per account per tenant; reconnecting replaces.
CREATE UNIQUE INDEX connector_connections_live_idx
  ON connector_connections (tenant_id, provider, connector_type, provider_account_id)
  WHERE status <> 'disconnected';
CREATE INDEX connector_connections_tenant_idx ON connector_connections (tenant_id, provider, status);
ALTER TABLE connector_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY connector_connections_tenant ON connector_connections
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER connector_connections_updated BEFORE UPDATE ON connector_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE ON connector_connections TO deedwell_app;

-- Single-use, hashed CSRF/nonce for the OAuth redirect round trip. Same
-- pattern as google_oauth_states: the raw value goes to the provider, only its
-- hash is stored, and it is consumed on first use.
CREATE TABLE connector_oauth_states (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES organizations(id),
  provider       text NOT NULL,
  state_hash     text NOT NULL UNIQUE,
  code_verifier  text,
  redirect_to    text,
  created_by     uuid NOT NULL REFERENCES users(id),
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connector_oauth_states_expiry_idx ON connector_oauth_states (expires_at);
ALTER TABLE connector_oauth_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY connector_oauth_states_tenant ON connector_oauth_states
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON connector_oauth_states TO deedwell_app;

-- Scheduled social posts. Publishing is driven by a server-side worker polling
-- this table, so nothing depends on the author's browser staying open.
CREATE TABLE scheduled_posts (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES organizations(id),
  connector_id      uuid NOT NULL REFERENCES connector_connections(id),
  content_project_id uuid REFERENCES content_projects(id),
  platform          text NOT NULL,
  content           text NOT NULL,
  -- file ids from `files`, in render order.
  media             jsonb NOT NULL DEFAULT '[]',
  scheduled_at      timestamptz,
  timezone          text NOT NULL DEFAULT 'UTC',
  status            text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'scheduled', 'publishing', 'published', 'failed')),
  attempts          integer NOT NULL DEFAULT 0,
  published_at      timestamptz,
  provider_post_id  text,
  error             text,
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- The worker's claim query: due, scheduled, oldest first.
CREATE INDEX scheduled_posts_due_idx ON scheduled_posts (status, scheduled_at)
  WHERE status = 'scheduled';
CREATE INDEX scheduled_posts_tenant_idx ON scheduled_posts (tenant_id, created_at DESC);
ALTER TABLE scheduled_posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY scheduled_posts_tenant ON scheduled_posts
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER scheduled_posts_updated BEFORE UPDATE ON scheduled_posts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE ON scheduled_posts TO deedwell_app;
