-- Google Ad Grants: encrypted, revocable capture of a human-authenticated
-- Google browser session, and the ephemeral tokens that gate the live
-- "connect your Google account" WebSocket. The org's Google password never
-- reaches either table — see packages/browser-automation/src/live-relay.ts.

CREATE TABLE google_sessions (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES organizations(id),
  google_account_hint text,               -- masked email, display only
  encrypted_state     bytea NOT NULL,     -- AES-256-GCM(Playwright storageState JSON)
  enc_iv              bytea NOT NULL,
  enc_tag             bytea NOT NULL,
  key_version         integer NOT NULL DEFAULT 1,
  status              text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','expired','revoked')),
  connected_by        uuid NOT NULL REFERENCES users(id),
  connected_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz,
  last_verified_at    timestamptz,
  revoked_at          timestamptz,
  revoked_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_sessions_tenant_idx ON google_sessions (tenant_id, status);
ALTER TABLE google_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_sessions_tenant ON google_sessions
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER google_sessions_updated BEFORE UPDATE ON google_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE ON google_sessions TO deedwell_app;

-- Ephemeral tokens for the connect-flow WebSocket — same shape/lifecycle as
-- huddle_sessions (0008_huddle_rtc.sql). Redeemed via the admin pool before
-- any tenant context exists for the connecting socket.
CREATE TABLE google_connect_sessions (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES organizations(id),
  run_id     uuid NOT NULL REFERENCES workflow_runs(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','captured','expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE google_connect_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_connect_sessions_tenant ON google_connect_sessions
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON google_connect_sessions TO deedwell_app;

-- Widen the artifact-type constraint, same pattern as 0002/0003/0012 — full
-- current list confirmed against the live 0012 migration before appending.
ALTER TABLE artifacts DROP CONSTRAINT artifacts_type_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_type_check CHECK (type IN
  ('compliance_matrix','grant_section','export_package','application_plan','budget',
   'logic_model','review_report','compliance_report','website_brief','website_test_report',
   'ad_grants_eligibility','ad_grants_enrollment_snapshot',
   'ad_grants_campaign_plan','ad_grants_activation_snapshot'));
