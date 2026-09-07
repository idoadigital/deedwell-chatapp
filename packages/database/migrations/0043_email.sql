-- Transactional email (Resend). The outbox is written inside the same
-- transaction as the event that caused it and drained by a periodic sweep in
-- the API process, mirroring webhook_deliveries. tenant_id is NULL for mail
-- that has no workspace (welcome, password reset, ops alerts).

CREATE TABLE email_outbox (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid REFERENCES organizations(id),
  user_id             uuid REFERENCES users(id),
  to_email            citext NOT NULL,
  kind                text NOT NULL,
  category            text NOT NULL CHECK (category IN ('account','billing','activity','ops')),
  payload             jsonb NOT NULL DEFAULT '{}',
  dedupe_key          text UNIQUE,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','sending','sent','failed','skipped')),
  attempt_count       int NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  last_error          text,
  provider_message_id text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);
CREATE INDEX email_outbox_due_idx ON email_outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX email_outbox_tenant_idx ON email_outbox (tenant_id, created_at DESC);
CREATE INDEX email_outbox_user_idx ON email_outbox (user_id, created_at DESC);
CREATE TRIGGER email_outbox_updated BEFORE UPDATE ON email_outbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The app role enqueues from request handlers and workflow steps (tenant
-- context set) and from untenanted auth routes (tenant_id NULL); reading
-- back is limited to the tenant's own rows. Sending runs on the admin pool.
ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_outbox_tenant ON email_outbox
  USING (tenant_id = app_tenant() OR tenant_id IS NULL)
  WITH CHECK (tenant_id = app_tenant() OR tenant_id IS NULL);
GRANT SELECT, INSERT, UPDATE ON email_outbox TO deedwell_app;

-- Per-person opt-out for activity mail (work updates, digests). Account,
-- billing and security mail is always sent.
ALTER TABLE users ADD COLUMN email_activity_opt_out boolean NOT NULL DEFAULT false;

-- Self-service password reset: store only the hash, single use, short-lived.
CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON password_reset_tokens TO deedwell_app;
