package main

// Build step 36 (migrations/0042_web_forms.sql): website forms per client (D247).
//
// GET /api/v1/public/forms/{token} is the form page (also inside an <iframe>: it sets its own Content-Security-Policy, which lets the
// sites the owner named, or any site, embed it and allows nothing else). POST to the same address sends it. Both are open at the gateway.
// Abuse guards: a hidden field people never fill, a per-address limit, and size limits; nothing is stored for a refused send.

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"log"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

const defaultConsent = "I agree that {agency} may call and text me at the number above about my enquiry, including with automated technology. Agreeing is not a condition of any purchase. Reply STOP to stop texts."

// formSends counts sends per form and address, a minute at a time.
type formSends struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

var formLimit = &formSends{hits: map[string][]time.Time{}}

const formSendsPerMinute = 5

func (f *formSends) allow(key string, now time.Time) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.hits) > 50000 {
		f.hits = map[string][]time.Time{}
	}
	recent := f.hits[key][:0]
	for _, t := range f.hits[key] {
		if now.Sub(t) < time.Minute {
			recent = append(recent, t)
		}
	}
	if len(recent) >= formSendsPerMinute {
		f.hits[key] = recent
		return false
	}
	f.hits[key] = append(recent, now)
	return true
}

func (s *server) formRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/forms", s.member(s.listForms))
	mux.Handle("POST /api/v1/forms", s.member(s.saveForm))
	mux.Handle("PATCH /api/v1/forms/{id}", s.member(s.saveForm))
	mux.Handle("GET /api/v1/forms/{id}/submissions", s.member(s.formSubmissions))
	mux.HandleFunc("GET /api/v1/public/forms/{token}", s.formPage)
	mux.HandleFunc("POST /api/v1/public/forms/{token}", s.formSend)
}

// ---- the agency's side ----

func (s *server) listForms(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins manage website forms.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `SELECT to_jsonb(f) || jsonb_build_object('off', f.off_at IS NOT NULL,
		'submissions', (SELECT count(*) FROM form_submissions s WHERE s.form_id = f.id)) FROM web_forms f ORDER BY f.created_at DESC`)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"forms": rows, "address": s.cfg.emailPublicURL + "/api/v1/public/forms/"})
	return nil
}

// saveForm is POST /api/v1/forms {name, title, client_id, team_id, consent_text, thanks, embed_origins} and PATCH /api/v1/forms/{id}
// (the same, and off: true|false).
func (s *server) saveForm(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins manage website forms.")
	}
	var body struct {
		Name         *string   `json:"name"`
		Title        *string   `json:"title"`
		ClientID     *string   `json:"client_id"`
		TeamID       *string   `json:"team_id"`
		ConsentText  *string   `json:"consent_text"`
		Thanks       *string   `json:"thanks"`
		EmbedOrigins *[]string `json:"embed_origins"`
		Off          *bool     `json:"off"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if body.EmbedOrigins != nil {
		for i, o := range *body.EmbedOrigins {
			u, err := url.Parse(strings.TrimSpace(o))
			if err != nil || u.Scheme != "https" || u.Host == "" || u.Path != "" && u.Path != "/" {
				return bad("Sites that may embed the form are addresses like https://www.example.com.")
			}
			(*body.EmbedOrigins)[i] = "https://" + strings.ToLower(u.Host)
		}
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if body.TeamID != nil {
		var known bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM teams WHERE id = $1::uuid)`, nullID(*body.TeamID)).Scan(&known); err != nil || !known {
			if listed, err := s.rules.teams(ctx, q.sc.orgID); err == nil {
				_ = s.copyTeams(ctx, q.sc, listed)
			}
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM teams WHERE id = $1::uuid)`, nullID(*body.TeamID)).Scan(&known); err != nil || !known {
				return bad("Choose a team of this agency (team_id).")
			}
		}
	}
	var rows []json.RawMessage
	id := q.r.PathValue("id")
	if id == "" {
		if body.Name == nil || body.TeamID == nil {
			return bad("Name the form and choose the team its leads go to.")
		}
		var agency string
		_ = tx.QueryRow(ctx, `SELECT name FROM orgs WHERE id = cw_org()`).Scan(&agency)
		consent := strings.ReplaceAll(defaultConsent, "{agency}", agency)
		if body.ConsentText != nil {
			consent = *body.ConsentText
		}
		rows, err = queryJSON(ctx, tx, `INSERT INTO web_forms (org_id, token, name, title, client_id, team_id, consent_text, thanks, embed_origins, created_by)
			VALUES (cw_org(), $1, $2, coalesce($3, ''), $4, $5, $6, coalesce($7, ''), coalesce($8, '{}'::text[]), $9) RETURNING to_jsonb(web_forms.*)`,
			orgToken(q.sc.orgID), strings.TrimSpace(*body.Name), body.Title, nullID(deref(body.ClientID)), *body.TeamID, strings.TrimSpace(consent), body.Thanks, body.EmbedOrigins, q.sc.userID)
	} else {
		var off any
		if body.Off != nil {
			off = *body.Off
		}
		rows, err = queryJSON(ctx, tx, `UPDATE web_forms SET name = coalesce($2, name), title = coalesce($3, title), team_id = coalesce($4::uuid, team_id),
			consent_text = coalesce($5, consent_text), thanks = coalesce($6, thanks), embed_origins = coalesce($7, embed_origins),
			off_at = CASE WHEN $8::boolean IS NULL THEN off_at WHEN $8 THEN coalesce(off_at, now()) ELSE NULL END
			WHERE id = $1 RETURNING to_jsonb(web_forms.*)`, nullID(id), body.Name, body.Title, nullID(deref(body.TeamID)), body.ConsentText, body.Thanks, body.EmbedOrigins, off)
		if err == nil && len(rows) == 0 {
			return notFound("No such form.")
		}
	}
	if err != nil {
		return bad("Check the form: a name up to 120 characters, the consent words 20 to 1,000, a thank-you message up to 500.")
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	var out map[string]any
	_ = json.Unmarshal(rows[0], &out)
	out["address"] = s.cfg.emailPublicURL + "/api/v1/public/forms/" + asString(out["token"])
	out["embed"] = `<iframe src="` + asString(out["address"]) + `?embed=1" title="` + html.EscapeString(asString(out["name"])) + `" style="width:100%;max-width:520px;height:640px;border:0"></iframe>`
	writeJSON(q.w, 200, out)
	return nil
}

func (s *server) formSubmissions(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins see a form's submissions.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('id', id, 'lead_id', lead_id, 'consent', consent, 'consent_text', consent_text, 'blocked', blocked,
		'network', network, 'at', at) FROM form_submissions WHERE form_id = $1 ORDER BY at DESC LIMIT 500`, nullID(q.r.PathValue("id")))
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"submissions": rows})
	return nil
}

// ---- the public side ----

type webForm struct {
	id, org, name, title, consent, thanks, agency string
	team, client                                  string
	origins                                       []string
}

func (s *server) loadForm(ctx context.Context, token string) (*webForm, error) {
	var f webForm
	var team, client *string
	err := s.inOrg(ctx, token, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT f.id::text, f.org_id::text, f.name, f.title, f.consent_text, f.thanks, f.team_id::text, f.client_id::text, f.embed_origins, o.name
			FROM web_forms f JOIN orgs o ON o.id = f.org_id WHERE f.token = $1 AND f.off_at IS NULL`, token).
			Scan(&f.id, &f.org, &f.name, &f.title, &f.consent, &f.thanks, &team, &client, &f.origins, &f.agency)
	})
	if err != nil {
		return nil, err
	}
	f.team, f.client = deref(team), deref(client)
	return &f, nil
}

func formHeaders(w http.ResponseWriter, f *webForm) {
	ancestors := "*"
	if f != nil && len(f.origins) > 0 {
		ancestors = strings.Join(f.origins, " ")
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors "+ancestors)
	w.Header().Set("Cache-Control", "no-store")
}

const formStyle = `<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px;color:#1b1b1b;background:#fff}
main{max-width:480px;margin:0 auto}label{display:block;margin:12px 0 4px;font-weight:600}input,textarea{width:100%;box-sizing:border-box;padding:10px;font:inherit;border:1px solid #c9cfcb;border-radius:8px}
.consent{display:flex;gap:8px;align-items:flex-start;font-weight:400;font-size:14px}.consent input{width:auto;margin-top:3px}.trap{position:absolute;left:-10000px}
button{margin-top:16px;padding:12px 20px;font:inherit;border:0;border-radius:999px;background:#111;color:#fff}.note{color:#555;font-size:13px}</style>`

func (s *server) formPage(w http.ResponseWriter, r *http.Request) {
	f, err := s.loadForm(r.Context(), r.PathValue("token"))
	formHeaders(w, f)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `<!doctype html><meta name="viewport" content="width=device-width">`+formStyle+`<main><h1>This form is closed.</h1></main>`)
		return
	}
	e := html.EscapeString
	title := f.title
	if title == "" {
		title = "Tell us about your property"
	}
	fmt.Fprintf(w, `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>%s</title>%s
<main><h1>%s</h1><p class="note">%s</p>
<form method="post" action="/api/v1/public/forms/%s">
<label for="name">Your name</label><input id="name" name="name" required maxlength="120" autocomplete="name">
<label for="phone">Phone</label><input id="phone" name="phone" type="tel" required maxlength="40" autocomplete="tel">
<label for="email">Email (optional)</label><input id="email" name="email" type="email" maxlength="200" autocomplete="email">
<label for="address">Property address (optional)</label><input id="address" name="address" maxlength="300" autocomplete="street-address">
<label for="message">Anything we should know? (optional)</label><textarea id="message" name="message" rows="3" maxlength="2000"></textarea>
<div class="trap" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
<label class="consent"><input type="checkbox" name="consent" value="yes"> <span>%s</span></label>
<button type="submit">Send</button></form></main></html>`, e(title), formStyle, e(title), e(f.agency), e(r.PathValue("token")), e(f.consent))
}

// formSend takes a submission: a new unassigned lead of the form's client in its team, checked against the block lists, with the
// consent recorded as shown.
func (s *server) formSend(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.PathValue("token")
	f, err := s.loadForm(ctx, token)
	formHeaders(w, f)
	page := func(status int, heading, text string) {
		w.WriteHeader(status)
		fmt.Fprintf(w, `<!doctype html><meta name="viewport" content="width=device-width">%s<main><h1>%s</h1><p>%s</p></main>`, formStyle, html.EscapeString(heading), html.EscapeString(text))
	}
	if err != nil {
		page(http.StatusNotFound, "This form is closed.", "")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := r.ParseForm(); err != nil {
		page(http.StatusBadRequest, "That did not work.", "Please try again.")
		return
	}
	ip := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0])
	if ip == "" {
		ip, _, _ = net.SplitHostPort(r.RemoteAddr)
	}
	if !formLimit.allow(token+"|"+ip, s.now()) {
		page(http.StatusTooManyRequests, "Please wait a moment.", "Too many sends from here; try again in a minute.")
		return
	}
	thanks := f.thanks
	if thanks == "" {
		thanks = "Thank you. We will be in touch soon."
	}
	if r.PostFormValue("website") != "" { // the hidden field: a robot. Answer as if it worked, keep nothing.
		page(http.StatusOK, "Thank you.", thanks)
		return
	}
	name, phone, email := strings.TrimSpace(r.PostFormValue("name")), strings.TrimSpace(r.PostFormValue("phone")), strings.TrimSpace(r.PostFormValue("email"))
	address, message := strings.TrimSpace(r.PostFormValue("address")), strings.TrimSpace(r.PostFormValue("message"))
	consent := r.PostFormValue("consent") == "yes"
	if name == "" || len(name) > 120 || phoneKey(phone) == "" || len(phone) > 40 || len(address) > 300 || len(message) > 2000 || len(email) > 200 {
		page(http.StatusBadRequest, "Please check the form.", "Your name and a phone number are needed.")
		return
	}
	if email != "" {
		if a, err := mail.ParseAddress(email); err != nil || a.Address != email {
			page(http.StatusBadRequest, "Please check the form.", "That email address does not look right.")
			return
		}
	}
	err = s.inOrg(ctx, token, func(tx pgx.Tx) error {
		blocked, err := numberBlocked(ctx, tx, phone)
		if err != nil {
			return err
		}
		var lead string
		if err := tx.QueryRow(ctx, `INSERT INTO leads (org_id, team_id, client_id, name, phone, email, source, stage) VALUES (cw_org(), $1, $2, $3, $4, $5, $6, 'New') RETURNING id::text`,
			nullID(f.team), nullID(f.client), name, phone, email, "Form: "+f.name).Scan(&lead); err != nil {
			return err
		}
		if note := strings.TrimSpace(strings.Join(slices.DeleteFunc([]string{prefixed("Property: ", address), message}, func(x string) bool { return x == "" }), "\n")); note != "" {
			if _, err := tx.Exec(ctx, `INSERT INTO notes (org_id, lead_id, author_label, body) VALUES (cw_org(), $1, $2, $3)`, lead, "Form: "+f.name, note); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO form_submissions (org_id, form_id, lead_id, client_id, phone_key, consent, consent_text, blocked, network, user_agent)
			VALUES (cw_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`, f.id, lead, nullID(f.client), phoneKey(phone), consent, f.consent, blocked.Calls || blocked.Texts,
			cutNetwork(ip), truncateText(r.UserAgent(), 300)); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) VALUES (cw_org(), 'lead', $1, $1, 'upsert')`, lead)
		return err
	})
	if err != nil {
		log.Printf("WARN form %s: %v", f.id, err)
		page(http.StatusInternalServerError, "That did not work.", "Please try again in a moment.")
		return
	}
	page(http.StatusOK, "Thank you.", thanks)
}

func prefixed(prefix, v string) string {
	if v == "" {
		return ""
	}
	return prefix + v
}

// cutNetwork keeps an address's first parts only.
func cutNetwork(ip string) string {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return ""
	}
	if v4 := parsed.To4(); v4 != nil {
		p := strings.Split(v4.String(), ".")
		return strings.Join(p[:3], ".") + ".x"
	}
	p := strings.Split(parsed.String(), ":")
	if len(p) > 4 {
		p = p[:4]
	}
	return strings.Join(p, ":") + "::"
}

// formConsent is whether the person behind a number agreed on one of this agency's forms for this client's work (D353, D366).
func formConsent(ctx context.Context, tx pgx.Tx, phone, client string) bool {
	var ok bool
	_ = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM form_submissions WHERE consent AND phone_key = crm.phone_key($1) AND client_id IS NOT DISTINCT FROM $2::uuid)`,
		phone, nullID(client)).Scan(&ok)
	return ok
}
