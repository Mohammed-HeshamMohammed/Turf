-- A ReadyMode call history is merged inside the database, a batch per call (merge speed work). Each row used to cost Go 6-10 round trips
-- to PostgreSQL (look for an earlier copy, match a lead, add one, add the call, update the lead, write the feed), and its lead match read
-- every lead of the agency: row security keeps PostgreSQL from using an index on lower(btrim(name)) (those functions are not
-- "leakproof"), so each call row cost about 0.4 s at 270,000 leads (measured on the Coolify server). This function does the same steps
-- for a whole batch in one call, and reads the leads that share a name with the batch's calls once per batch into a small temporary
-- table. It runs as the caller, so row security and cw_org() apply exactly as before.

-- A text field of a call row as Go's str() reads it: a JSON string, trimmed; anything else is ''.
CREATE OR REPLACE FUNCTION importing.call_field(d jsonb, k text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(d -> k) = 'string' THEN btrim(d ->> k, E' \t\n\r\f\v') ELSE '' END
$$;

-- Merges up to p_limit staged rows of one call history, in row order, and returns how many it settled (0: none left).
CREATE OR REPLACE FUNCTION importing.merge_call_batch(p_job uuid, p_limit int) RETURNS int LANGUAGE plpgsql
SET search_path FROM CURRENT AS $$
DECLARE
  d jsonb;
  v_phone text; v_name text; v_address text; v_email text; v_zip text; v_source_id text; v_meaning text; v_scheduled text;
  v_lead uuid; v_property uuid; v_call uuid; v_prior timestamptz; v_found boolean;
  v_candidates uuid[];
  v_nos bigint[]; v_data jsonb[];
  n int := 0;
BEGIN
  SELECT array_agg(b.row_no ORDER BY b.row_no), array_agg(b.call_data ORDER BY b.row_no) INTO v_nos, v_data
  FROM (SELECT row_no, call_data FROM importing.rows WHERE job_id = p_job AND state = 'loaded'
        ORDER BY row_no LIMIT p_limit FOR UPDATE SKIP LOCKED) b;
  IF v_nos IS NULL THEN
    RETURN 0;
  END IF;
  -- The leads that could match: those with a name of this batch, read in one pass (and the leads this batch adds, below).
  CREATE TEMP TABLE IF NOT EXISTS call_merge_leads (k text, id uuid, phone text, email text, property_id uuid) ON COMMIT DROP;
  TRUNCATE call_merge_leads;
  INSERT INTO call_merge_leads
  SELECT lower(btrim(l.name)), l.id, l.phone, l.email, l.property_id FROM leads l
  WHERE l.org_id = cw_org() AND l.deleted_at IS NULL AND lower(btrim(l.name)) IN (
    SELECT lower(btrim(CASE WHEN importing.call_field(x, 'name') = '' THEN importing.call_field(x, 'phone') ELSE importing.call_field(x, 'name') END))
    FROM unnest(v_data) x WHERE jsonb_typeof(x) = 'object');
  CREATE INDEX IF NOT EXISTS call_merge_leads_k ON call_merge_leads (k);
  ANALYZE call_merge_leads;

  FOR i IN 1 .. cardinality(v_nos) LOOP
    n := n + 1;
    d := v_data[i];
    IF d IS NULL OR jsonb_typeof(d) <> 'object' THEN
      UPDATE importing.rows SET state = 'skip' WHERE job_id = p_job AND row_no = v_nos[i];
      CONTINUE;
    END IF;
    v_phone := importing.call_field(d, 'phone');
    v_name := importing.call_field(d, 'name');
    IF v_name = '' THEN v_name := v_phone; END IF;
    v_address := importing.call_field(d, 'address');
    v_email := importing.call_field(d, 'email');
    v_zip := importing.call_field(d, 'zip');
    v_source_id := importing.call_field(d, 'source_record_id');
    v_meaning := importing.call_field(d, 'meaning');
    v_scheduled := nullif(importing.call_field(d, 'scheduled_at'), '');

    -- The same call from an earlier upload of the same export is linked, not added again.
    IF v_source_id <> '' THEN
      SELECT true, lead_id INTO v_found, v_lead FROM call_events WHERE org_id = cw_org() AND source = 'readymode'
        AND source_record_id = v_source_id AND occurred_at = importing.call_field(d, 'occurred_at')::timestamptz AND phone = v_phone LIMIT 1;
      IF v_found THEN
        UPDATE importing.rows SET state = 'merged', lead_id = v_lead WHERE job_id = p_job AND row_no = v_nos[i];
        v_found := NULL;
        CONTINUE;
      END IF;
    END IF;

    -- One existing lead with the same name and the same phone, email or address takes the call; none, or more than one, makes a new lead.
    v_candidates := ARRAY[]::uuid[];
    IF v_name <> '' THEN
      v_candidates := ARRAY(SELECT c.id FROM call_merge_leads c LEFT JOIN properties p ON p.id = c.property_id
        WHERE c.k = lower(btrim(v_name))
          AND (importing.norm_phone(c.phone) = v_phone OR (v_email <> '' AND lower(c.email) = v_email)
               OR (v_address <> '' AND importing.addr_key(p.address, p.postal_code) = importing.addr_key(v_address, v_zip)))
        LIMIT 2);
    END IF;
    IF cardinality(v_candidates) = 1 THEN
      v_lead := v_candidates[1];
    ELSE
      v_property := NULL;
      IF v_address <> '' OR v_zip <> '' THEN
        INSERT INTO properties (org_id, address, city, region, postal_code, country)
        VALUES (cw_org(), v_address, importing.call_field(d, 'city'), importing.call_field(d, 'region'), v_zip, 'US') RETURNING id INTO v_property;
      END IF;
      INSERT INTO leads (org_id, property_id, name, phone, email, source)
      VALUES (cw_org(), v_property, coalesce(nullif(v_name, ''), v_phone), v_phone, v_email, 'ReadyMode') RETURNING id INTO v_lead;
      -- A later call of this batch from the same person finds the lead just added, as it did when each row was its own query.
      INSERT INTO call_merge_leads VALUES (lower(btrim(coalesce(nullif(v_name, ''), v_phone))), v_lead, v_phone, v_email, v_property);
    END IF;

    SELECT max(occurred_at) INTO v_prior FROM call_events WHERE org_id = cw_org() AND lead_id = v_lead;
    INSERT INTO call_events (org_id, lead_id, agent_label, phone, outcome, code, meaning, scheduled_at, source, occurred_at,
                             import_job_id, import_row_no, source_record_id, notes, recording_started_at, recording_ended_at, details)
    VALUES (cw_org(), v_lead, importing.call_field(d, 'agent'), v_phone, importing.call_field(d, 'outcome'), importing.call_field(d, 'code'),
            v_meaning, v_scheduled::timestamptz, 'readymode', importing.call_field(d, 'occurred_at')::timestamptz,
            p_job, v_nos[i], v_source_id, importing.call_field(d, 'notes'),
            nullif(importing.call_field(d, 'recording_started_at'), '')::timestamptz, nullif(importing.call_field(d, 'recording_ended_at'), '')::timestamptz, d)
    ON CONFLICT (import_job_id, import_row_no) WHERE import_job_id IS NOT NULL DO UPDATE SET import_row_no = EXCLUDED.import_row_no
    RETURNING id INTO v_call;
    UPDATE importing.rows SET state = 'merged', lead_id = v_lead WHERE job_id = p_job AND row_no = v_nos[i];

    -- Imported history never schedules an overdue callback or overwrites a newer call. A past DNC remains a safety block even if another
    -- call was recorded later, and blocks the number for the agency too (step 25).
    IF v_meaning = 'do_not_call' THEN
      UPDATE leads SET do_not_call = true, verdict = 'Do not call', stage = 'Closed', version = version + 1, updated_at = now() WHERE id = v_lead;
      INSERT INTO number_blocks (org_id, phone_key, calls, texts, reason, source, lead_id)
      SELECT cw_org(), crm.phone_key(v_phone), true, true, 'asked_agency', 'import', v_lead WHERE crm.phone_key(v_phone) IS NOT NULL
      ON CONFLICT (org_id, phone_key) WHERE lifted_at IS NULL DO UPDATE SET calls = true, texts = true;
    ELSIF v_prior IS NULL OR v_prior <= importing.call_field(d, 'occurred_at')::timestamptz THEN
      IF v_meaning = 'wrong_number' THEN
        UPDATE leads SET verdict = 'Wrong number', version = version + 1, updated_at = now() WHERE id = v_lead AND NOT do_not_call;
      ELSIF v_meaning = 'reached' THEN
        UPDATE leads SET stage = CASE WHEN importing.call_field(d, 'outcome') = 'Transfer' AND stage IN ('New', 'Contacted') THEN 'Qualified'
            WHEN stage = 'New' THEN 'Contacted' ELSE stage END, version = version + 1, updated_at = now()
          WHERE id = v_lead AND NOT do_not_call;
      END IF;
      IF v_scheduled IS NOT NULL THEN
        UPDATE leads SET next_action = 'Call back', next_action_at = v_scheduled::timestamptz, version = version + 1, updated_at = now()
          WHERE id = v_lead AND v_scheduled::timestamptz > now() AND NOT do_not_call;
      END IF;
    END IF;
    INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) VALUES (cw_org(), 'call', v_call, v_lead, 'upsert'), (cw_org(), 'lead', v_lead, v_lead, 'upsert');
  END LOOP;
  RETURN n;
END
$$;
