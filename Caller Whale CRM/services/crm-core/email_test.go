package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/mail"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeMail struct {
	mu   sync.Mutex
	sent [][]byte
}

func (f *fakeMail) addDomain(_ context.Context, domain string) ([]map[string]string, error) {
	return []map[string]string{{"type": "CNAME", "name": "abc._domainkey." + domain, "value": "abc.dkim.amazonses.com"}}, nil
}
func (f *fakeMail) verified(context.Context, string) (bool, error) { return true, nil }
func (f *fakeMail) send(_ context.Context, raw []byte) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, raw)
	return "ses-1", nil
}

// snsSigner signs SNS messages the way Amazon does, with a stand-in certificate.
type snsSigner struct {
	key  *rsa.PrivateKey
	cert []byte
}

func newSNSSigner(t *testing.T) *snsSigner {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "sns.amazonaws.com"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return &snsSigner{key: key, cert: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

func (s *snsSigner) notification(topic, message string) snsMessage {
	m := snsMessage{Type: "Notification", MessageID: "m-1", TopicArn: topic, Message: message, Timestamp: time.Now().UTC().Format(time.RFC3339),
		SignatureVersion: "2", SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-x.pem"}
	toSign := "Message\n" + m.Message + "\nMessageId\n" + m.MessageID + "\nTimestamp\n" + m.Timestamp + "\nTopicArn\n" + m.TopicArn + "\nType\n" + m.Type + "\n"
	sum := sha256.Sum256([]byte(toSign))
	sig, _ := rsa.SignPKCS1v15(rand.Reader, s.key, crypto.SHA256, sum[:])
	m.Signature = base64.StdEncoding.EncodeToString(sig)
	return m
}

// Step 29: email to a lead from the agency's verified domain, with the agency's address, a one-click unsubscribe and tracked links;
// the reply comes back onto the lead through a signed SNS message; a reply left waiting tells the team's lead; unsubscribing blocks
// the address for the agency (D161, D316-D319).
func TestLeadEmail(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	provider := &fakeMail{}
	signer := newSNSSigner(t)
	e.s.mail = provider
	e.s.fetchCert = func(context.Context, string) ([]byte, error) { return signer.cert, nil }
	e.s.cfg.emailPublicURL, e.s.cfg.emailReplyDomain, e.s.cfg.emailTopic = "https://api.test", "reply.test", "arn:aws:sns:us-east-1:1:inbound"
	const teamT, dave = "aaaaaaaa-0000-4000-8000-0000000000f1", "44444444-4444-4444-8444-444444444444"
	e.rules.mu.Lock()
	e.rules.teamList = map[string][]authzTeam{orgA: {{TeamID: teamT, Name: "T", ManagerID: dave, ManagerIDs: []string{dave}}}}
	e.rules.grants[bob+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"own"}, TeamIDs: []string{teamT}, Capabilities: []string{"edit", "call", "message"}, Roles: []string{"caller"}}
	e.rules.mu.Unlock()
	e.call(alice, orgA, "GET", "/api/v1/admin/teams", nil)
	lead := newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": lead, "name": "Pat", "phone": "512-555-0801", "email": "pat@example.com"}), "applied")
	if _, err := e.admin.Exec(ctx, `UPDATE crm.leads SET team_id = $2, assignee_id = $3 WHERE id = $1`, lead, teamT, bob); err != nil {
		t.Fatal(err)
	}
	send := func() (int, map[string]any) {
		return e.call(bob, orgA, "POST", "/api/v1/leads/"+lead+"/emails", map[string]any{"subject": "Your house", "body": "Hi Pat, see https://example.com/offer?id=1 and call me."})
	}
	if status, _ := send(); status != 409 {
		t.Fatalf("sent without the agency's address: %d", status)
	}
	if status, _ := e.call(bob, orgA, "PUT", "/api/v1/email/settings", map[string]any{"postal_address": "1 Main St, Austin TX 78701"}); status != 403 {
		t.Fatalf("a caller sets the address: %d", status)
	}
	e.call(alice, orgA, "PUT", "/api/v1/email/settings", map[string]any{"postal_address": "1 Main St, Austin TX 78701"})
	if status, _ := send(); status != 409 {
		t.Fatalf("sent without a verified domain: %d", status)
	}
	status, dom := e.call(alice, orgA, "POST", "/api/v1/email/domains", map[string]any{"domain": "mail.blue-door.test"})
	if status != 200 || len(dom["records"].([]any)) != 3 {
		t.Fatalf("domain: %d %v", status, dom)
	}
	if status, _ := send(); status != 409 {
		t.Fatalf("sent from an unverified domain: %d", status)
	}
	e.call(alice, orgA, "POST", "/api/v1/email/domains/"+dom["id"].(string)+"/check", nil)
	if status, out := send(); status != 200 || out["from"] != "team@mail.blue-door.test" {
		t.Fatalf("send: %d %v", status, out)
	}

	provider.mu.Lock()
	msg, err := mail.ReadMessage(bytes.NewReader(provider.sent[0]))
	provider.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(base64.NewDecoder(base64.StdEncoding, msg.Body))
	body := string(raw)
	if msg.Header.Get("List-Unsubscribe-Post") != "List-Unsubscribe=One-Click" || !strings.Contains(body, "1 Main St, Austin TX 78701") ||
		strings.Contains(body, "https://example.com/offer") || !strings.Contains(body, "https://api.test/api/v1/public/email/l/") {
		t.Fatalf("the email: %v\n%s", msg.Header, body)
	}
	replyTo := strings.Trim(msg.Header.Get("Reply-To"), "<>")
	if !strings.HasPrefix(replyTo, "reply+") || !strings.HasSuffix(replyTo, "@reply.test") {
		t.Fatalf("reply-to: %q", replyTo)
	}

	// A click is recorded and goes on to the link.
	link := regexp.MustCompile(`/api/v1/public/email/l/[0-9a-f.]+`).FindString(body)
	rec := httptest.NewRecorder()
	e.s.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, link, nil))
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "https://example.com/offer?id=1" {
		t.Fatalf("click: %d %s", rec.Code, rec.Header().Get("Location"))
	}

	// The reply, through SES and SNS.
	reply := "From: Pat <pat@example.com>\r\nTo: " + replyTo + "\r\nSubject: Re: Your house\r\nContent-Type: text/plain\r\n\r\nYes, call me Friday.\r\n\r\nOn Tue, Nov 18, 2026 Bob wrote:\r\n> Hi Pat\r\n"
	ses, _ := json.Marshal(map[string]any{"mail": map[string]any{"destination": []string{replyTo}, "source": "pat@example.com"},
		"receipt": map[string]any{"action": map[string]any{"type": "SNS", "encoding": "BASE64"}}, "content": base64.StdEncoding.EncodeToString([]byte(reply))})
	post := func(m snsMessage) int {
		raw, _ := json.Marshal(m)
		rec := httptest.NewRecorder()
		e.s.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/public/email/inbound", bytes.NewReader(raw)))
		return rec.Code
	}
	forged := signer.notification(e.s.cfg.emailTopic, string(ses))
	forged.Message = strings.Replace(forged.Message, "pat@example.com", "evil@example.com", 1)
	if code := post(forged); code != http.StatusForbidden {
		t.Fatalf("a forged message: %d", code)
	}
	if code := post(signer.notification(e.s.cfg.emailTopic, string(ses))); code != 200 {
		t.Fatalf("inbound: %d", code)
	}
	_, thread := e.call(bob, orgA, "GET", "/api/v1/leads/"+lead+"/emails", nil)
	emails := thread["emails"].([]any)
	in := emails[len(emails)-1].(map[string]any)
	if len(emails) != 2 || in["direction"] != "incoming" || in["body"] != "Yes, call me Friday." || in["waiting"] != true {
		t.Fatalf("the reply on the lead: %v", emails)
	}
	if clicks := emails[0].(map[string]any)["clicks"].([]any); len(clicks) != 1 {
		t.Fatalf("the click on the lead: %v", emails[0])
	}

	// Left waiting: the team's lead is told with a task.
	if _, err := e.admin.Exec(ctx, `UPDATE crm.email_waits SET due_at = now() - interval '1 minute'`); err != nil {
		t.Fatal(err)
	}
	if err := e.s.checkEmailWaits(ctx); err != nil {
		t.Fatal(err)
	}
	var tasks int
	if err := e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.tasks WHERE assignee_id = $1 AND lead_id = $2 AND title LIKE 'An email from Pat%'`, dave, lead).Scan(&tasks); err != nil || tasks != 1 {
		t.Fatalf("the team's lead was told: %d %v", tasks, err)
	}

	// Unsubscribing: the page alone changes nothing; the button (or the one-click POST) blocks the address for the agency.
	unsub := regexp.MustCompile(`/api/v1/public/email/u/[0-9a-f.]+`).FindString(body)
	rec = httptest.NewRecorder()
	e.s.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, unsub, nil))
	if status, _ := send(); status != 200 {
		t.Fatalf("opening the page unsubscribed: %d", status)
	}
	rec = httptest.NewRecorder()
	e.s.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, unsub, strings.NewReader("List-Unsubscribe=One-Click")))
	if rec.Code != 200 {
		t.Fatalf("unsubscribe: %d", rec.Code)
	}
	if status, _ := send(); status != 409 {
		t.Fatalf("emailed after unsubscribing: %d", status)
	}
}
