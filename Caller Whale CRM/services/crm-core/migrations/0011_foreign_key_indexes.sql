-- Deleting a list deletes its leads and properties, and every deleted row makes the database look for rows that point at it (leads at their
-- property, notes at their lead, and so on). Without an index on those columns each look-up read the whole table: 20,000 leads took 35
-- seconds and a big list took hours. These indexes make each look-up direct.
CREATE INDEX IF NOT EXISTS leads_property ON leads(property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_project ON leads(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_property ON deals(property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notes_lead ON notes(lead_id);
CREATE INDEX IF NOT EXISTS tasks_lead ON tasks(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_deal ON tasks(deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS assignments_lead ON assignments(lead_id);
CREATE INDEX IF NOT EXISTS handoffs_lead ON handoffs(lead_id);
