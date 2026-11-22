-- Build step 25: opt-out replies and consent.
--   * A reply that is only an opt-out blocks at once and the thread shows why (D207); one that uses "stop" inside a normal sentence
--     waits for the agent to choose "opt-out" or "not an opt-out" before anything else is sent, and the choice is kept (D208).
--   * Consent to text belongs to one client's work within the agency and one number (D366): the client is part of its key, '' being
--     the agency's own business. A call's consent can link the call it was given on (D354).
ALTER TABLE sms_messages ADD COLUMN opt_out_question text NOT NULL DEFAULT '' CHECK (opt_out_question IN ('', 'opt_out', 'waiting', 'not_opt_out'));
ALTER TABLE sms_messages ADD COLUMN opt_out_by uuid;
ALTER TABLE sms_messages ADD COLUMN opt_out_at timestamptz;
CREATE INDEX sms_messages_opt_out_waiting ON sms_messages (org_id, lead_id) WHERE opt_out_question = 'waiting';

ALTER TABLE sms_consents ADD COLUMN client_key text NOT NULL DEFAULT '';
ALTER TABLE sms_consents ADD COLUMN call_id uuid;
ALTER TABLE sms_consents DROP CONSTRAINT sms_consents_pkey;
ALTER TABLE sms_consents ADD PRIMARY KEY (org_id, client_key, phone_number);
