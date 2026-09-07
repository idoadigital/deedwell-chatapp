-- Multi-agent workflows on top of agent_tasks, additive:
--   parent_id   the task this one is a step of (the parent coordinates and
--               synthesises once every step has finished)
--   depends_on  steps that must complete before this one may start
--   position    order among siblings, for display
--   paused      a routine on hold: kept, scheduled, not run
ALTER TABLE agent_tasks ADD COLUMN parent_id uuid REFERENCES agent_tasks(id) ON DELETE CASCADE;
ALTER TABLE agent_tasks ADD COLUMN depends_on uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE agent_tasks ADD COLUMN position integer NOT NULL DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN paused boolean NOT NULL DEFAULT false;
CREATE INDEX agent_tasks_parent_idx ON agent_tasks (parent_id, position) WHERE parent_id IS NOT NULL;
