-- Google OAuth identity for the Ad Grants wizard's "Connect Google Account"
-- step. Separate from google_sessions (0018_ad_grants.sql), which holds the
-- browser-automation agent's own live-login storageState: this table is a
-- standard OAuth 2.0 refresh token used only to show a connected profile
-- and, later, to mint short-lived access tokens for real Google API calls.
-- Same shape/RLS/audit conventions as google_sessions throughout.

CREATE TABLE google_oauth_connections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organizations(id),
  connected_by uuid NOT NULL REFERENCES users(id),
  google_subject_id text NOT NULL,
  google_account_email text NOT NULL,
  google_account_name text,
  google_account_avatar_url text,
  encrypted_refresh_token bytea NOT NULL,
  enc_iv bytea NOT NULL,
  enc_tag bytea NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  access_token_expiry timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id)
);
CREATE INDEX google_oauth_connections_tenant_idx ON google_oauth_connections (tenant_id, status);
ALTER TABLE google_oauth_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_oauth_connections_tenant ON google_oauth_connections
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER google_oauth_connections_updated BEFORE UPDATE ON google_oauth_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE ON google_oauth_connections TO deedwell_app;

-- Short-lived, single-use CSRF/PKCE state for the OAuth redirect round
-- trip — same hashed-single-use-token pattern as google_connect_sessions.
CREATE TABLE google_oauth_states (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  state_hash text NOT NULL UNIQUE,
  code_verifier text NOT NULL,
  redirect_to text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE google_oauth_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_oauth_states_tenant ON google_oauth_states
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON google_oauth_states TO deedwell_app;
