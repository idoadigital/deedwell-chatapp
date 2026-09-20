-- Google Ads campaign requests: a customer asks Deedwell for a campaign from
-- their dashboard; Deedwell administrators receive it, hand it to the Ad
-- Grants account-manager agent, and the request follows the work until the
-- campaign is live.
--
--   google_ads_campaign_requests  The customer's brief and where it stands.
--   google_ads_request_events     Timeline (customer-visible and internal).
--   google_ads_request_runs       Queued work for the account-manager agent;
--                                 the Google Ads worker executes it and the
--                                 result (assessment, questions, plan) is kept.
--   google_ads_strategies.request_id
--                                 The plan the agent writes for a request is
--                                 an ordinary strategy: approving it builds the
--                                 campaigns through the existing pipeline.

CREATE SEQUENCE google_ads_campaign_requests_number_seq;

CREATE TABLE google_ads_campaign_requests (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES organizations(id),
  account_id        uuid REFERENCES google_ads_accounts(id) ON DELETE SET NULL,
  number            integer NOT NULL DEFAULT nextval('google_ads_campaign_requests_number_seq'),
  status            text NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted','in_review','needs_info','in_progress','planned','building','live','completed','declined','cancelled')),
  title             text NOT NULL,
  goal              text NOT NULL
                    CHECK (goal IN ('service_access','volunteering','donations','events','membership','education','partnerships','awareness','other')),
  priority          text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','urgent')),
  -- The brief as the customer entered it: program, audience, desired action,
  -- landing page, geography, languages, timing, budget preference, key
  -- messages, keyword ideas, things to avoid, notes — plus pendingQuestions
  -- and answers[] as the conversation goes on.
  content           jsonb NOT NULL DEFAULT '{}',
  -- Plain-language status note the customer sees (set by an admin or copied
  -- from the agent's customer summary).
  customer_message  text,
  admin_notes       text,
  agent_key         text,
  handed_off_by     uuid REFERENCES users(id),
  handed_off_at     timestamptz,
  strategy_id       uuid REFERENCES google_ads_strategies(id) ON DELETE SET NULL,
  live_campaign_id  text,
  decided_by        uuid REFERENCES users(id),
  decided_at        timestamptz,
  decline_reason    text,
  created_by        uuid NOT NULL REFERENCES users(id),
  submitted_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX google_ads_campaign_requests_number_idx ON google_ads_campaign_requests (number);
CREATE INDEX google_ads_campaign_requests_tenant_idx ON google_ads_campaign_requests (tenant_id, created_at DESC);
CREATE INDEX google_ads_campaign_requests_open_idx ON google_ads_campaign_requests (status, created_at DESC)
  WHERE status NOT IN ('completed','declined','cancelled');
ALTER TABLE google_ads_campaign_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_ads_campaign_requests_tenant ON google_ads_campaign_requests
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER google_ads_campaign_requests_updated BEFORE UPDATE ON google_ads_campaign_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON google_ads_campaign_requests TO deedwell_app;
GRANT USAGE, SELECT ON SEQUENCE google_ads_campaign_requests_number_seq TO deedwell_app;

CREATE TABLE google_ads_request_events (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES organizations(id),
  request_id        uuid NOT NULL REFERENCES google_ads_campaign_requests(id) ON DELETE CASCADE,
  kind              text NOT NULL,
  actor_kind        text NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user','admin','system','ai')),
  actor_user_id     uuid REFERENCES users(id),
  from_status       text,
  to_status         text,
  message           text,
  metadata          jsonb NOT NULL DEFAULT '{}',
  customer_visible  boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_ads_request_events_request_idx ON google_ads_request_events (request_id, created_at);
ALTER TABLE google_ads_request_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_ads_request_events_tenant ON google_ads_request_events
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT ON google_ads_request_events TO deedwell_app;

CREATE TABLE google_ads_request_runs (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES organizations(id),
  request_id    uuid NOT NULL REFERENCES google_ads_campaign_requests(id) ON DELETE CASCADE,
  agent_key     text NOT NULL,
  instructions  text,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  attempts      integer NOT NULL DEFAULT 0,
  claimed_by    text,
  claimed_at    timestamptz,
  -- The agent's schema-validated output: decision, assessment, policy
  -- checks, questions, measurement registry, utilization, plan, next steps.
  result        jsonb NOT NULL DEFAULT '{}',
  error         text,
  requested_by  uuid REFERENCES users(id),
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_ads_request_runs_queue_idx ON google_ads_request_runs (status, created_at) WHERE status IN ('queued','running');
CREATE INDEX google_ads_request_runs_request_idx ON google_ads_request_runs (request_id, created_at DESC);
ALTER TABLE google_ads_request_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_ads_request_runs_tenant ON google_ads_request_runs
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER google_ads_request_runs_updated BEFORE UPDATE ON google_ads_request_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON google_ads_request_runs TO deedwell_app;

ALTER TABLE google_ads_strategies ADD COLUMN request_id uuid REFERENCES google_ads_campaign_requests(id) ON DELETE SET NULL;
CREATE INDEX google_ads_strategies_request_idx ON google_ads_strategies (request_id) WHERE request_id IS NOT NULL;
