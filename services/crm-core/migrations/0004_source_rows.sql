-- Keep the original uploaded cells as PostgreSQL rows linked to their CRM lead.
-- Deleting a lead removes its original source rows from every imported list.
ALTER TABLE importing.rows
  ADD COLUMN lead_id uuid REFERENCES crm.leads(id) ON DELETE CASCADE;
CREATE INDEX rows_lead ON importing.rows(lead_id) WHERE lead_id IS NOT NULL;

-- Earlier merged rows that matched an existing lead already recorded its ID.
UPDATE importing.rows r SET lead_id = r.match_lead
  FROM crm.leads l
  WHERE r.state = 'merged' AND r.match_lead = l.id;
