-- Evidence Library: a file can now be reusable across every application in
-- the organization instead of being stuck to the one project it was
-- uploaded into.

ALTER TABLE files ALTER COLUMN project_id DROP NOT NULL;

CREATE TABLE file_links (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES organizations(id),
  file_id    uuid NOT NULL REFERENCES files(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  linked_by  uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, project_id)
);
ALTER TABLE file_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY file_links_tenant ON file_links
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT ON file_links TO deedwell_app;

-- Every file uploaded before this migration was implicitly "linked" to the
-- one project it lived in — preserve that so existing compliance/attachment
-- checks keep seeing exactly the files they saw before.
INSERT INTO file_links (id, tenant_id, file_id, project_id, linked_by, created_at)
SELECT gen_random_uuid(), tenant_id, id, project_id, created_by, created_at
FROM files WHERE project_id IS NOT NULL;
