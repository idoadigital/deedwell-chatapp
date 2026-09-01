-- Admin<->org support messaging: a platform admin messaging a specific org
-- when there's an issue. Deliberately separate from the AI-teammate
-- channels/messages tables — those have no identity for "a Deedwell staff
-- member, not a member of this org," and messages.author_kind's CHECK
-- constraint (user/agent/system) has no room for one either. One thread
-- per org, auto-created on first message.

CREATE TABLE support_threads (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL UNIQUE REFERENCES organizations(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE support_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY support_threads_tenant ON support_threads
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT ON support_threads TO deedwell_app;

CREATE TABLE support_messages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organizations(id),
  thread_id uuid NOT NULL REFERENCES support_threads(id),
  author_kind text NOT NULL CHECK (author_kind IN ('org_user', 'platform_admin')),
  author_user_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_messages_thread_idx ON support_messages (thread_id, created_at);
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY support_messages_tenant ON support_messages
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT ON support_messages TO deedwell_app;

-- Unread tracking — one mechanism (a "last seen" timestamp per membership),
-- two consumers: the Co-Workers unread badge and the support-thread badge.
-- No per-channel/per-message read table; "opened the surface at all" is
-- enough signal for a dashboard badge, not a full per-item inbox.
ALTER TABLE organization_memberships ADD COLUMN coworkers_last_seen_at timestamptz;
ALTER TABLE organization_memberships ADD COLUMN support_last_seen_at timestamptz;
