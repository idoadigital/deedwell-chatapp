-- Website design intake (Lovable-style conversational build).
--
-- Design answers are deliberately PER-SITE, not per-organization. Writing
-- "site_tone" into org_facts would pollute the Funding Passport, leak visual
-- preferences into grant narratives via fetch_org_facts, and make a second
-- site silently inherit the first one's brand. The Funding Passport records
-- what is true about the organization; this records what the org wants one
-- particular website to look and sound like.
--
-- Values are jsonb because answers are typed: multiselect returns an array,
-- yes/no returns a boolean, everything else a string. org_facts.value is
-- text, which is why these cannot live there without lossy flattening.

CREATE TABLE site_intake_answers (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES organizations(id),
  site_id      uuid NOT NULL REFERENCES sites(id),
  question_key text NOT NULL,
  value        jsonb NOT NULL,
  answered_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, question_key)
);

CREATE INDEX site_intake_answers_site_idx ON site_intake_answers (site_id);

CREATE TRIGGER site_intake_answers_updated
  BEFORE UPDATE ON site_intake_answers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE site_intake_answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY site_intake_answers_tenant ON site_intake_answers
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

-- Answers are revisable (a user can change their mind about tone before the
-- brief is approved), so UPDATE is granted. No DELETE: clearing an answer is
-- not a thing the product does, and the audit trail is more useful intact.
GRANT SELECT, INSERT, UPDATE ON site_intake_answers TO deedwell_app;
