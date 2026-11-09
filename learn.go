package main

// The learning copy of a finished import (docs/plans/learning-store-compliance.md). When a list has been added to the leads, its rows go
// to the separate learning service, which keeps keyed hashes and shapes of them and never the values. crm-core sends the rows once, over
// the private network, and never reads them back. Off until LEARNING_URL is set: nothing leaves this service without it.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"
)

const (
	learnBatch    = 1000
	learnGrace    = 7 * 24 * time.Hour // the holding rows keep their values this long after they were copied, so a failed copy can be repeated
	learnScrubRun = 50000
)

var errLearningOff = errors.New("learning is switched off")

// detailsFrom picks the property facts the learning store may keep from a row's standard source columns.
func detailsFrom(data map[string]any) map[string]string {
	names := map[string]string{"bedrooms": "bedrooms", "bathrooms": "bathrooms", "living_area": "living_sqft", "year_built": "year_built",
		"lot_size_square_feet": "lot_sqft", "lot_size_acres": "lot_acres", "stories": "stories", "property_type": "property_type", "land_use": "land_use",
		"owner_occupied": "owner_occupied", "vacancy": "vacant", "heating": "heating", "cooling": "air_conditioning", "garage_type": "garage_type",
		"garage_area": "garage_sqft", "units": "units"}
	out := map[string]string{}
	for from, to := range names {
		if v, ok := data[from]; ok && v != nil {
			out[to] = fmt.Sprint(v)
		}
	}
	return out
}

// learnJob copies one finished import to the learning store. Safe to repeat: the store keeps one row per import row.
func (s *server) learnJob(ctx context.Context, id string) error {
	if s.cfg.learningURL == "" {
		return nil
	}
	var org string
	var project *string
	var columns string
	err := s.st.db.QueryRow(ctx, `SELECT org_id::text, project_id::text, coalesce(columns, '[]'::jsonb)::text FROM importing.jobs
		WHERE id = $1 AND status = 'done' AND kind = 'lead_list' AND learned_at IS NULL`, id).Scan(&org, &project, &columns)
	if err != nil {
		return nil // not a finished list import, or already copied
	}
	var cols []struct {
		Header string `json:"header"`
		Field  string `json:"field"`
		Used   bool   `json:"used"`
	}
	_ = json.Unmarshal([]byte(columns), &cols)
	type mapping struct {
		Header string `json:"header"`
		Field  string `json:"field"`
	}
	var maps []mapping
	for _, c := range cols {
		if c.Used && c.Field != "" {
			maps = append(maps, mapping{c.Header, c.Field})
		}
	}
	var last, sent int64 = -1, 0
	first := true
	for {
		rows, err := s.st.db.Query(ctx, `SELECT row_no, coalesce(name, ''), coalesce(phone, ''), coalesce(email, ''), coalesce(address, ''), coalesce(unit, ''), coalesce(city, ''),
				coalesce(region, ''), coalesce(zip, ''), coalesce(country, ''), latitude IS NOT NULL AND longitude IS NOT NULL, source_data::text
			FROM importing.rows WHERE job_id = $1 AND state = 'merged' AND row_no > $2 ORDER BY row_no LIMIT $3`, id, last, learnBatch)
		if err != nil {
			return err
		}
		var batch []map[string]any
		for rows.Next() {
			var n int64
			var name, phone, email, address, unit, city, region, zip, country, source string
			var geo bool
			if err = rows.Scan(&n, &name, &phone, &email, &address, &unit, &city, &region, &zip, &country, &geo, &source); err != nil {
				rows.Close()
				return err
			}
			data := map[string]any{}
			_ = json.Unmarshal([]byte(source), &data)
			batch = append(batch, map[string]any{"row_no": n, "name": name, "phone": phone, "email": email, "address": address, "unit": unit, "city": city,
				"region": region, "zip": zip, "country": country, "has_location": geo, "details": detailsFrom(data)})
			last = n
		}
		rows.Close()
		if len(batch) == 0 {
			break
		}
		body := map[string]any{"org_id": org, "job_id": id, "rows": batch}
		if project != nil {
			body["project_id"] = *project
		}
		if first { // the column titles go once, with the first batch
			body["mapping"] = maps
			first = false
		}
		if err = s.sendLearning(ctx, "/v1/ingest", body); err != nil {
			return err
		}
		sent += int64(len(batch))
	}
	log.Printf("INFO copied import %s to the learning store: %d rows", id, sent)
	_, err = s.st.db.Exec(ctx, `UPDATE importing.jobs SET learned_at = now() WHERE id = $1`, id)
	return err
}

// learningStatus asks the learning store about this workspace: whether it is switched on and whether the workspace opted out.
func (s *server) learningStatus(q *req) error {
	if s.cfg.learningURL == "" {
		writeJSON(q.w, http.StatusOK, map[string]any{"available": false})
		return nil
	}
	ctx, cancel := context.WithTimeout(q.r.Context(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.learningURL+"/v1/workspaces/"+q.sc.orgID, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.learningToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != http.StatusOK {
		writeJSON(q.w, http.StatusOK, map[string]any{"available": false})
		return nil
	}
	defer res.Body.Close()
	var out struct {
		Enabled  bool `json:"enabled"`
		OptedOut bool `json:"opted_out"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	writeJSON(q.w, http.StatusOK, map[string]any{"available": true, "enabled": out.Enabled, "opted_out": out.OptedOut})
	return nil
}

func (s *server) sendLearning(ctx context.Context, path string, body any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.learningURL+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.cfg.learningToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return errors.New("the learning store is not reachable")
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusServiceUnavailable {
		return errLearningOff
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("the learning store answered %d", res.StatusCode)
	}
	return nil
}

// learnPendingPeriodically copies finished imports that were not copied yet (the service stopped, or the store was away), then blanks the
// personal details of rows copied more than a week ago.
func (s *server) learnPendingPeriodically(ctx context.Context) {
	if s.cfg.learningURL == "" {
		return
	}
	for {
		s.learnPending(ctx)
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Minute):
		}
	}
}

func (s *server) learnPending(ctx context.Context) {
	rows, err := s.st.db.Query(ctx, `SELECT id::text FROM importing.jobs WHERE status = 'done' AND kind = 'lead_list' AND learned_at IS NULL ORDER BY created_at LIMIT 20`)
	if err != nil {
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		if err := s.learnJob(ctx, id); err != nil {
			if errors.Is(err, errLearningOff) {
				return
			}
			log.Printf("WARN learning copy of import %s: %v", id, err)
		}
	}
	if n, err := s.scrubLearned(ctx); err != nil {
		log.Printf("WARN blanking copied rows: %v", err)
	} else if n > 0 {
		log.Printf("INFO blanked the personal details of %d copied rows", n)
	}
}

// scrubLearned blanks the personal details of the holding rows of imports copied to the learning store more than a week ago. What is kept:
// the fingerprint of the original row (so the same file added again is still recognised), its state and its link to the lead.
func (s *server) scrubLearned(ctx context.Context) (int64, error) {
	rows, err := s.st.db.Query(ctx, `SELECT id::text FROM importing.jobs WHERE status = 'done' AND learned_at IS NOT NULL AND learned_at < now() - make_interval(secs => $1)`, learnGrace.Seconds())
	if err != nil {
		return 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	var total int64
	for _, id := range ids {
		for {
			tag, err := s.st.db.Exec(ctx, `UPDATE importing.rows r SET cells = '{}', name = NULL, phone = NULL, email = NULL, address = NULL, unit = NULL, city = NULL,
					region = NULL, zip = NULL, country = NULL, latitude = NULL, longitude = NULL, parcel = NULL, value = NULL, source = NULL, source_data = '{}', call_data = NULL
				WHERE (r.job_id, r.row_no) IN (SELECT job_id, row_no FROM importing.rows WHERE job_id = $1 AND cells <> '{}' LIMIT $2)`, id, learnScrubRun)
			if err != nil {
				return total, err
			}
			total += tag.RowsAffected()
			if tag.RowsAffected() < learnScrubRun {
				break
			}
		}
	}
	return total, nil
}

// learningChoice is a workspace administrator's choice about the learning copy of their lists: opting out stops anything more being taken
// and erases what was (POST /api/v1/learning/opt-out); opting back in allows it again (POST /api/v1/learning/opt-in).
func (s *server) learningChoice(out bool) func(q *req) error {
	return func(q *req) error {
		if !q.sc.can("admin") {
			return forbidden("Only an administrator decides this for the workspace.")
		}
		if s.cfg.learningURL == "" {
			writeJSON(q.w, http.StatusOK, map[string]any{"learning": "off", "opted_out": true})
			return nil
		}
		path := "/v1/workspaces/" + q.sc.orgID + "/opt-in"
		if out {
			path = "/v1/workspaces/" + q.sc.orgID + "/opt-out"
		}
		if err := s.sendLearning(q.r.Context(), path, map[string]any{}); err != nil && !errors.Is(err, errLearningOff) {
			return err
		}
		writeJSON(q.w, http.StatusOK, map[string]any{"opted_out": out})
		return nil
	}
}
