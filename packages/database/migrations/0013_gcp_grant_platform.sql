-- GCP grant platform links: maps this product's tenants, users, and channels
-- onto the external Deedwell grant backend (Cloud Run + Cloud SQL). The
-- browser never sees or supplies these ids — they are created server-side by
-- the provisioning client and resolved under RLS on every request, so a
-- manipulated request cannot reach another tenant's backend state.

-- One backend organization per tenant.
CREATE TABLE gcp_org_links (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES organizations(id) UNIQUE,
  gcp_organization_id  uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE gcp_org_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY gcp_org_links_tenant ON gcp_org_links
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT ON gcp_org_links TO deedwell_app;

-- One backend user per (tenant, user): backend identity is per-org membership.
CREATE TABLE gcp_user_links (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES organizations(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  gcp_user_id   uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
ALTER TABLE gcp_user_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY gcp_user_links_tenant ON gcp_user_links
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT ON gcp_user_links TO deedwell_app;

-- One backend conversation per routed channel. A grant project channel also
-- records the backend application it is bound to — that binding is what makes
-- agent handoffs durable (the workspace survives switching teammates).
-- watch_state is the async bridge's per-channel memory of which backend task
-- states it has already posted as chat messages (task_id -> status), so a
-- restarting server never re-announces finished work.
CREATE TABLE gcp_channel_conversations (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES organizations(id),
  channel_id            uuid NOT NULL REFERENCES channels(id) UNIQUE,
  gcp_conversation_id   uuid NOT NULL,
  gcp_application_id    uuid,
  watch_state           jsonb NOT NULL DEFAULT '{}',
  watch_until           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gcp_channel_conversations_watch_idx
  ON gcp_channel_conversations (watch_until) WHERE watch_until IS NOT NULL;
ALTER TABLE gcp_channel_conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY gcp_channel_conversations_tenant ON gcp_channel_conversations
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON gcp_channel_conversations TO deedwell_app;
