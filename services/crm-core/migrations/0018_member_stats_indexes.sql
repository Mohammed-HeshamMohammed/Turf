-- Team monitoring counts each person's work over a range of days (stats.go); these keep those counts quick.
CREATE INDEX IF NOT EXISTS call_events_agent ON call_events(org_id, agent_id, occurred_at) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(org_id, assignee_id, done_at);
CREATE INDEX IF NOT EXISTS notes_author ON notes(org_id, author_id, occurred_at);
CREATE INDEX IF NOT EXISTS audit_actor ON audit_events(org_id, actor_id, id);
