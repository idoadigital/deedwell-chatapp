-- Google Ads: campaigns are built automatically from an approved strategy,
-- and every draft carries creatives (generated images, sitelinks, callouts)
-- that are reviewed with the ads and attached to the campaign on publish.
--
--   google_ads_build_jobs     One queued build per campaign recommendation
--                             of an approved strategy. The worker turns it
--                             into a draft (copy, keywords, text assets) and
--                             then renders the image creatives.
--   google_ads_draft_assets   Creatives of a draft: image (stored bytes),
--                             sitelink, callout. Reviewed like ads; published
--                             as campaign-level assets after the campaign.

CREATE TABLE google_ads_build_jobs (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES organizations(id),
  account_id      uuid NOT NULL REFERENCES google_ads_accounts(id) ON DELETE CASCADE,
  strategy_id     uuid NOT NULL REFERENCES google_ads_strategies(id) ON DELETE CASCADE,
  campaign_index  integer NOT NULL DEFAULT 0,
  campaign_name   text,
  instructions    text,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  -- 'campaign' while the copy is drafted, 'creatives' while images render.
  stage           text,
  draft_id        uuid REFERENCES google_ads_drafts(id) ON DELETE SET NULL,
  attempts        integer NOT NULL DEFAULT 0,
  claimed_by      text,
  claimed_at      timestamptz,
  error           text,
  requested_by    uuid NOT NULL REFERENCES users(id),
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_ads_build_jobs_queue_idx ON google_ads_build_jobs (status, created_at) WHERE status IN ('queued','running');
CREATE INDEX google_ads_build_jobs_strategy_idx ON google_ads_build_jobs (strategy_id, created_at DESC);
ALTER TABLE google_ads_build_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_ads_build_jobs_tenant ON google_ads_build_jobs
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER google_ads_build_jobs_updated BEFORE UPDATE ON google_ads_build_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON google_ads_build_jobs TO deedwell_app;

CREATE TABLE google_ads_draft_assets (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES organizations(id),
  account_id       uuid NOT NULL REFERENCES google_ads_accounts(id) ON DELETE CASCADE,
  draft_id         uuid NOT NULL REFERENCES google_ads_drafts(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('image','sitelink','callout')),
  -- Images only: Google's Search image asset ratios.
  aspect           text CHECK (aspect IN ('landscape','square')),
  position         integer NOT NULL DEFAULT 0,
  title            text NOT NULL,
  -- sitelink {linkText, description1, description2, finalUrl}
  -- callout  {text}
  -- image    {prompt, altText, model}
  content          jsonb NOT NULL DEFAULT '{}',
  storage_key      text,
  mime             text,
  size_bytes       integer,
  width            integer,
  height           integer,
  -- 'draft' = image not rendered yet; the build job moves it on.
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','awaiting_approval','approved','rejected','publishing','published','failed')),
  validation       jsonb NOT NULL DEFAULT '{}',
  error            text,
  created_by       uuid REFERENCES users(id),
  edited_by        uuid REFERENCES users(id),
  approved_by      uuid REFERENCES users(id),
  approved_at      timestamptz,
  rejected_reason  text,
  google_asset_id  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_ads_draft_assets_draft_idx ON google_ads_draft_assets (draft_id, kind, position);
ALTER TABLE google_ads_draft_assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_ads_draft_assets_tenant ON google_ads_draft_assets
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER google_ads_draft_assets_updated BEFORE UPDATE ON google_ads_draft_assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON google_ads_draft_assets TO deedwell_app;
