package telnyx

// When an agency deletes a person's data on their request, the CRM lists the person's number here; the dialer
// removes its calls (with their captions, signals and recordings' records), texts, threads, notes, alerts, consents and webhook copies
// with that number in that agency, and tells the CRM it is done (D367). The opt-out stays: the number is never texted again.

import (
	"context"
	"log"
)

type erasure struct {
	ID       string `json:"id"`
	OrgID    string `json:"org_id"`
	PhoneKey string `json:"phone_key"`
}

func (c *crmClient) erasures(ctx context.Context) ([]erasure, error) {
	var out struct {
		Erasures []erasure `json:"erasures"`
	}
	return out.Erasures, c.get(ctx, "/internal/v1/dialer/erasures", &out)
}

func (c *crmClient) erasureDone(ctx context.Context, id string) error {
	var out map[string]any
	return c.post(ctx, "/internal/v1/dialer/erasures/"+id+"/done", map[string]any{}, &out)
}

// lastTen is the SQL for a stored number's last ten digits, which is how the CRM names a number.
func lastTen(column string) string { return `right(regexp_replace(` + column + `, '\D', '', 'g'), 10)` }

// erase removes what the dialer keeps about one number in one agency.
func (s *server) erase(ctx context.Context, e erasure) error {
	if len(e.PhoneKey) < 7 || !validID(e.OrgID) {
		return nil
	}
	tx, err := s.st.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	match := func(col string) string { return lastTen(col) + ` = $2` }
	steps := []string{
		// The conversations' threads, notes and alerts, by the leads the texts belonged to.
		`DELETE FROM sms_notes WHERE org_id = $1 AND lead_id IN (SELECT lead_id FROM sms_messages WHERE org_id = $1 AND lead_id IS NOT NULL AND (` + match("from_number") + ` OR ` + match("to_number") + `))`,
		`DELETE FROM sms_alerts WHERE org_id = $1 AND lead_id IN (SELECT lead_id FROM sms_messages WHERE org_id = $1 AND lead_id IS NOT NULL AND (` + match("from_number") + ` OR ` + match("to_number") + `))`,
		`DELETE FROM sms_threads WHERE org_id = $1 AND lead_id IN (SELECT lead_id FROM sms_messages WHERE org_id = $1 AND lead_id IS NOT NULL AND (` + match("from_number") + ` OR ` + match("to_number") + `))`,
		`DELETE FROM webhook_events WHERE message_id IN (SELECT id FROM sms_messages WHERE org_id = $1 AND (` + match("from_number") + ` OR ` + match("to_number") + `))
			OR call_id IN (SELECT id FROM calls WHERE org_id = $1 AND (` + match("from_number") + ` OR ` + match("to_number") + `))`,
		`DELETE FROM sms_messages WHERE org_id = $1 AND (` + match("from_number") + ` OR ` + match("to_number") + `)`,
		`DELETE FROM calls WHERE org_id = $1 AND (` + match("from_number") + ` OR ` + match("to_number") + `)`,
		`DELETE FROM sms_consents WHERE org_id = $1 AND ` + match("phone_number"),
	}
	for _, sql := range steps {
		if _, err := tx.Exec(ctx, sql, e.OrgID, e.PhoneKey); err != nil {
			return err
		}
	}
	// Never texted again, even if the CRM's block were lifted by mistake.
	if _, err := tx.Exec(ctx, `INSERT INTO sms_opt_outs (org_id, phone_number, keyword) VALUES ($1, '+1' || $2, 'deleted on request') ON CONFLICT (org_id, phone_number) DO NOTHING`, e.OrgID, e.PhoneKey); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// eraseRequested carries out every erasure the CRM lists.
func (s *server) eraseRequested(ctx context.Context) {
	list, err := s.crm.erasures(ctx)
	if err != nil {
		log.Printf("WARN data requests to erase: %v", err)
		return
	}
	for _, e := range list {
		if err := s.erase(ctx, e); err != nil {
			log.Printf("WARN erasing a number for a data request: %v", err)
			continue
		}
		if err := s.crm.erasureDone(ctx, e.ID); err != nil {
			log.Printf("WARN telling the CRM an erasure is done: %v", err)
		}
	}
}
