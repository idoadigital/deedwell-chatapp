-- Messages become editable and deletable by their author (and deletable by
-- an admin), without losing the record: an edit keeps its previous body in
-- message_edits, and a delete is a tombstone (deleted_at) rather than a
-- removed row, so replies and reactions keep their context.
ALTER TABLE messages ADD COLUMN edited_at timestamptz;
ALTER TABLE messages ADD COLUMN deleted_at timestamptz;
ALTER TABLE messages ADD COLUMN deleted_by uuid REFERENCES users(id);
GRANT UPDATE ON messages TO deedwell_app;

CREATE TABLE message_edits (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES organizations(id),
  message_id    uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  previous_body text NOT NULL,
  edited_by     uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_edits_message_idx ON message_edits (message_id, created_at);
ALTER TABLE message_edits ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_edits_tenant ON message_edits
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT ON message_edits TO deedwell_app;
