-- Prepaid token-credit billing (Stripe Checkout). platform_stripe_config holds
-- the ONE platform-wide Stripe credential, entered via Platform Admin — not
-- per-org, so no tenant_id/RLS (gated by requirePlatformAdmin at the route
-- layer, same as api_keys/webhook_subscriptions). billing_accounts holds one
-- balance per org (mirrors google_oauth_connections' one-row-per-tenant
-- shape); billing_transactions logs every top-up attempt through to
-- completion with the same pending->completed/failed transition convention
-- as google_oauth_states.

CREATE TABLE platform_stripe_config (
  id uuid PRIMARY KEY,
  encrypted_secret_key bytea NOT NULL,
  secret_key_iv bytea NOT NULL,
  secret_key_tag bytea NOT NULL,
  encrypted_webhook_secret bytea NOT NULL,
  webhook_iv bytea NOT NULL,
  webhook_tag bytea NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  secret_key_last4 text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  set_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX platform_stripe_config_status_idx ON platform_stripe_config (status);
GRANT SELECT, INSERT, UPDATE ON platform_stripe_config TO deedwell_app;

CREATE TABLE billing_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL UNIQUE REFERENCES organizations(id),
  stripe_customer_id text,
  token_balance bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE billing_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_accounts_tenant ON billing_accounts
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER billing_accounts_updated BEFORE UPDATE ON billing_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE ON billing_accounts TO deedwell_app;

CREATE TABLE billing_transactions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organizations(id),
  created_by uuid REFERENCES users(id),
  package_id text NOT NULL,
  token_amount bigint NOT NULL,
  amount_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  stripe_checkout_session_id text UNIQUE,
  stripe_payment_intent_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'expired')),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX billing_transactions_tenant_idx ON billing_transactions (tenant_id, created_at DESC);
ALTER TABLE billing_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_transactions_tenant ON billing_transactions
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON billing_transactions TO deedwell_app;
