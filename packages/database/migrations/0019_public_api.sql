-- Platform-wide developer API: one small set of API keys, managed by a
-- Deedwell platform admin (not a per-nonprofit org admin), that give a
-- single external integration — a partner application whose job is to run
-- an AI agent that builds nonprofit websites — read access across ALL
-- nonprofits' website data, plus outbound webhooks for real lifecycle
-- events (site created, published). This is NOT tenant-scoped: a key
-- doesn't belong to one org's data, it belongs to the platform. Every
-- table here has no RLS and no tenant_id, on purpose — access is gated at
-- the application layer (requirePlatformAdmin for management,
-- requireApiScope for the public read routes), and the public/admin routes
-- read through the admin pool rather than a tenant-scoped one.

ALTER TABLE users ADD COLUMN is_platform_admin boolean NOT NULL DEFAULT false;

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  key_hash      text NOT NULL UNIQUE,   -- sha256(raw key); the raw key is shown once at creation and never stored
  key_prefix    text NOT NULL,          -- first 12 chars, for display ("dw_live_ab12...") without exposing the key
  scopes        text[] NOT NULL DEFAULT '{websites:read}',
  created_by    uuid NOT NULL REFERENCES users(id),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_active_idx ON api_keys (revoked_at);
CREATE TRIGGER api_keys_updated BEFORE UPDATE ON api_keys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- No DELETE: revocation is a status change (revoked_at), so the audit trail
-- of what a key could once do stays intact — same reasoning as
-- site_intake_answers (0014_website_intake.sql).
GRANT SELECT, INSERT, UPDATE ON api_keys TO deedwell_app;

CREATE TABLE webhook_subscriptions (
  id                 uuid PRIMARY KEY,
  url                text NOT NULL,
  description        text,
  event_types        text[] NOT NULL,
  secret_ciphertext  bytea NOT NULL,   -- AES-256-GCM(signing secret) — same shape as google_sessions (0018_ad_grants.sql)
  secret_iv          bytea NOT NULL,
  secret_tag         bytea NOT NULL,
  secret_key_version integer NOT NULL DEFAULT 1,
  is_active          boolean NOT NULL DEFAULT true,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_subscriptions_active_idx ON webhook_subscriptions (is_active);
CREATE TRIGGER webhook_subscriptions_updated BEFORE UPDATE ON webhook_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_subscriptions TO deedwell_app;

CREATE TABLE webhook_deliveries (
  id               uuid PRIMARY KEY,
  subscription_id  uuid NOT NULL REFERENCES webhook_subscriptions(id),
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,  -- always carries its own siteId/orgId — a delivery isn't otherwise scoped to one org
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','success','failed')),
  attempt_count    integer NOT NULL DEFAULT 0,
  last_attempt_at  timestamptz,
  response_status  integer,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_subscription_idx ON webhook_deliveries (subscription_id, created_at DESC);
CREATE INDEX webhook_deliveries_pending_idx ON webhook_deliveries (status) WHERE status = 'pending';
-- No updated_at/trigger: deliveries are append-then-status-update log rows,
-- not editable records — matches workflow_steps (0001_init.sql).
GRANT SELECT, INSERT, UPDATE ON webhook_deliveries TO deedwell_app;
