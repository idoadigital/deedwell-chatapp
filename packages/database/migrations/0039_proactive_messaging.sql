-- Proactive agent messaging: structured goal/intent memory, the candidate
-- queue (which is also the cross-agent communication ledger), per-channel
-- read state, and lightweight presence. Additive: nothing existing changes.

-- What the user is trying to accomplish, as the workflows understand it.
CREATE TABLE user_goals (
  id                      uuid PRIMARY KEY,
  tenant_id               uuid NOT NULL REFERENCES organizations(id),
  user_id                 uuid NOT NULL REFERENCES users(id),
  title                   text NOT NULL,
  description             text,
  status                  text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','in_progress','blocked','completed','abandoned','unknown')),
  priority                integer NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  target_date             date,
  originating_channel_id  uuid REFERENCES channels(id),
  -- Plain ids, not foreign keys: a reference would key-share-lock the run row
  -- and make the engine's FOR UPDATE SKIP LOCKED claim skip it mid-flight.
  originating_run_id      uuid,
  -- One goal per subject (e.g. run:<id>), so events upsert rather than duplicate.
  subject_key             text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_key)
);
CREATE INDEX user_goals_user_idx ON user_goals (tenant_id, user_id, status);
ALTER TABLE user_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_goals_tenant ON user_goals USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON user_goals TO deedwell_app;
CREATE TRIGGER user_goals_updated BEFORE UPDATE ON user_goals FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The unit of unfinished work: which agent, what is next, who must act.
CREATE TABLE user_intents (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES organizations(id),
  user_id               uuid NOT NULL REFERENCES users(id),
  goal_id               uuid REFERENCES user_goals(id),
  agent_key             text NOT NULL,
  intent                text NOT NULL,
  status                text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','waiting_on_user','waiting_on_agent','in_progress','completed','blocked','abandoned','unknown')),
  next_expected_action  text,
  next_expected_actor   text CHECK (next_expected_actor IN ('user','agent')),
  follow_up_eligible_at timestamptz,
  last_activity_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz,
  channel_id            uuid REFERENCES channels(id),
  run_id                uuid,
  subject_key           text NOT NULL,
  metadata              jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_key)
);
CREATE INDEX user_intents_user_idx ON user_intents (tenant_id, user_id, status);
CREATE INDEX user_intents_run_idx ON user_intents (run_id);
ALTER TABLE user_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_intents_tenant ON user_intents USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON user_intents TO deedwell_app;
CREATE TRIGGER user_intents_updated BEFORE UPDATE ON user_intents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every proposal an agent makes, through its whole lifecycle. Delivered rows
-- double as the cross-agent ledger: who last reached out, about what, and
-- whether the user answered.
CREATE TABLE proactive_candidates (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES organizations(id),
  user_id               uuid NOT NULL REFERENCES users(id),
  agent_key             text NOT NULL,
  channel_id            uuid REFERENCES channels(id),
  intent_id             uuid REFERENCES user_intents(id),
  goal_id               uuid REFERENCES user_goals(id),
  type                  text NOT NULL,
  reason                text NOT NULL,
  proposed_message      text,
  importance            integer NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  urgency               integer NOT NULL DEFAULT 2 CHECK (urgency BETWEEN 1 AND 5),
  requires_response     boolean NOT NULL DEFAULT false,
  -- Same subject → same key, so a duplicate from another agent is visible.
  subject_key           text NOT NULL,
  status                text NOT NULL DEFAULT 'candidate' CHECK (status IN
    ('candidate','evaluating','scheduled','approved','delivered','read','responded','expired','suppressed','cancelled')),
  score                 numeric,
  decision              jsonb NOT NULL DEFAULT '{}',
  suggested_send_at     timestamptz NOT NULL DEFAULT now(),
  scheduled_for         timestamptz,
  expires_at            timestamptz,
  evaluations           integer NOT NULL DEFAULT 0,
  delivered_at          timestamptz,
  delivered_message_id  uuid REFERENCES messages(id),
  notified              boolean NOT NULL DEFAULT false,
  read_at               timestamptz,
  responded_at          timestamptz,
  combined_into         uuid REFERENCES proactive_candidates(id),
  related_entity        jsonb NOT NULL DEFAULT '{}',
  metadata              jsonb NOT NULL DEFAULT '{}',
  claimed_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proactive_candidates_due_idx ON proactive_candidates (status, suggested_send_at)
  WHERE status IN ('candidate','scheduled');
CREATE INDEX proactive_candidates_user_idx ON proactive_candidates (tenant_id, user_id, status, created_at);
CREATE INDEX proactive_candidates_intent_idx ON proactive_candidates (intent_id);
ALTER TABLE proactive_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY proactive_candidates_tenant ON proactive_candidates USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON proactive_candidates TO deedwell_app;
CREATE TRIGGER proactive_candidates_updated BEFORE UPDATE ON proactive_candidates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Observability: every lifecycle transition and why.
CREATE TABLE proactive_log (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES organizations(id),
  candidate_id  uuid REFERENCES proactive_candidates(id),
  event         text NOT NULL,
  reason        text,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proactive_log_tenant_idx ON proactive_log (tenant_id, created_at);
CREATE INDEX proactive_log_candidate_idx ON proactive_log (candidate_id);
ALTER TABLE proactive_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY proactive_log_tenant ON proactive_log USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT ON proactive_log TO deedwell_app;

-- Per-user, per-channel read marker. Absent row = never opened.
CREATE TABLE channel_reads (
  tenant_id     uuid NOT NULL REFERENCES organizations(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  channel_id    uuid NOT NULL REFERENCES channels(id),
  last_read_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, channel_id)
);
ALTER TABLE channel_reads ENABLE ROW LEVEL SECURITY;
CREATE POLICY channel_reads_tenant ON channel_reads USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON channel_reads TO deedwell_app;

-- Presence and notification preferences live on the membership, next to the
-- existing last-seen heartbeats.
ALTER TABLE organization_memberships
  ADD COLUMN last_active_at   timestamptz,
  ADD COLUMN presence         text NOT NULL DEFAULT 'offline' CHECK (presence IN ('active','idle','offline')),
  ADD COLUMN proactive_prefs  jsonb NOT NULL DEFAULT '{}';
