-- Build step 26: the in-app assistant's use is counted like minutes and texts: charged to the lead's team and client, with budgets,
-- and capped per person per day (D323, D372).
ALTER TABLE billing.usage DROP CONSTRAINT usage_kind_check;
ALTER TABLE billing.usage ADD CONSTRAINT usage_kind_check CHECK (kind IN ('minutes', 'texts', 'ai'));
ALTER TABLE billing.budgets DROP CONSTRAINT budgets_kind_check;
ALTER TABLE billing.budgets ADD CONSTRAINT budgets_kind_check CHECK (kind IN ('minutes', 'texts', 'ai'));
ALTER TABLE billing.raise_requests DROP CONSTRAINT raise_requests_kind_check;
ALTER TABLE billing.raise_requests ADD CONSTRAINT raise_requests_kind_check CHECK (kind IN ('minutes', 'texts', 'ai'));
CREATE INDEX usage_person_day ON billing.usage (org_id, user_id, at) WHERE kind = 'ai';
