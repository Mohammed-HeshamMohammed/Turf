package telnyx

import (
	"bytes"
	"callerwhale/authverify/authverifytest"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// The database tests need a disposable PostgreSQL: DIALER_TEST_DATABASE_URL. Each test drops and remakes the dialer_sms
// schema. Without it they are skipped.

type fakeRules struct{ grants map[string]grantReply }

func (f *fakeRules) grant(_ context.Context, user, org string, _ bool) (grantReply, error) {
	if g, ok := f.grants[user+"|"+org]; ok {
		return g, nil
	}
	return grantReply{Code: "not_member", Reason: "You are not in this workspace."}, nil
}

// fakeCRM stands in for crm-core's /internal/v1/dialer routes: leads to call, and the call log, one entry per operation id.
type fakeCRM struct {
	mu         sync.Mutex
	ranks      map[string]string // user|lead -> rank toward the lead's thread
	leads      map[string]*leadInfo
	logged     map[string]map[string]any // operation id -> payload
	reports    int                       // every recordCall, repeats included
	recordings map[string]map[string]any
	blocks     map[string]map[string]any // phone -> the last block asked for (step 25)
	carriers   map[string]map[string]any // org -> the last carrier standing told (step 39)
	toErase    []erasure                 // numbers to erase after a data request (step 44), and the ids done
	erased     []string
	clearedAt  *time.Time
}

func (f *fakeCRM) erasures(context.Context) ([]erasure, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]erasure{}, f.toErase...), nil
}

func (f *fakeCRM) erasureDone(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.erased = append(f.erased, id)
	f.toErase = nil
	return nil
}

func (f *fakeCRM) carrier(_ context.Context, org string, standing map[string]any) (carrierReply, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.carriers == nil {
		f.carriers = map[string]map[string]any{}
	}
	f.carriers[org] = standing
	return carrierReply{ClearedAt: f.clearedAt, ClearNote: "Reviewed"}, nil
}

func (f *fakeCRM) block(_ context.Context, _, _, phone, lead string, payload map[string]any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.blocks == nil {
		f.blocks = map[string]map[string]any{}
	}
	if payload["lift"] == true {
		delete(f.blocks, e164(phone))
		return nil
	}
	f.blocks[e164(phone)] = payload
	return nil
}

func (f *fakeCRM) lead(_ context.Context, _, user, id string) (leadInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	l := f.leads[id]
	if l == nil {
		return leadInfo{}, errCRMRefused{"The lead was not found"}
	}
	out := *l
	// Each person's rank toward the lead's thread (step 10), as the CRM would answer it.
	out.Rank = f.ranks[user+"|"+id]
	b := f.blocks[e164(l.Phone)]
	out.BlockedCalls, out.BlockedTexts = l.DoNotCall || b["calls"] == true, l.DoNotCall || b["texts"] == true
	out.Found, out.MayCall = true, !out.BlockedCalls
	if out.BlockedCalls || out.BlockedTexts {
		out.Reason, out.BlockReason = "This lead is do-not-call.", "This number asked this agency to stop."
	}
	return out, nil
}

func (f *fakeCRM) findLead(_ context.Context, _, _, phone string) (leadInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, l := range f.leads {
		if e164(l.Phone) == e164(phone) {
			out := *l
			out.Found = true
			return out, nil
		}
	}
	return leadInfo{}, nil
}

func (f *fakeCRM) recordCall(_ context.Context, _, _, id string, payload map[string]any) (opAnswer, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reports++
	if _, ok := f.logged[id]; ok {
		return opAnswer{ID: id, Status: "duplicate"}, nil
	}
	l := f.leads[payload["lead_id"].(string)]
	if l != nil && l.DoNotCall {
		return opAnswer{ID: id, Status: "rejected", Message: "This lead is do-not-call; calls cannot be logged"}, nil
	}
	f.logged[id] = payload
	if l != nil && payload["outcome"] == "Do not call" {
		l.DoNotCall = true
	}
	return opAnswer{ID: id, Status: "applied"}, nil
}

func (f *fakeCRM) addRecording(_ context.Context, _, _, id string, payload map[string]any) (opAnswer, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.recordings[id] = payload
	return opAnswer{ID: id, Status: "applied"}, nil
}

type env struct {
	t      *testing.T
	s      *server
	ts     *httptest.Server
	sim    *simulator
	crm    *fakeCRM
	fx     authverifytest.Fixture
	clock  time.Time
	clockM sync.Mutex
	org    string
	user   string
	number string
}

func (e *env) now() time.Time {
	e.clockM.Lock()
	defer e.clockM.Unlock()
	return e.clock
}

func (e *env) advance(d time.Duration) {
	e.clockM.Lock()
	e.clock = e.clock.Add(d)
	e.clockM.Unlock()
}

func newEnv(t *testing.T) *env {
	t.Helper()
	url := os.Getenv("DIALER_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set DIALER_TEST_DATABASE_URL to run the database tests")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, `DROP SCHEMA IF EXISTS dialer_sms CASCADE`); err != nil {
		t.Fatal(err)
	}
	conn.Close(ctx)
	st, err := openStore(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.close)
	// A weekday afternoon in UTC: leads are called and texted only in the day (step 21).
	now := time.Now().UTC()
	e := &env{t: t, clock: time.Date(now.Year(), now.Month(), now.Day(), 15, 0, 0, 0, time.UTC), org: newUUID(), user: newUUID(), number: "+15125550100",
		crm: &fakeCRM{leads: map[string]*leadInfo{}, logged: map[string]map[string]any{}, recordings: map[string]map[string]any{}}}
	e.fx = authverifytest.NewFixture(t)
	jwks := e.fx.JWKS("k1")
	rules := &fakeRules{grants: map[string]grantReply{e.user + "|" + e.org: {Allowed: true, Scopes: []string{"organization"}, Capabilities: []string{"call", "message", "admin"}}}}
	var h http.Handler
	e.ts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.ServeHTTP(w, r) }))
	t.Cleanup(e.ts.Close)
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	cfg := config{simulate: true, amdMode: "detect", ringSeconds: 30, settleDelay: 5 * time.Second, wrapup: 10 * time.Minute, noTimers: true, apiKey: "sim-key", fromNumber: e.number}
	e.sim = newSimulator(key, "sim-key", e.ts.URL+"/webhooks/telnyx", 0)
	e.sim.now = e.now
	e.s = &server{cfg: cfg, st: st, keys: authverifytest.ServeKeys(t, &jwks, nil), rules: rules, crm: e.crm, sim: e.sim, now: e.now,
		webhookKey: key.Public().(ed25519.PublicKey),
		carrier:    &telnyx{base: e.ts.URL + "/telnyx-sim/v2", key: "sim-key", connectionID: "sim-connection", simulate: true, http: &http.Client{Timeout: 10 * time.Second}}}
	e.s.reg = e.s.carrier.(*telnyx)
	h = e.s.handler()
	if status, out := e.call("PUT", "/api/v1/numbers/"+e.number, map[string]any{"user_id": e.user}); status != 200 {
		t.Fatalf("number: %d %v", status, out)
	}
	return e
}

func (e *env) addLead(phone string) string {
	id := newUUID()
	e.crm.mu.Lock()
	e.crm.leads[id] = &leadInfo{LeadID: id, Name: "Lead " + phone, Phone: phone}
	e.crm.mu.Unlock()
	return id
}

func (e *env) call(method, path string, body any) (int, map[string]any) {
	e.t.Helper()
	var reader io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.ts.URL+path, reader)
	req.Header.Set("Authorization", "Bearer "+e.fx.Sign("k1", "EdDSA", func(m map[string]any) {
		m["sub"], m["iat"], m["exp"] = e.user, e.now().Unix(), e.now().Add(time.Hour).Unix()
	}))
	req.Header.Set("x-callerwhale-org", e.org)
	return e.send(req)
}

func (e *env) simCall(path string, body any) (int, map[string]any) {
	e.t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", e.ts.URL+"/telnyx-sim"+path, bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer sim-key")
	return e.send(req)
}

func (e *env) send(req *http.Request) (int, map[string]any) {
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func (e *env) loadCall(id string) *callRow {
	e.t.Helper()
	c, err := e.s.loadCall(context.Background(), nil, `id = $1`, id)
	if err != nil || c == nil {
		e.t.Fatalf("call %s: %v", id, err)
	}
	return c
}

// settle lets the settle delay pass and settles what is due, as the periodic sweep does.
func (e *env) settle() {
	e.advance(e.s.cfg.settleDelay + time.Second)
	e.s.settleDue(context.Background())
}
