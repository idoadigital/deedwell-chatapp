-- Emoji reactions on chat messages.
--
-- `messages` is deliberately append-only (0004_chat.sql grants only SELECT and
-- INSERT), so a reaction cannot be a column on the message — it is its own
-- row, inserted and deleted independently. That also makes "who reacted"
-- answerable, which a counter on the message never could be.
--
-- The unique constraint is what makes the toggle safe: reacting twice with the
-- same emoji is not an error to handle in application code, it is a state the
-- database will not represent.

CREATE TABLE message_reactions (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES organizations(id),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id),
  emoji      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_reactions_once UNIQUE (message_id, user_id, emoji)
);
CREATE INDEX message_reactions_message_idx ON message_reactions (message_id);
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_reactions_tenant ON message_reactions
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
-- DELETE is granted here, unlike messages: removing your own reaction is not
-- editing history, and the policy above still pins it to the tenant.
GRANT SELECT, INSERT, DELETE ON message_reactions TO deedwell_app;
