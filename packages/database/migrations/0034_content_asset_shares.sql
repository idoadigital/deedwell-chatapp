-- Public share links for generated designs.
--
-- A design lives behind the session-gated files endpoint. Sharing one outside
-- the team needs a URL that works with no login, so a share is a random token
-- that maps to one asset; the public route looks the token up and streams the
-- file. Rows are tenant-scoped like everything else (creating/revoking happens
-- inside the org), while the public read goes through the admin pool by token.
-- Revoking sets revoked_at rather than deleting, so the audit trail keeps the
-- fact that it was shared.
CREATE TABLE content_asset_shares (
  token       text PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES organizations(id),
  asset_id    uuid NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
  file_id     uuid NOT NULL REFERENCES files(id),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE INDEX content_asset_shares_asset_idx ON content_asset_shares (asset_id, created_at DESC);
ALTER TABLE content_asset_shares ENABLE ROW LEVEL SECURITY;
CREATE POLICY content_asset_shares_tenant ON content_asset_shares
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON content_asset_shares TO deedwell_app;
