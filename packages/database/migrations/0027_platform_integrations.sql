-- Platform-level OAuth applications, owned by Deedwell rather than by any
-- tenant. This is the half of the architecture that makes "configure once,
-- every workspace connects" possible:
--
--   platform_integrations   Deedwell's Meta app / Google OAuth client.
--                           Platform admins only. One row per (provider,
--                           environment) so development never borrows
--                           production secrets.
--   connector_connections   (0026) one tenant's authorization of their own
--                           Facebook Page / Instagram / Google account.
--
-- The client secret is AES-GCM sealed with the same envelope as every other
-- secret here, and no route ever returns it — the API exposes only a masked
-- hint like "123••••789".

CREATE TABLE platform_integrations (
  id                      uuid PRIMARY KEY,
  provider                text NOT NULL,
  environment             text NOT NULL DEFAULT 'production'
                          CHECK (environment IN ('development', 'production')),
  client_id               text,
  encrypted_client_secret bytea,
  secret_iv               bytea,
  secret_tag              bytea,
  key_version             integer NOT NULL DEFAULT 1,
  /* Masked tail of the secret, for the "••••AB12" display. Never the secret. */
  secret_hint             text,
  /* Provider-specific admin-recorded state: Meta App Review status, Google
     consent-screen mode — things no API will tell us, so an administrator
     records them rather than the UI inventing a green tick. */
  configuration           jsonb NOT NULL DEFAULT '{}',
  status                  text NOT NULL DEFAULT 'not_configured'
                          CHECK (status IN ('not_configured', 'configured', 'needs_attention', 'disabled')),
  status_detail           text,
  validated_at            timestamptz,
  configured_by           uuid REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_integrations_provider_env_idx
  ON platform_integrations (provider, environment);
CREATE TRIGGER platform_integrations_updated BEFORE UPDATE ON platform_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- No tenant_id and therefore no RLS: gated by requirePlatformAdmin at the
-- route layer, the same as api_keys and platform_stripe_config.
GRANT SELECT, INSERT, UPDATE ON platform_integrations TO deedwell_app;

-- Content Studio approval. A design is generated, then a human decides — only
-- approved designs can be published or scheduled, which is enforced in the
-- publish path rather than only in the UI.
ALTER TABLE content_assets ADD COLUMN approval text NOT NULL DEFAULT 'pending'
  CHECK (approval IN ('pending', 'approved', 'rejected'));
ALTER TABLE content_assets ADD COLUMN approved_by uuid REFERENCES users(id);
ALTER TABLE content_assets ADD COLUMN approved_at timestamptz;
GRANT UPDATE ON content_assets TO deedwell_app;

-- The worker claims work with SKIP LOCKED; these support that and the
-- idempotency guard below.
ALTER TABLE scheduled_posts ADD COLUMN content_asset_id uuid REFERENCES content_assets(id);
ALTER TABLE scheduled_posts ADD COLUMN idempotency_key text;
ALTER TABLE scheduled_posts ADD COLUMN next_attempt_at timestamptz;
ALTER TABLE scheduled_posts ADD COLUMN locked_at timestamptz;
-- One publish per (asset, connector). A retry re-uses the row; a double
-- submit cannot create a second post to the same account.
CREATE UNIQUE INDEX scheduled_posts_idempotency_idx
  ON scheduled_posts (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
