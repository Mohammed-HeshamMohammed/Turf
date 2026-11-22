package crm

// Email to leads (migrations/0037_lead_email.sql, D161, D316-D319).
//
// Set up with EMAIL_SES_REGION (Amazon SES; its login comes from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, set in Coolify only),
// EMAIL_PUBLIC_URL (this API's public address, for links in emails), EMAIL_REPLY_DOMAIN (a domain whose mail SES receives, for
// replies) and EMAIL_SNS_TOPIC_ARN (the SNS topic SES puts received mail on, subscribed to /api/v1/public/email/inbound). Without
// them sending answers that email is not set up.

import (
	"bufio"
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/http"
	"net/mail"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	sestypes "github.com/aws/aws-sdk-go-v2/service/sesv2/types"
	"github.com/jackc/pgx/v5"
)

// emailWaitMinutes is how long a lead's email may wait for an answer before the team's leads are told (as for texts, D21).
const emailWaitMinutes = 15

// emailProvider is what Caller Whale asks of the mail provider; tests use a stand-in.
type emailProvider interface {
	addDomain(ctx context.Context, domain string) ([]map[string]string, error)
	verified(ctx context.Context, domain string) (bool, error)
	send(ctx context.Context, raw []byte) (string, error)
}

type sesProvider struct{ client *sesv2.Client }

func newSES(ctx context.Context, region string) (*sesProvider, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		return nil, err
	}
	return &sesProvider{client: sesv2.NewFromConfig(cfg)}, nil
}

func (p *sesProvider) addDomain(ctx context.Context, domain string) ([]map[string]string, error) {
	out, err := p.client.CreateEmailIdentity(ctx, &sesv2.CreateEmailIdentityInput{EmailIdentity: aws.String(domain)})
	if err != nil {
		return nil, err
	}
	records := []map[string]string{}
	if out.DkimAttributes != nil {
		for _, t := range out.DkimAttributes.Tokens {
			records = append(records, map[string]string{"type": "CNAME", "name": t + "._domainkey." + domain, "value": t + ".dkim.amazonses.com"})
		}
	}
	return records, nil
}

func (p *sesProvider) verified(ctx context.Context, domain string) (bool, error) {
	out, err := p.client.GetEmailIdentity(ctx, &sesv2.GetEmailIdentityInput{EmailIdentity: aws.String(domain)})
	if err != nil {
		return false, err
	}
	return out.VerifiedForSendingStatus, nil
}

func (p *sesProvider) send(ctx context.Context, raw []byte) (string, error) {
	out, err := p.client.SendEmail(ctx, &sesv2.SendEmailInput{Content: &sestypes.EmailContent{Raw: &sestypes.RawMessage{Data: raw}}})
	if err != nil {
		return "", err
	}
	return aws.ToString(out.MessageId), nil
}

func (s *server) emailRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/email/settings", s.member(s.emailSettings))
	mux.Handle("PUT /api/v1/email/settings", s.member(s.emailSettings))
	mux.Handle("GET /api/v1/email/domains", s.member(s.listDomains))
	mux.Handle("POST /api/v1/email/domains", s.member(s.addDomain))
	mux.Handle("POST /api/v1/email/domains/{id}/check", s.member(s.checkDomain))
	mux.Handle("GET /api/v1/leads/{id}/emails", s.member(s.leadEmails))
	mux.Handle("POST /api/v1/leads/{id}/emails", s.member(s.sendLeadEmail))
	mux.HandleFunc("GET /api/v1/public/email/l/{token}", s.emailClick)
	mux.HandleFunc("GET /api/v1/public/email/u/{token}", s.unsubscribePage)
	mux.HandleFunc("POST /api/v1/public/email/u/{token}", s.unsubscribe)
	mux.HandleFunc("POST /api/v1/public/email/inbound", s.emailInbound)
}

func (s *server) emailOff() error {
	return &apiError{http.StatusServiceUnavailable, "email_off", "Email to leads is not set up for Caller Whale yet."}
}

// ---- tokens that carry their agency ----

func orgToken(org string) string {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	return strings.ReplaceAll(org, "-", "") + "." + hex.EncodeToString(b)
}

// tokenOrg is the agency a token belongs to; "" when it is not one of ours.
func tokenOrg(token string) string {
	h, rest, ok := strings.Cut(token, ".")
	if !ok || len(h) != 32 || len(rest) != 20 {
		return ""
	}
	if _, err := hex.DecodeString(h + rest); err != nil {
		return ""
	}
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// ---- settings and domains ----

// emailSettings is GET (anyone in the agency) and PUT {postal_address} (the owner or an admin): the address every email carries (D317).
func (s *server) emailSettings(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if q.r.Method == http.MethodPut {
		if !manages(q.sc) {
			return forbidden("The owner or an admin sets the agency's postal address.")
		}
		var body struct {
			PostalAddress string `json:"postal_address"`
		}
		if err := readJSON(q.w, q.r, &body); err != nil {
			return err
		}
		addr := strings.TrimSpace(body.PostalAddress)
		if len(addr) < 10 || len(addr) > 300 {
			return bad("Give the agency's full postal address (10 to 300 characters).")
		}
		if _, err := tx.Exec(ctx, `UPDATE orgs SET postal_address = $1 WHERE id = cw_org()`, addr); err != nil {
			return err
		}
	}
	var addr string
	if err := tx.QueryRow(ctx, `SELECT postal_address FROM orgs WHERE id = cw_org()`).Scan(&addr); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"postal_address": addr, "set_up": s.mail != nil})
	return nil
}

func (s *server) listDomains(q *req) error {
	if q.sc.external() {
		return forbidden("Clients do not see the agency's domains.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `SELECT to_jsonb(d.*) FROM sending_domains d ORDER BY client_id NULLS FIRST`)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"domains": rows})
	return nil
}

var domainPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`)

// addDomain is POST /api/v1/email/domains {domain, client_id, from_local}: the owner or an admin adds the agency's or a client's
// sending domain; the answer lists the DNS records to add.
func (s *server) addDomain(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner or an admin adds sending domains.")
	}
	if s.mail == nil {
		return s.emailOff()
	}
	var body struct {
		Domain    string `json:"domain"`
		ClientID  string `json:"client_id"`
		FromLocal string `json:"from_local"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	domain := strings.ToLower(strings.TrimSpace(body.Domain))
	local := strings.ToLower(strings.TrimSpace(body.FromLocal))
	if local == "" {
		local = "team"
	}
	if !domainPattern.MatchString(domain) || len(domain) > 200 || !regexp.MustCompile(`^[a-z0-9._-]{1,40}$`).MatchString(local) {
		return bad("Give a domain like mail.youragency.com, and a sender name like team.")
	}
	if body.ClientID != "" && !validID(body.ClientID) {
		return bad("client_id is an id.")
	}
	ctx := q.r.Context()
	records, err := s.mail.addDomain(ctx, domain)
	if err != nil {
		log.Printf("WARN adding sending domain: %v", err)
		return &apiError{http.StatusBadGateway, "provider", "The mail provider did not take the domain. Check it is yours, or try again."}
	}
	records = append(records,
		map[string]string{"type": "TXT", "name": domain, "value": "v=spf1 include:amazonses.com ~all"},
		map[string]string{"type": "TXT", "name": "_dmarc." + domain, "value": "v=DMARC1; p=quarantine"})
	raw, _ := json.Marshal(records)
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `INSERT INTO sending_domains (org_id, client_id, domain, from_local, records, created_by) VALUES (cw_org(), $1, $2, $3, $4, $5)
		RETURNING to_jsonb(sending_domains.*)`, nullID(body.ClientID), domain, local, raw, q.sc.userID)
	if err != nil {
		if isUnique(err) {
			return conflictErr("That domain is already in use, or this agency (or client) already has one.")
		}
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, rows[0])
	return nil
}

// checkDomain is POST /api/v1/email/domains/{id}/check: whether the DNS records are in place yet.
func (s *server) checkDomain(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner or an admin checks sending domains.")
	}
	if s.mail == nil {
		return s.emailOff()
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var domain string
	if err := tx.QueryRow(ctx, `SELECT domain FROM sending_domains WHERE id = $1`, nullID(q.r.PathValue("id"))).Scan(&domain); err != nil {
		return notFound("No such domain.")
	}
	ok, err := s.mail.verified(ctx, domain)
	if err != nil {
		return &apiError{http.StatusBadGateway, "provider", "The mail provider could not be asked. Try again."}
	}
	rows, err := queryJSON(ctx, tx, `UPDATE sending_domains SET status = CASE WHEN $2 THEN 'verified' ELSE 'pending' END,
		verified_at = CASE WHEN $2 THEN coalesce(verified_at, now()) END WHERE id = $1 RETURNING to_jsonb(sending_domains.*)`, q.r.PathValue("id"), ok)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, rows[0])
	return nil
}

// ---- sending ----

var linkPattern = regexp.MustCompile(`https?://[^\s<>"')\]]+`)

func (s *server) leadEmails(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	r := &run{s: s, ctx: ctx, sc: q.sc, tx: tx}
	if l, err := r.lead(q.r.PathValue("id"), false); err != nil || l == nil || q.sc.external() {
		return notFound("No such lead.")
	}
	rows, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('id', e.id, 'direction', e.direction, 'user_id', e.user_id, 'from', e.from_addr, 'to', e.to_addr,
		'subject', e.subject, 'body', e.body, 'status', e.status, 'waiting', e.waiting, 'created_at', e.created_at,
		'clicks', (SELECT coalesce(jsonb_agg(jsonb_build_object('url', k.url, 'clicks', k.clicks, 'last_click_at', k.last_click_at)) FILTER (WHERE k.clicks > 0), '[]')
			FROM email_links k WHERE k.email_id = e.id))
		FROM lead_emails e WHERE e.lead_id = $1 ORDER BY e.created_at`, q.r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"emails": rows})
	return nil
}

// sendLeadEmail is POST /api/v1/leads/{id}/emails {subject, body}: someone who works the lead writes to them from the client's or the
// agency's verified domain, with the agency's address and an unsubscribe link at the end, and replies coming back here.
func (s *server) sendLeadEmail(q *req) error {
	if s.mail == nil || s.cfg.emailReplyDomain == "" || s.cfg.emailPublicURL == "" {
		return s.emailOff()
	}
	var body struct {
		Subject string `json:"subject"`
		Body    string `json:"body"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	subject, text := strings.TrimSpace(body.Subject), strings.TrimSpace(body.Body)
	if subject == "" || len(subject) > 200 || strings.ContainsAny(subject, "\r\n") || text == "" || len(text) > 50000 {
		return bad("Write a subject (up to 200 characters, one line) and a message.")
	}
	if !q.sc.can("message") || q.sc.external() {
		return forbidden("Your role does not write to leads.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	r := &run{s: s, ctx: ctx, sc: q.sc, tx: tx}
	lead, err := r.lead(q.r.PathValue("id"), false)
	if err != nil {
		return err
	}
	if lead == nil || !canEditLead(q.sc, lead) {
		return notFound("The lead was not found, or is not one you work.")
	}
	to, err := mail.ParseAddress(asString(lead["email"]))
	if err != nil {
		return conflictErr("The lead has no email address that can receive mail.")
	}
	var unsubscribed bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM email_unsubscribes WHERE address = lower($1))`, to.Address).Scan(&unsubscribed); err != nil {
		return err
	}
	if unsubscribed {
		return conflictErr("This address unsubscribed from the agency's emails.")
	}
	var agency, postal string
	if err := tx.QueryRow(ctx, `SELECT name, postal_address FROM orgs WHERE id = cw_org()`).Scan(&agency, &postal); err != nil {
		return err
	}
	if postal == "" {
		return conflictErr("Set the agency's postal address first: every email carries it.")
	}
	// The lead's client's domain, else the agency's (D161, D319); only a verified one.
	var domain, local string
	err = tx.QueryRow(ctx, `SELECT domain, from_local FROM sending_domains WHERE status = 'verified' AND (client_id = $1::uuid OR client_id IS NULL)
		ORDER BY client_id NULLS LAST LIMIT 1`, nullID(asString(lead["client_id"]))).Scan(&domain, &local)
	if errors.Is(err, pgx.ErrNoRows) {
		return conflictErr("This agency (or the lead's client) has no verified sending domain yet.")
	}
	if err != nil {
		return err
	}
	id, token := newUUIDString(), orgToken(q.sc.orgID)
	// Links become tracked links (D316); opens are never tracked.
	var links [][2]string
	tracked := linkPattern.ReplaceAllStringFunc(text, func(u string) string {
		if len(links) >= 30 {
			return u
		}
		t := orgToken(q.sc.orgID)
		links = append(links, [2]string{t, u})
		return s.cfg.emailPublicURL + "/api/v1/public/email/l/" + t
	})
	unsubscribe := s.cfg.emailPublicURL + "/api/v1/public/email/u/" + token
	full := tracked + "\n\n--\n" + agency + "\n" + postal + "\nTo stop emails from " + agency + ": " + unsubscribe + "\n"
	from := &mail.Address{Name: q.sc.label + " | " + agency, Address: local + "@" + domain}
	replyTo := "reply+" + token + "@" + s.cfg.emailReplyDomain
	raw := buildEmail(from, to, replyTo, subject, full, unsubscribe, id+"@"+domain)
	if _, err := tx.Exec(ctx, `INSERT INTO lead_emails (id, org_id, lead_id, user_id, direction, from_addr, to_addr, subject, body, reply_token, status)
		VALUES ($1, cw_org(), $2, $3, 'outgoing', $4, $5, $6, $7, $8, 'sent')`, id, lead["id"], q.sc.userID, from.Address, to.Address, subject, text, token); err != nil {
		return err
	}
	for _, l := range links {
		if _, err := tx.Exec(ctx, `INSERT INTO email_links (token, org_id, email_id, lead_id, url) VALUES ($1, cw_org(), $2, $3, $4)`, l[0], id, lead["id"], l[1]); err != nil {
			return err
		}
	}
	// Writing to the lead answers their waiting emails.
	if _, err := tx.Exec(ctx, `UPDATE lead_emails SET waiting = false WHERE lead_id = $1 AND waiting`, lead["id"]); err != nil {
		return err
	}
	providerID, err := s.mail.send(ctx, raw)
	if err != nil {
		log.Printf("WARN email %s: %v", id, err)
		return &apiError{http.StatusBadGateway, "provider", "The mail provider did not take the email. Try again in a moment."}
	}
	if _, err := tx.Exec(ctx, `UPDATE lead_emails SET provider_id = $2 WHERE id = $1`, id, providerID); err != nil {
		return err
	}
	if err := (&run{s: s, ctx: ctx, sc: q.sc, tx: tx, op: op{ID: newUUIDString()}}).record(change{entity: "lead", kind: "lead.emailed", id: asString(lead["id"]), leadID: asString(lead["id"])}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"id": id, "from": from.Address, "to": to.Address, "status": "sent"})
	return nil
}

// buildEmail is a plain-text email with the one-click unsubscribe headers (RFC 8058).
func buildEmail(from, to *mail.Address, replyTo, subject, text, unsubscribe, messageID string) []byte {
	var b bytes.Buffer
	h := func(k, v string) { fmt.Fprintf(&b, "%s: %s\r\n", k, v) }
	h("From", from.String())
	h("To", to.String())
	h("Reply-To", "<"+replyTo+">")
	h("Subject", mime.QEncoding.Encode("utf-8", subject))
	h("Date", time.Now().UTC().Format(time.RFC1123Z))
	h("Message-ID", "<"+messageID+">")
	h("List-Unsubscribe", "<"+unsubscribe+">")
	h("List-Unsubscribe-Post", "List-Unsubscribe=One-Click")
	h("MIME-Version", "1.0")
	h("Content-Type", `text/plain; charset="utf-8"`)
	h("Content-Transfer-Encoding", "base64")
	b.WriteString("\r\n")
	enc := base64.StdEncoding.EncodeToString([]byte(strings.ReplaceAll(text, "\n", "\r\n")))
	for len(enc) > 76 {
		b.WriteString(enc[:76] + "\r\n")
		enc = enc[76:]
	}
	b.WriteString(enc + "\r\n")
	return b.Bytes()
}

// ---- the open routes: clicks, unsubscribing, replies ----

// inOrg runs fn in the agency a token belongs to.
func (s *server) inOrg(ctx context.Context, token string, fn func(pgx.Tx) error) error {
	org := tokenOrg(token)
	if org == "" {
		return pgx.ErrNoRows
	}
	tx, err := s.st.begin(ctx, scope{orgID: org})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// emailClick records a click on the lead and goes on to the link (D316).
func (s *server) emailClick(w http.ResponseWriter, r *http.Request) {
	var target string
	err := s.inOrg(r.Context(), r.PathValue("token"), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `UPDATE email_links SET clicks = clicks + 1, first_click_at = coalesce(first_click_at, now()), last_click_at = now()
			WHERE token = $1 RETURNING url`, r.PathValue("token")).Scan(&target)
	})
	if err != nil || target == "" {
		http.Error(w, "This link has expired.", http.StatusNotFound)
		return
	}
	http.Redirect(w, r, target, http.StatusFound)
}

// unsubscribePage asks to confirm (a link scanner opening the link must not unsubscribe anyone); the button posts to unsubscribe.
func (s *server) unsubscribePage(w http.ResponseWriter, r *http.Request) {
	token := html.EscapeString(r.PathValue("token"))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<!doctype html><meta name="viewport" content="width=device-width"><title>Unsubscribe</title>
<body style="font-family:sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1>Stop these emails?</h1>
<form method="post" action="/api/v1/public/email/u/%s"><button style="font-size:1rem;padding:.6rem 1.2rem">Unsubscribe</button></form></body>`, token)
}

// unsubscribe blocks email to the address for the whole agency (D317); also the one-click POST mail apps send.
func (s *server) unsubscribe(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	err := s.inOrg(r.Context(), token, func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `INSERT INTO email_unsubscribes (org_id, address, email_id)
			SELECT cw_org(), lower(to_addr), id FROM lead_emails WHERE reply_token = $1 ON CONFLICT DO NOTHING`, token)
		return err
	})
	if err != nil {
		http.Error(w, "This link has expired.", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, `<!doctype html><meta name="viewport" content="width=device-width"><title>Unsubscribed</title>
<body style="font-family:sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1>You are unsubscribed.</h1><p>You will get no more emails from this agency.</p></body>`)
}

type snsMessage struct {
	Type             string `json:"Type"`
	MessageID        string `json:"MessageId"`
	Token            string `json:"Token"`
	TopicArn         string `json:"TopicArn"`
	Subject          string `json:"Subject"`
	Message          string `json:"Message"`
	Timestamp        string `json:"Timestamp"`
	SignatureVersion string `json:"SignatureVersion"`
	Signature        string `json:"Signature"`
	SigningCertURL   string `json:"SigningCertURL"`
	SubscribeURL     string `json:"SubscribeURL"`
}

var snsHost = regexp.MustCompile(`^sns\.[a-z0-9-]+\.amazonaws\.com$`)

// verifySNS checks an SNS message's signature against Amazon's certificate (only certificates served by SNS itself are trusted).
func (s *server) verifySNS(ctx context.Context, m snsMessage) error {
	u, err := url.Parse(m.SigningCertURL)
	if err != nil || u.Scheme != "https" || !snsHost.MatchString(u.Host) {
		return errors.New("the signing certificate is not Amazon's")
	}
	pemBytes, err := s.fetchCert(ctx, m.SigningCertURL)
	if err != nil {
		return err
	}
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return errors.New("no certificate")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return err
	}
	pub, ok := cert.PublicKey.(*rsa.PublicKey)
	if !ok {
		return errors.New("not an RSA certificate")
	}
	var b strings.Builder
	add := func(k, v string) { b.WriteString(k + "\n" + v + "\n") }
	add("Message", m.Message)
	add("MessageId", m.MessageID)
	if m.Type == "Notification" {
		if m.Subject != "" {
			add("Subject", m.Subject)
		}
		add("Timestamp", m.Timestamp)
		add("TopicArn", m.TopicArn)
		add("Type", m.Type)
	} else {
		add("SubscribeURL", m.SubscribeURL)
		add("Timestamp", m.Timestamp)
		add("Token", m.Token)
		add("TopicArn", m.TopicArn)
		add("Type", m.Type)
	}
	sig, err := base64.StdEncoding.DecodeString(m.Signature)
	if err != nil {
		return err
	}
	if m.SignatureVersion == "2" {
		sum := sha256.Sum256([]byte(b.String()))
		return rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig)
	}
	sum := sha1.Sum([]byte(b.String()))
	return rsa.VerifyPKCS1v15(pub, crypto.SHA1, sum[:], sig)
}

func defaultFetchCert(ctx context.Context, certURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, certURL, nil)
	if err != nil {
		return nil, err
	}
	res, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	return io.ReadAll(io.LimitReader(res.Body, 64<<10))
}

// emailInbound is SNS delivering what SES received on the reply domain: a lead's reply goes onto their record (D318).
func (s *server) emailInbound(w http.ResponseWriter, r *http.Request) {
	var m snsMessage
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&m); err != nil {
		http.Error(w, "bad message", http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	if s.cfg.emailTopic == "" || m.TopicArn != s.cfg.emailTopic {
		http.Error(w, "unknown topic", http.StatusForbidden)
		return
	}
	if err := s.verifySNS(ctx, m); err != nil {
		log.Printf("WARN inbound email: %v", err)
		http.Error(w, "bad signature", http.StatusForbidden)
		return
	}
	switch m.Type {
	case "SubscriptionConfirmation":
		if u, err := url.Parse(m.SubscribeURL); err == nil && u.Scheme == "https" && snsHost.MatchString(u.Host) {
			if req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.SubscribeURL, nil); err == nil {
				if res, err := (&http.Client{Timeout: 10 * time.Second}).Do(req); err == nil {
					res.Body.Close()
				}
			}
		}
	case "Notification":
		if err := s.receiveEmail(ctx, m.Message); err != nil {
			log.Printf("WARN inbound email: %v", err)
		}
	}
	w.WriteHeader(http.StatusOK)
}

// receiveEmail files one received email on the lead its reply address names.
func (s *server) receiveEmail(ctx context.Context, notification string) error {
	var n struct {
		Mail struct {
			Destination []string `json:"destination"`
			Source      string   `json:"source"`
		} `json:"mail"`
		Receipt struct {
			Action struct {
				Encoding string `json:"encoding"`
			} `json:"action"`
		} `json:"receipt"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal([]byte(notification), &n); err != nil {
		return err
	}
	token := ""
	for _, d := range n.Mail.Destination {
		if a, err := mail.ParseAddress(d); err == nil {
			local, domain, _ := strings.Cut(strings.ToLower(a.Address), "@")
			if domain == strings.ToLower(s.cfg.emailReplyDomain) && strings.HasPrefix(local, "reply+") {
				token = strings.TrimPrefix(local, "reply+")
			}
		}
	}
	if token == "" {
		return nil // not a reply to a lead email
	}
	raw := []byte(n.Content)
	if strings.EqualFold(n.Receipt.Action.Encoding, "BASE64") {
		var err error
		if raw, err = base64.StdEncoding.DecodeString(n.Content); err != nil {
			return err
		}
	}
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return err
	}
	from := n.Mail.Source
	if a, err := mail.ParseAddress(msg.Header.Get("From")); err == nil {
		from = a.Address
	}
	subject, _ := (&mime.WordDecoder{}).DecodeHeader(msg.Header.Get("Subject"))
	text := stripQuoted(plainText(msg))
	if text == "" {
		text = "(no text)"
	}
	return s.inOrg(ctx, token, func(tx pgx.Tx) error {
		var lead, to string
		if err := tx.QueryRow(ctx, `SELECT lead_id::text, from_addr FROM lead_emails WHERE reply_token = $1`, token).Scan(&lead, &to); err != nil {
			return nil // a token we never sent
		}
		var id string
		if err := tx.QueryRow(ctx, `INSERT INTO lead_emails (org_id, lead_id, direction, from_addr, to_addr, subject, body, status, waiting)
			VALUES (cw_org(), $1, 'incoming', $2, $3, $4, $5, 'received', true) RETURNING id::text`, lead, truncateText(from, 300), to, truncateText(subject, 300), truncateText(text, 100000)).Scan(&id); err != nil {
			return err
		}
		if _, err := s.st.db.Exec(ctx, `INSERT INTO email_waits (email_id, org_id, due_at) VALUES ($1, $2, now() + make_interval(mins => $3))`, id, tokenOrg(token), emailWaitMinutes); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) VALUES (cw_org(), 'lead', $1, $1, 'upsert')`, lead)
		return err
	})
}

func truncateText(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// plainText is a message's text/plain part (the first one found).
func plainText(msg *mail.Message) string {
	media, params, _ := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	body := decodePart(msg.Body, msg.Header.Get("Content-Transfer-Encoding"))
	if strings.HasPrefix(media, "multipart/") {
		mr := multipart.NewReader(body, params["boundary"])
		for {
			p, err := mr.NextPart()
			if err != nil {
				return ""
			}
			pm, pp, _ := mime.ParseMediaType(p.Header.Get("Content-Type"))
			if strings.HasPrefix(pm, "multipart/") {
				inner := &mail.Message{Header: mail.Header{"Content-Type": {p.Header.Get("Content-Type")}}, Body: p}
				_ = pp
				if t := plainText(inner); t != "" {
					return t
				}
				continue
			}
			if pm == "text/plain" {
				b, _ := io.ReadAll(io.LimitReader(decodePart(p, p.Header.Get("Content-Transfer-Encoding")), 1<<20))
				return string(b)
			}
		}
	}
	if media == "" || media == "text/plain" {
		b, _ := io.ReadAll(io.LimitReader(body, 1<<20))
		return string(b)
	}
	return ""
}

func decodePart(r io.Reader, encoding string) io.Reader {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "base64":
		return base64.NewDecoder(base64.StdEncoding, r) // line breaks are skipped
	case "quoted-printable":
		return quotedprintable.NewReader(r)
	}
	return r
}

// stripQuoted keeps what the lead wrote, without the quoted email below it.
func stripQuoted(text string) string {
	var keep []string
	sc := bufio.NewScanner(strings.NewReader(strings.ReplaceAll(text, "\r\n", "\n")))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	quoteStart := regexp.MustCompile(`^(On .+ wrote:|-----Original Message-----|From: .+)$`)
	for sc.Scan() {
		line := sc.Text()
		if quoteStart.MatchString(strings.TrimSpace(line)) {
			break
		}
		if strings.HasPrefix(strings.TrimSpace(line), ">") {
			continue
		}
		keep = append(keep, line)
	}
	return strings.TrimSpace(strings.Join(keep, "\n"))
}

// ---- the wait (D318) ----

// checkEmailWaits tells the team's leads and deputies (the owner when the team has none) about replies left unanswered, with a task.
func (s *server) checkEmailWaits(ctx context.Context) error {
	rows, err := s.st.db.Query(ctx, `DELETE FROM email_waits WHERE due_at <= now() RETURNING email_id::text, org_id::text`)
	if err != nil {
		return err
	}
	type due struct{ email, org string }
	var list []due
	for rows.Next() {
		var d due
		if err := rows.Scan(&d.email, &d.org); err != nil {
			rows.Close()
			return err
		}
		list = append(list, d)
	}
	rows.Close()
	for _, d := range list {
		if err := s.tellAboutEmail(ctx, d.org, d.email); err != nil {
			log.Printf("WARN email %s waiting: %v", d.email, err)
		}
	}
	return nil
}

func (s *server) tellAboutEmail(ctx context.Context, org, email string) error {
	tx, err := s.st.begin(ctx, scope{orgID: org})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var lead, name string
	var team *string
	var waiting bool
	if err := tx.QueryRow(ctx, `SELECT e.lead_id::text, l.name, l.team_id::text, e.waiting FROM lead_emails e JOIN leads l ON l.id = e.lead_id WHERE e.id = $1`, email).Scan(&lead, &name, &team, &waiting); err != nil || !waiting {
		return nil
	}
	var tell []string
	if team != nil {
		if teams, err := s.rules.teams(ctx, org); err == nil {
			for _, t := range teams {
				if t.TeamID == *team {
					tell = append(append(tell, t.leads()...), t.DeputyIDs...)
				}
			}
		}
	}
	if len(tell) == 0 {
		if members, err := s.rules.members(ctx, org); err == nil {
			for _, m := range members {
				if slices.Contains(m.Roles, "owner") || slices.Contains(m.Roles, "solo") {
					tell = append(tell, m.UserID)
				}
			}
		}
	}
	for _, who := range tell {
		var task string
		if err := tx.QueryRow(ctx, `INSERT INTO tasks (org_id, lead_id, assignee_id, title, type, priority, due_at) VALUES (cw_org(), $1, $2, $3, 'Task', 'High', now()) RETURNING id::text`,
			lead, who, "An email from "+name+" is waiting for an answer").Scan(&task); err != nil {
			return err
		}
		// Caller Whale itself made the task: the devices are told, with no person as its author.
		var seq int64
		if err := tx.QueryRow(ctx, `INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) VALUES (cw_org(), 'task', $1, $2, 'upsert') RETURNING seq`, task, lead).Scan(&seq); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT pg_notify('cw_events', jsonb_build_object('org_id', cw_org(), 'kind', 'task.created', 'entity', 'task', 'seq', $1::bigint)::text)`, seq); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
