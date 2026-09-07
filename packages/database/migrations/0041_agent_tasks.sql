-- Agent tasks: work a person assigns to an AI teammate, one-off or on a cron
-- schedule. A task is the standing definition; each execution is a run; every
-- change is an event (the activity timeline); every output is a deliverable
-- that points at an artifact (documents) or a file (images, other binaries).
-- Additive — nothing existing changes.

CREATE TABLE agent_tasks (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES organizations(id),
  title           text NOT NULL,
  description     text NOT NULL DEFAULT '',
  instructions    text NOT NULL DEFAULT '',
  agent_key       text NOT NULL,
  task_type       text NOT NULL DEFAULT 'general',
  priority        text NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','in_progress','waiting_approval','blocked','completed','failed','cancelled')),
  tags            text[] NOT NULL DEFAULT '{}',
  due_at          timestamptz,
  -- Scheduling. One-off tasks run at next_run_at (now, or a chosen time);
  -- recurring tasks carry a five-field cron in the org's time zone.
  is_recurring    boolean NOT NULL DEFAULT false,
  cron_expression text,
  timezone        text NOT NULL DEFAULT 'UTC',
  next_run_at     timestamptz,
  last_run_at     timestamptz,
  last_run_status text,
  run_count       integer NOT NULL DEFAULT 0,
  -- Sensitive work waits for a person; the approval row is the decision.
  requires_approval boolean NOT NULL DEFAULT false,
  approval_id     uuid,
  -- Where the assigned teammate reports progress (a DM or project channel).
  channel_id      uuid REFERENCES channels(id) ON DELETE SET NULL,
  created_from    text NOT NULL DEFAULT 'dashboard',
  created_by      uuid NOT NULL REFERENCES users(id),
  tokens_used     bigint NOT NULL DEFAULT 0,
  blocked_reason  text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  -- Worker claim (SKIP LOCKED lease), same shape as workflow_runs.
  claimed_by      text,
  claimed_at      timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  cancelled_at    timestamptz
);
CREATE INDEX agent_tasks_tenant_idx ON agent_tasks (tenant_id, created_at DESC);
CREATE INDEX agent_tasks_due_idx ON agent_tasks (next_run_at) WHERE status = 'queued';
ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_tasks_tenant ON agent_tasks
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER agent_tasks_updated BEFORE UPDATE ON agent_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_tasks TO deedwell_app;

CREATE TABLE agent_task_runs (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES organizations(id),
  task_id      uuid NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'in_progress'
               CHECK (status IN ('in_progress','waiting_approval','blocked','completed','failed','cancelled')),
  summary      text,
  error        text,
  tokens_used  bigint NOT NULL DEFAULT 0,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_task_runs_task_idx ON agent_task_runs (task_id, started_at DESC);
ALTER TABLE agent_task_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_task_runs_tenant ON agent_task_runs
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_task_runs TO deedwell_app;

CREATE TABLE agent_task_events (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES organizations(id),
  task_id      uuid NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  run_id       uuid REFERENCES agent_task_runs(id) ON DELETE SET NULL,
  kind         text NOT NULL,
  level        text NOT NULL DEFAULT 'info' CHECK (level IN ('info','progress','warn','error')),
  message      text NOT NULL,
  actor_kind   text NOT NULL DEFAULT 'system' CHECK (actor_kind IN ('agent','user','system')),
  actor_agent  text,
  actor_user   uuid REFERENCES users(id),
  metadata     jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_task_events_task_idx ON agent_task_events (task_id, created_at);
ALTER TABLE agent_task_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_task_events_tenant ON agent_task_events
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_task_events TO deedwell_app;

CREATE TABLE agent_task_deliverables (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES organizations(id),
  task_id      uuid NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  run_id       uuid REFERENCES agent_task_runs(id) ON DELETE SET NULL,
  kind         text NOT NULL CHECK (kind IN ('markdown','pdf','image','file')),
  title        text NOT NULL,
  artifact_id  uuid REFERENCES artifacts(id) ON DELETE SET NULL,
  file_id      uuid REFERENCES files(id) ON DELETE SET NULL,
  mime         text,
  size_bytes   bigint,
  metadata     jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_task_deliverables_task_idx ON agent_task_deliverables (task_id, created_at);
ALTER TABLE agent_task_deliverables ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_task_deliverables_tenant ON agent_task_deliverables
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_task_deliverables TO deedwell_app;

-- Task deliverables are documents the Artifacts export already knows how to
-- render (markdown body), so they join the artifact type list.
ALTER TABLE artifacts DROP CONSTRAINT artifacts_type_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_type_check CHECK (type IN
  ('compliance_matrix','grant_section','export_package','application_plan','budget',
   'logic_model','review_report','compliance_report','website_brief','website_test_report',
   'ad_grants_eligibility','ad_grants_enrollment_snapshot',
   'ad_grants_campaign_plan','ad_grants_activation_snapshot','task_deliverable'));
