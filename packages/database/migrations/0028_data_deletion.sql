-- Meta's Data Deletion Callback. Required for App Review: when someone removes
-- Deedwell from their Facebook settings, Meta POSTs a signed request here and
-- expects a confirmation code plus a URL where that person can check what
-- happened. Ignoring it is a compliance failure, not a nicety.
--
-- No tenant_id: the request arrives identified only by a Meta app-scoped user
-- id, so the row is created before we know which workspaces are affected. It
-- is written by the callback (unauthenticated, signature-verified) and read by
-- the public status page, so it deliberately has no RLS — it holds no tenant
-- content, only a provider user id and what we did about it.
CREATE TABLE data_deletion_requests (
  id                uuid PRIMARY KEY,
  provider          text NOT NULL,
  provider_user_id  text NOT NULL,
  confirmation_code text NOT NULL UNIQUE,
  status            text NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received', 'completed', 'nothing_to_delete', 'failed')),
  /* What was actually removed, for the human-readable status page. */
  detail            text,
  connections_removed integer NOT NULL DEFAULT 0,
  posts_cancelled     integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);
CREATE INDEX data_deletion_requests_subject_idx ON data_deletion_requests (provider, provider_user_id);
GRANT SELECT, INSERT, UPDATE ON data_deletion_requests TO deedwell_app;

-- Which Meta user authorized a connection. Without this a deletion request —
-- which identifies a person, not a Page — cannot be matched to anything.
-- Nullable because connections made before this migration never captured it.
ALTER TABLE connector_connections ADD COLUMN provider_user_id text;
CREATE INDEX connector_connections_provider_user_idx
  ON connector_connections (provider, provider_user_id) WHERE provider_user_id IS NOT NULL;
