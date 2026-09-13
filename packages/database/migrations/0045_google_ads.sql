-- Google Ads management: Deedwell runs a customer's Google Ads account from
-- its manager (MCC) account, with AI drafting strategies and campaigns that
-- a Deedwell administrator reviews and explicitly publishes.
--
--   google_ads_platform_settings  Deedwell's own credentials (developer
--                                 token, manager customer id, the manager
--                                 Google user's refresh token). Platform
--                                 admins only; no tenant, so no RLS.
--   google_ads_accounts           One tenant's chosen Google Ads customer and
--                                 where it is in the connection state machine.
--   google_ads_campaigns/ad_groups/ads/keywords
--                                 Read-side snapshots synced from the API.
--   google_ads_metrics_daily      Daily performance by account/campaign/ad.
--   google_ads_strategies         AI-drafted advertising strategies
--                                 (draft → approved → archived).
--   google_ads_drafts + _draft_ads
--                                 AI-drafted campaigns awaiting review; each
--                                 ad carries its own approval state.
--   google_ads_publish_jobs       The one path that mutates Google Ads.
--   google_ads_activity           Human-readable history per account.
--   google_ads_compliance_rules   Configurable Ad Grants checks (seeded
--                                 disabled; thresholds are set by an admin
--                                 from Google's current policy, never here).

CREATE TABLE google_ads_platform_settings (
  id                         uuid PRIMARY KEY,
  environment                text NOT NULL UNIQUE CHECK (environment IN ('development','production')),
  api_version                text NOT NULL DEFAULT 'v25',
  manager_customer_id        text,
  developer_token_encrypted  bytea,
  developer_token_iv         bytea,
  developer_token_tag        bytea,
  developer_token_hint       text,
  -- The Google user that administers the manager account. Its refresh token
  -- is what lets Deedwell read and write linked customer accounts long after
  -- a customer's own consent token has expired.
  manager_refresh_encrypted  bytea,
  manager_refresh_iv         bytea,
  manager_refresh_tag        bytea,
  manager_account_email      text,
  manager_status             text NOT NULL DEFAULT 'not_connected'
                             CHECK (manager_status IN ('not_connected','connected','needs_attention')),
  manager_status_detail      text,
  manager_connected_by       uuid REFERENCES users(id),
  manager_connected_at       timestamptz,
  key_version                integer NOT NULL DEFAULT 1,
  updated_by                 uuid REFERENCES users(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER google_ads_platform_settings_updated BEFORE UPDATE ON google_ads_platform_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE ON google_ads_platform_settings TO deedwell_app;

-- Single-use hashed state for the manager account's OAuth round trip.
CREATE TABLE google_ads_manager_oauth_states (
  id          uuid PRIMARY KEY,
  state_hash  text NOT NULL UNIQUE,
  created_by  uuid NOT NULL REFERENCES users(id),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON google_ads_manager_oauth_states TO deedwell_app;

CREATE TABLE google_ads_accounts (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES organizations(id),
  -- The Google account whose consent token discovered and accepted the link.
  connection_id         uuid REFERENCES connector_connections(id),
  customer_id           text NOT NULL,           -- digits only, no dashes
  descriptive_name      text,
  currency_code         text,
  time_zone             text,
  is_manager            boolean NOT NULL DEFAULT false,
  is_test_account       boolean NOT NULL DEFAULT false,
  account_kind          text NOT NULL DEFAULT 'unknown'
                        CHECK (account_kind IN ('unknown','standard','ad_grants')),
  status                text NOT NULL DEFAULT 'oauth_connected'
                        CHECK (status IN ('not_connected','oauth_connected','account_selected','manager_link_pending',
                                          'connected','authorization_expired','disconnected','error')),
  status_detail         text,
  manager_link_status   text NOT NULL DEFAULT 'unknown'
                        CHECK (manager_link_status IN ('unknown','none','pending','active','refused','cancelled','inactive')),
  manager_link_resource text,
  manager_customer_id   text,
  connected_by_user_id  uuid NOT NULL REFERENCES users(id),
  connected_at          timestamptz,
  disconnected_at       timestamptz,
  last_sync_at          timestamptz,
  last_sync_error       text,
  metadata              jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- One live account per organization, and one organization per account.
CREATE UNIQUE INDEX google_ads_accounts_live_tenant_idx ON google_ads_accounts (tenant_id) WHERE status <> 'disconnected';
CREATE UNIQUE INDEX google_ads_accounts_live_customer_idx ON google_ads_accounts (customer_id) WHERE status <> 'disconnected';
CREATE INDEX google_ads_accounts_sync_idx ON google_ads_accounts (last_sync_at) WHERE status = 'connected';
ALTER TABLE google_ads_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_ads_accounts_tenant ON google_ads_accounts
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER google_ads_accounts_updated BEFORE UPDATE ON google_ads_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON google_ads_accounts TO deedwell_app;

CREATE TABLE google_ads_campaigns (
  id                        uuid PRIMARY KEY,
  tenant_id                 uuid NOT NULL REFERENCES organizations(id),
  account_id                uuid NOT NULL REFERENCES google_ads_accounts(id) ON DELETE CASCADE,
  campaign_id               text NOT NULL,
  name                      text NOT NULL,
  status                    text NOT NULL,          -- ENABLED | PAUSED | REMOVED | UNKNOWN
  serving_status            text,
  advertising_channel_type  text,
  bidding_strategy_type     text,
  budget_resource           text,
  budget_micros             bigint,
  start_date                date,
  end_date                  date,
  -- Set when Deedwell created the campaign from a reviewed draft.
  draft_id                  uuid,
  raw                       jsonb NOT NULL DEFAULT '{}',
  synced_at                 timestamptz NOT NULL DEFAULT now(),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, campaign_id)
);
CREATE INDEX google_ads_campaigns_tenant_idx ON google_ads_campaigns (tenant_id, account_id);
ALTER TABLE google_ads_campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_ads_campaigns_tenant ON google_ads_campaigns
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER google_ads_campaigns_updated BEFORE UPDATE ON google_ads_campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON google_ads_campaigns TO deedwell_app;

CREATE TABLE google_ads_ad_groups (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES organizations(id),
  account_id      uuid NOT NULL REFERENCES google_ads_accounts(id) ON DELETE CASCADE,
  ad_group_id     text NOT NULL,
  campaign_id     text NOT NULL,
  name            text NOT NULL,
  status          text NOT NULL,
  type            text,
  cpc_bid_micros  bigint,
  raw             jsonb NOT NULL DEFAULT '{}',
  synced_at       timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, ad_group_id)
);
CREATE INDEX google_ads_ad_groups_campaign_idx ON google_ads_ad_groups (account_id, campaign_id);
ALTER TABLE google_ads_ad_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_ads_ad_groups_tenant ON google_ads_ad_groups
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER google_ads_ad_groups_updated BEFORE UPDATE ON google_ads_ad_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON google_ads_ad_groups TO deedwell_app;

CREATE TABLE google_ads_ads (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES organizations(id),
  account_id       uuid NOT NULL REFERENCES google_ads_accounts(id) ON DELETE CASCADE,
  ad_id            text NOT NULL,
  ad_group_id      text NOT NULL,
  campaign_id      text NOT NULL,
  ad_type          text,
  status           text NOT NULL,           -- ENABLED | PAUSED | REMOVED
  name             text,
  headlines        jsonb NOT NULL DEFAULT '[]',
  descriptions     jsonb NOT NULL DEFAULT '[]',
  final_urls       jsonb NOT NULL DEFAULT '[]',
  paths            jsonb NOT NULL DEFAULT '[]',
  approval_status  text,                    -- policy_summary.approval_status
  review_status    text,
  policy_topics    jsonb NOT NULL DEFAULT '[]',
  -- Set when Deedwell created the ad from a reviewed draft.
  draft_ad_id      uuid,
  raw              jsonb NOT NULL DEFAULT '{}',
  synced_at        timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, ad_id)
);
CREATE INDEX google_ads_ads_group_idx ON google_ads_ads (account_id, ad_group_id);
ALTER TABLE google_ads_ads ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_ads_ads_tenant ON google_ads_ads
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER google_ads_ads_updated BEFORE UPDATE ON google_ads_ads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON google_ads_ads TO deedwell_app;

CREATE TABLE google_ads_keywords (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES organizations(id),
  account_id     uuid NOT NULL REFERENCES google_ads_accounts(id) ON DELETE CASCADE,
  criterion_id   text NOT NULL,
  campaign_id    text NOT NULL,
  ad_group_id    text,                      -- NULL for campaign-level negatives
  text           text NOT NULL,
  match_type     text,
  status         text,
  negative       boolean NOT NULL DEFAULT false,
  quality_score  integer,
  raw            jsonb NOT NULL DEFAULT '{}',
  synced_at      timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, campaign_id, ad_group_id, criterion_id)
);
CREATE INDEX google_ads_keywords_group_idx ON google_ads_keywords (account_id, ad_group_id);
ALTER TABLE google_ads_keywords ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_ads_keywords_tenant ON google_ads_keywords
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON google_ads_keywords TO deedwell_app;

CREATE TABLE google_ads_metrics_daily (
  tenant_id          uuid NOT NULL REFERENCES organizations(id),
  account_id         uuid NOT NULL REFERENCES google_ads_accounts(id) ON DELETE CASCADE,
  level              text NOT NULL CHECK (level IN ('account','campaign','ad_group','ad')),
  entity_id          text NOT NULL,          -- 'account' | campaign_id | ad_group_id | ad_id
  day                date NOT NULL,
  impressions        bigint NOT NULL DEFAULT 0,
  clicks             bigint NOT NULL DEFAULT 0,
  cost_micros        bigint NOT NULL DEFAULT 0,
  conversions        numeric(14,3) NOT NULL DEFAULT 0,
  conversions_value  numeric(16,3) NOT NULL DEFAULT 0,
  synced_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, level, entity_id, day)
);
CREATE INDEX google_ads_metrics_daily_tenant_idx ON google_ads_metrics_daily (tenant_id, account_id, level, day);
ALTER TABLE google_ads_metrics_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_ads_metrics_daily_tenant ON google_ads_metrics_daily
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON google_ads_metrics_daily TO deedwell_app;

CREATE TABLE google_ads_strategies (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES organizations(id),
  account_id   uuid NOT NULL REFERENCES google_ads_accounts(id) ON DELETE CASCADE,
  version      integer NOT NULL DEFAULT 1,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','archived')),
  title        text NOT NULL,
  -- The structured proposal (objective, audiences, themes, campaigns,
  -- landing pages, keyword themes, negatives, goals, budget, opportunities,
  -- Ad Grants notes). Editable by an administrator before approval.
  content      jsonb NOT NULL DEFAULT '{}',
  model_meta   jsonb NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES users(id),
  approved_by  uuid REFERENCES users(id),
  approved_at  timestamptz,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_ads_strategies_account_idx ON google_ads_strategies (account_id, created_at DESC);
ALTER TABLE google_ads_strategies ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_ads_strategies_tenant ON google_ads_strategies
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER google_ads_strategies_updated BEFORE UPDATE ON google_ads_strategies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON google_ads_strategies TO deedwell_app;

CREATE TABLE google_ads_drafts (
  id                     uuid PRIMARY KEY,
  tenant_id              uuid NOT NULL REFERENCES organizations(id),
  account_id             uuid NOT NULL REFERENCES google_ads_accounts(id) ON DELETE CASCADE,
  strategy_id            uuid REFERENCES google_ads_strategies(id),
  status                 text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','awaiting_approval','approved','rejected','publishing','published','failed')),
  name                   text NOT NULL,
  -- {objective, channelType, landingPage, dailyBudgetMicros, currencyCode,
  --  adGroups:[{key,name,keywords:[{text,matchType}],negativeKeywords:[...]}],
  --  negativeKeywords:[...], geoTargets:[...], rationale}
  content                jsonb NOT NULL DEFAULT '{}',
  validation             jsonb NOT NULL DEFAULT '{}',
  model_meta             jsonb NOT NULL DEFAULT '{}',
  created_by             uuid REFERENCES users(id),
  approved_by            uuid REFERENCES users(id),
  approved_at            timestamptz,
  rejected_reason        text,
  published_campaign_id  text,
  publish_job_id         uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_ads_drafts_account_idx ON google_ads_drafts (account_id, created_at DESC);
ALTER TABLE google_ads_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_ads_drafts_tenant ON google_ads_drafts
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER google_ads_drafts_updated BEFORE UPDATE ON google_ads_drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON google_ads_drafts TO deedwell_app;

CREATE TABLE google_ads_draft_ads (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES organizations(id),
  account_id       uuid NOT NULL REFERENCES google_ads_accounts(id) ON DELETE CASCADE,
  draft_id         uuid NOT NULL REFERENCES google_ads_drafts(id) ON DELETE CASCADE,
  ad_group_key     text NOT NULL,
  position         integer NOT NULL DEFAULT 0,
  title            text NOT NULL,
  ad_type          text NOT NULL DEFAULT 'RESPONSIVE_SEARCH_AD',
  headlines        jsonb NOT NULL DEFAULT '[]',
  descriptions     jsonb NOT NULL DEFAULT '[]',
  final_url        text NOT NULL,
  path1            text,
  path2            text,
  rationale        text,
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','awaiting_approval','approved','rejected','publishing','published','failed')),
  validation       jsonb NOT NULL DEFAULT '{}',
  created_by       uuid REFERENCES users(id),
  edited_by        uuid REFERENCES users(id),
  approved_by      uuid REFERENCES users(id),
  approved_at      timestamptz,
  rejected_reason  text,
  google_ad_id     text,
  google_ad_group_id text,
  google_campaign_id text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_ads_draft_ads_draft_idx ON google_ads_draft_ads (draft_id, position);
CREATE INDEX google_ads_draft_ads_account_idx ON google_ads_draft_ads (account_id, created_at DESC);
ALTER TABLE google_ads_draft_ads ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_ads_draft_ads_tenant ON google_ads_draft_ads
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER google_ads_draft_ads_updated BEFORE UPDATE ON google_ads_draft_ads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON google_ads_draft_ads TO deedwell_app;

CREATE TABLE google_ads_publish_jobs (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES organizations(id),
  account_id     uuid NOT NULL REFERENCES google_ads_accounts(id) ON DELETE CASCADE,
  draft_id       uuid NOT NULL REFERENCES google_ads_drafts(id) ON DELETE CASCADE,
  -- What the administrator confirmed: org, customer id, campaign, budget,
  -- ad groups, ads, landing URLs. The worker re-verifies against it.
  summary        jsonb NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  attempts       integer NOT NULL DEFAULT 0,
  claimed_by     text,
  claimed_at     timestamptz,
  result         jsonb NOT NULL DEFAULT '{}',
  error          text,
  requested_by   uuid NOT NULL REFERENCES users(id),
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_ads_publish_jobs_queue_idx ON google_ads_publish_jobs (status, created_at) WHERE status IN ('queued','running');
ALTER TABLE google_ads_publish_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_ads_publish_jobs_tenant ON google_ads_publish_jobs
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER google_ads_publish_jobs_updated BEFORE UPDATE ON google_ads_publish_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON google_ads_publish_jobs TO deedwell_app;

CREATE TABLE google_ads_activity (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES organizations(id),
  account_id      uuid REFERENCES google_ads_accounts(id) ON DELETE SET NULL,
  customer_id     text,
  actor_user_id   uuid REFERENCES users(id),
  actor_kind      text NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user','admin','system','ai')),
  action          text NOT NULL,
  entity_type     text,
  entity_id       text,
  previous_state  text,
  new_state       text,
  summary         text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_ads_activity_tenant_idx ON google_ads_activity (tenant_id, created_at DESC);
ALTER TABLE google_ads_activity ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_ads_activity_tenant ON google_ads_activity
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT ON google_ads_activity TO deedwell_app;

-- Ad Grants compliance checks. Rules are data, not code: an administrator
-- enables a rule and sets its threshold after checking Google's current
-- policy. Nothing is enabled or thresholded by default.
CREATE TABLE google_ads_compliance_rules (
  id           uuid PRIMARY KEY,
  key          text NOT NULL UNIQUE,
  label        text NOT NULL,
  description  text NOT NULL,
  metric       text NOT NULL,          -- see packages/google-ads-domain compliance.ts
  comparator   text NOT NULL CHECK (comparator IN ('gte','lte','gt','lt','eq')),
  threshold    numeric,
  window_days  integer NOT NULL DEFAULT 30,
  enabled      boolean NOT NULL DEFAULT false,
  source_url   text,
  updated_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER google_ads_compliance_rules_updated BEFORE UPDATE ON google_ads_compliance_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON google_ads_compliance_rules TO deedwell_app;

INSERT INTO google_ads_compliance_rules (id, key, label, description, metric, comparator, window_days, source_url) VALUES
  (gen_random_uuid(), 'account_ctr', 'Account click-through rate', 'Account-wide CTR over the window must stay above the threshold Google requires for Ad Grants accounts.', 'account_ctr_percent', 'gte', 30, 'https://support.google.com/grants/answer/9042207'),
  (gen_random_uuid(), 'conversion_tracking', 'Conversion tracking', 'Conversions must be recorded over the window (a value of 0 means tracking is missing or broken).', 'conversions_total', 'gt', 30, 'https://support.google.com/grants/answer/9042207'),
  (gen_random_uuid(), 'keyword_quality', 'Low quality-score keywords', 'Share of enabled keywords whose quality score is at or below 2.', 'low_quality_keyword_percent', 'lte', 30, 'https://support.google.com/grants/answer/9042207'),
  (gen_random_uuid(), 'single_word_keywords', 'Single-word keywords', 'Count of enabled single-word keywords (branded terms and medical conditions are permitted exceptions).', 'single_word_keyword_count', 'lte', 30, 'https://support.google.com/grants/answer/9042207'),
  (gen_random_uuid(), 'account_activity', 'Account activity', 'Days since the account last recorded activity (a login, a change or a sync).', 'days_since_activity', 'lte', 90, 'https://support.google.com/grants/answer/9042207'),
  (gen_random_uuid(), 'policy_issues', 'Policy issues', 'Count of ads that Google has disapproved or limited.', 'disapproved_ad_count', 'lte', 30, 'https://support.google.com/grants/answer/9042207'),
  (gen_random_uuid(), 'ad_group_ads', 'Ads per ad group', 'Minimum number of enabled ads in each enabled ad group.', 'min_ads_per_ad_group', 'gte', 30, 'https://support.google.com/grants/answer/9042207');
