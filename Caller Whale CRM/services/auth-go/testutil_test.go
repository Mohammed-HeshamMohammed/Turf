package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Tests run against a real PostgreSQL: AUTH_TEST_DATABASE_URL, like postgres://postgres@127.0.0.1:5433/postgres. Each test makes its
// own schema and drops it afterwards. Without the variable they are skipped.
func testDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("AUTH_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("AUTH_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := "t_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	db, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Close()
		_, _ = admin.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
	})
	if err := setupDatabase(ctx, db); err != nil {
		t.Fatal(err)
	}
	return db
}

// fakeFirebase stands in for Identity Toolkit and Secure Token: accounts in memory, the same refusals Firebase gives.
type fakeFirebase struct {
	mu        sync.Mutex
	srv       *httptest.Server
	accounts  map[string]*fbAccount // by email
	sent      []string              // "VERIFY_EMAIL:email" and "PASSWORD_RESET:email"
	down      bool
	pending   bool // sign-in answers with an old Firebase authenticator pending
	refreshes int

	// Google and Apple through Firebase
	idpNonces     []string // the raw nonce Firebase was given for an Apple token
	idpTokens     []string // the ID tokens Firebase was handed
	brokered      bool     // Firebase owns the provider's client: createAuthUri answers
	brokeredEmail string   // who the brokered flow signs in
	idpDown       bool
}

type fbAccount struct {
	uid, email, password, name string
	verified, disabled         bool
	refresh                    string
}

func newFakeFirebase(t *testing.T) *fakeFirebase {
	f := &fakeFirebase{accounts: map[string]*fbAccount{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeFirebase) fail(w http.ResponseWriter, message string) {
	w.WriteHeader(http.StatusBadRequest)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": message}})
}

func (f *fakeFirebase) byToken(token string) *fbAccount {
	for _, a := range f.accounts {
		if token == "id-"+a.uid {
			return a
		}
	}
	return nil
}

func (f *fakeFirebase) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.down {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if r.URL.Query().Get("key") != "test-key" {
		f.fail(w, "API_KEY_INVALID")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if strings.HasSuffix(r.URL.Path, "/v1/token") {
		_ = r.ParseForm()
		for _, a := range f.accounts {
			if a.refresh == r.PostForm.Get("refresh_token") {
				f.refreshes++
				a.refresh = fmt.Sprintf("rt-%s-%d", a.uid, f.refreshes)
				_ = json.NewEncoder(w).Encode(map[string]any{"id_token": "id-" + a.uid, "refresh_token": a.refresh, "user_id": a.uid})
				return
			}
		}
		f.fail(w, "INVALID_REFRESH_TOKEN")
		return
	}
	var in map[string]any
	_ = json.NewDecoder(r.Body).Decode(&in)
	str := func(k string) string { s, _ := in[k].(string); return s }
	login := func(a *fbAccount) {
		a.refresh = "rt-" + a.uid
		out := map[string]any{"idToken": "id-" + a.uid, "refreshToken": a.refresh, "localId": a.uid, "email": a.email}
		if f.pending {
			out = map[string]any{"mfaPendingCredential": "pending"}
		}
		_ = json.NewEncoder(w).Encode(out)
	}
	switch {
	case strings.HasSuffix(r.URL.Path, "accounts:signUp"):
		email := str("email")
		if f.accounts[email] != nil {
			f.fail(w, "EMAIL_EXISTS")
			return
		}
		if len(str("password")) < 6 {
			f.fail(w, "WEAK_PASSWORD : Password should be at least 6 characters")
			return
		}
		a := &fbAccount{uid: "uid-" + uuid.NewString()[:8], email: email, password: str("password")}
		f.accounts[email] = a
		login(a)
	case strings.HasSuffix(r.URL.Path, "accounts:signInWithPassword"):
		a := f.accounts[str("email")]
		switch {
		case a == nil || a.password != str("password"):
			f.fail(w, "INVALID_LOGIN_CREDENTIALS")
		case a.disabled:
			f.fail(w, "USER_DISABLED")
		default:
			login(a)
		}
	case strings.HasSuffix(r.URL.Path, "accounts:lookup"):
		a := f.byToken(str("idToken"))
		if a == nil {
			f.fail(w, "INVALID_ID_TOKEN")
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"users": []map[string]any{{"localId": a.uid, "email": a.email, "displayName": a.name, "emailVerified": a.verified, "disabled": a.disabled}}})
	case strings.HasSuffix(r.URL.Path, "accounts:update"):
		if code := str("oobCode"); code != "" {
			for _, a := range f.accounts {
				if code == "verify-"+a.uid {
					a.verified = true
					_ = json.NewEncoder(w).Encode(map[string]any{"email": a.email})
					return
				}
			}
			f.fail(w, "INVALID_OOB_CODE")
			return
		}
		a := f.byToken(str("idToken"))
		if a == nil {
			f.fail(w, "INVALID_ID_TOKEN")
			return
		}
		if n := str("displayName"); n != "" {
			a.name = n
		}
		if p := str("password"); p != "" {
			a.password = p
		}
		_ = json.NewEncoder(w).Encode(map[string]any{})
	case strings.HasSuffix(r.URL.Path, "accounts:sendOobCode"):
		who := str("email")
		if a := f.byToken(str("idToken")); a != nil {
			who = a.email
		}
		if str("requestType") == "PASSWORD_RESET" && f.accounts[who] == nil {
			f.fail(w, "EMAIL_NOT_FOUND")
			return
		}
		f.sent = append(f.sent, str("requestType")+":"+who)
		_ = json.NewEncoder(w).Encode(map[string]any{"email": who})
	case strings.HasSuffix(r.URL.Path, "accounts:resetPassword"):
		for _, a := range f.accounts {
			if str("oobCode") == "reset-"+a.uid {
				a.password = str("newPassword")
				_ = json.NewEncoder(w).Encode(map[string]any{"email": a.email})
				return
			}
		}
		f.fail(w, "INVALID_OOB_CODE")
	case strings.HasSuffix(r.URL.Path, "accounts:createAuthUri"):
		if !f.brokered {
			f.fail(w, "OPERATION_NOT_ALLOWED")
			return
		}
		n := len(f.sent) + 1
		f.sent = append(f.sent, "AUTH_URI")
		_ = json.NewEncoder(w).Encode(map[string]any{"authUri": fmt.Sprintf("https://accounts.google.com/o/oauth2/auth?state=fbstate-%d&client_id=firebase", n), "sessionId": fmt.Sprintf("fbsession-%d", n)})
	case strings.HasSuffix(r.URL.Path, "accounts:signInWithIdp"):
		if f.idpDown {
			f.fail(w, "OPERATION_NOT_ALLOWED")
			return
		}
		form, _ := url.ParseQuery(str("postBody"))
		email, name := f.brokeredEmail, ""
		if raw := form.Get("id_token"); raw != "" {
			f.idpTokens = append(f.idpTokens, raw)
			f.idpNonces = append(f.idpNonces, form.Get("nonce"))
			payload, _ := base64.RawURLEncoding.DecodeString(strings.Split(raw, ".")[1])
			var c map[string]any
			_ = json.Unmarshal(payload, &c)
			email, _ = c["email"].(string)
			name, _ = c["name"].(string)
		} else if !strings.HasPrefix(str("sessionId"), "fbsession-") || form.Get("code") == "" {
			f.fail(w, "INVALID_IDP_RESPONSE")
			return
		}
		email = strings.ToLower(email)
		a := f.accounts[email]
		if a == nil {
			a = &fbAccount{uid: "uid-" + uuid.NewString()[:8], email: email, name: name}
			f.accounts[email] = a
		}
		a.verified = true // the provider vouched for the address
		login(a)
	default:
		f.fail(w, "UNKNOWN")
	}
}

// verify marks an address confirmed, as following Firebase's own link would.
func (f *fakeFirebase) verify(email string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.accounts[email].verified = true
}

// capture is a mailer that remembers what it was asked to send.
type capture struct {
	mu     sync.Mutex
	links  []string
	to     []string
	codes  []string // sign-in codes asked for, with who they went to in codeTo
	codeTo []string
	fail   bool
}

func (c *capture) sendConfirmation(_ context.Context, to, _ string, link string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fail {
		return fmt.Errorf("down")
	}
	c.to, c.links = append(c.to, to), append(c.links, link)
	return nil
}
func (c *capture) sendCode(_ context.Context, to, code string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fail {
		return fmt.Errorf("down")
	}
	c.codeTo, c.codes = append(c.codeTo, to), append(c.codes, code)
	return nil
}

// world is the service under test with its stand-ins.
type world struct {
	t    *testing.T
	s    *server
	h    http.Handler
	fb   *fakeFirebase
	mail *capture
}

func newWorld(t *testing.T, change ...func(*config)) *world {
	t.Helper()
	fb := newFakeFirebase(t)
	cfg := config{
		port: "0", accessMinutes: 15, refreshDays: 30, publicSignup: true, landingURL: "http://landing.example",
		allowedOrigins: []string{"http://app.example"}, firebaseKey: "test-key", firebaseIdentity: fb.srv.URL, firebaseToken: fb.srv.URL,
	}
	for _, c := range change {
		c(&cfg)
	}
	k, err := generateKeys()
	if err != nil {
		t.Fatal(err)
	}
	s := &server{cfg: cfg, db: testDB(t), keys: k, fb: newFirebase(cfg.firebaseKey, cfg.firebaseIdentity, cfg.firebaseToken)}
	w := &world{t: t, s: s, fb: fb, mail: &capture{}}
	w.h = s.handler()
	t.Cleanup(func() { clock = time.Now })
	return w
}

// withMail turns on the notification service stand-in.
func (w *world) withMail() { w.s.mail = w.mail }

type answer struct {
	status int
	body   map[string]any
	header http.Header
}

func (w *world) call(method, path string, body any, token string) answer {
	w.t.Helper()
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	w.h.ServeHTTP(rec, req)
	out := map[string]any{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return answer{status: rec.Code, body: out, header: rec.Header()}
}

func (a answer) str(key string) string { s, _ := a.body[key].(string); return s }
func (a answer) access() string        { return a.str("access_token") }
func (a answer) refresh() string       { return a.str("refresh_token") }

const goodPassword = "A long enough password1!"

// signUp makes an account through the API.
func (w *world) signUp(email string) answer {
	w.t.Helper()
	a := w.call("POST", "/v1/accounts", map[string]any{"name": "Sami", "email": email, "password": goodPassword}, "")
	if a.status != http.StatusCreated {
		w.t.Fatalf("sign up %s: %d %v", email, a.status, a.body)
	}
	return a
}

// count runs a SELECT COUNT(*) and returns it.
func (w *world) count(sql string, args ...any) int {
	w.t.Helper()
	var n int
	if err := w.s.db.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		w.t.Fatal(err)
	}
	return n
}
