-- The deedwell.org public intake flow (a nonprofit answering the "free
-- website" questionnaire) does NOT start Deedwell's own internal AI build
-- workflow (WEBSITE_BUILD_WORKFLOW, website-domain's Ava/Leo/Noah/Emma
-- agents — that stays exactly as it was, still reachable from the chat app).
-- It only collects and stores intake data for an external partner
-- application to read via the public API and build the site itself,
-- reporting back a finished URL when done. `sites` already fits as the
-- tracking record (slug, name, status) — these two columns are what's
-- missing: which pipeline a site belongs to, and where the finished site
-- ends up once a partner has built it.

ALTER TABLE sites ADD COLUMN source text NOT NULL DEFAULT 'internal'
  CHECK (source IN ('internal', 'external_partner'));
ALTER TABLE sites ADD COLUMN external_build_url text;
