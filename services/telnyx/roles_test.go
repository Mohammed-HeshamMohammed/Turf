package telnyx

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func TestEachContainerAnswersOnlyItsOwnRoutes(t *testing.T) {
	cases := map[role][]string{
		rolePhoneAPI:      {"/api/v1/calls", "/api/v1/calls/x/hangup", "/api/v1/numbers/+1", "/api/v1/budgets", "/api/v1/status", "/telnyx-sim/v2/calls"},
		roleSMSAPI:        {"/api/v1/sms", "/api/v1/sms/threads/x", "/telnyx-sim/v2/messages"},
		rolePhoneWebhooks: {"/webhooks/telnyx"},
		roleSMSWebhooks:   {"/webhooks/telnyx"},
		rolePhoneJobs:     {},
		roleSMSJobs:       {},
	}
	all := []string{"/api/v1/calls", "/api/v1/sms", "/webhooks/telnyx", "/api/v1/numbers/+1", "/telnyx-sim/v2/calls", "/api/v1/smsx"}
	for r, own := range cases {
		for _, p := range []string{"/healthz", "/version", "/status"} {
			if !r.serves(p) {
				t.Fatalf("%s does not answer %s", r, p)
			}
		}
		for _, p := range all {
			want := slices.Contains(own, p) || (p == "/api/v1/numbers/+1" && r == rolePhoneAPI) || (p == "/telnyx-sim/v2/calls" && r.hostsSimulator())
			if got := r.serves(p); got != want {
				t.Fatalf("%s serves %s: %v, want %v", r, p, got, want)
			}
		}
	}
	for _, p := range all {
		if !roleAll.serves(p) {
			t.Fatalf("every part in one does not serve %s", p)
		}
	}
	// A path the container does not serve gets a 404 that names it, before any route runs.
	h := roleFilter(roleSMSAPI, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(299) }))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/v1/calls", nil))
	if rec.Code != 404 || !strings.Contains(rec.Body.String(), "telnyx-sms-api") {
		t.Fatalf("calls on the texts API: %d %s", rec.Code, rec.Body)
	}
}

func TestEachContainerHasItsOwnPortAndTimedWork(t *testing.T) {
	ports := map[string]bool{}
	for _, r := range roles[1:] {
		if ports[r.defaultPort()] {
			t.Fatalf("%s shares port %s", r, r.defaultPort())
		}
		ports[r.defaultPort()] = true
	}
	if roleAll.defaultPort() != "8113" || rolePhoneAPI.defaultPort() != "8113" {
		t.Fatal("the calls API keeps 8113")
	}
	// Every timed task runs in exactly one split container, and all of them in the one program.
	seen := map[string]role{}
	for _, r := range roles[1:] {
		for _, l := range r.loops() {
			if other, dup := seen[l]; dup {
				t.Fatalf("%s runs in %s and %s", l, other, r)
			}
			seen[l] = r
		}
	}
	if len(seen) != len(roleAll.loops()) {
		t.Fatalf("split containers run %v, the one program %v", seen, roleAll.loops())
	}
	for _, l := range []string{"settle", "callbacks", "erasures"} {
		if seen[l] != rolePhoneJobs {
			t.Fatalf("%s runs in %s", l, seen[l])
		}
	}
	for _, l := range []string{"scheduled_texts", "unanswered_texts", "carrier"} {
		if seen[l] != roleSMSJobs {
			t.Fatalf("%s runs in %s", l, seen[l])
		}
	}
}

func TestSplitContainersInSimulateModeShareOneSimulatorPerSide(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	_, _ = rand.Read(seed)
	env := map[string]string{"DATABASE_URL": "postgres://x", "AUTH_JWKS_URL": "http://auth/jwks", "AUTHZ_URL": "http://authz", "CRM_URL": "http://crm",
		"AUTHZ_TOKEN": strings.Repeat("a", 32), "CRM_TOKEN": strings.Repeat("b", 32)}
	get := func(k string) string { return env[k] }
	if _, err := loadConfigFor(rolePhoneJobs, get); err == nil {
		t.Fatal("a split container started in simulate mode without the shared simulator key")
	}
	env["TELNYX_SIM_PRIVATE_KEY"], env["TELNYX_API_KEY"] = base64.StdEncoding.EncodeToString(seed), "sim-key"
	want := base64.StdEncoding.EncodeToString(ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey))
	for r, sim := range map[role]string{rolePhoneWebhooks: "http://telnyx-phone-api:8113/telnyx-sim/v2", rolePhoneJobs: "http://telnyx-phone-api:8113/telnyx-sim/v2",
		roleSMSWebhooks: "http://telnyx-sms-api:8124/telnyx-sim/v2", roleSMSJobs: "http://telnyx-sms-api:8124/telnyx-sim/v2"} {
		c, err := loadConfigFor(r, get)
		if err != nil || c.apiURL != sim || c.publicKey != want || c.port != r.defaultPort() {
			t.Fatalf("%s: %v api %q key ok %v port %s", r, err, c.apiURL, c.publicKey == want, c.port)
		}
	}
	for r, hook := range map[role]string{rolePhoneAPI: "http://telnyx-phone-webhooks:8122/webhooks/telnyx", roleSMSAPI: "http://telnyx-sms-webhooks:8125/webhooks/telnyx"} {
		c, err := loadConfigFor(r, get)
		if err != nil || c.apiURL != "" || c.simWebhookURL != hook {
			t.Fatalf("%s: %v api %q hook %q", r, err, c.apiURL, c.simWebhookURL)
		}
	}
	// Every part in one still runs as before, with no shared key needed.
	delete(env, "TELNYX_SIM_PRIVATE_KEY")
	if c, err := loadConfig(get); err != nil || c.role != roleAll || c.port != "8113" {
		t.Fatalf("every part in one: %v %+v", err, c.role)
	}
}

// A call played through the split containers: the calls API dials and hosts the simulator, the simulator's webhooks go to a
// separate webhooks container, and the jobs' settling logs it in the CRM. The calls API no longer takes webhooks or texts.
func TestACallPlaysThroughTheSplitContainers(t *testing.T) {
	e := newEnv(t)
	e.s.cfg.role = rolePhoneAPI
	hooks := *e.s
	hooks.cfg.role, hooks.sim = rolePhoneWebhooks, nil
	hts := httptest.NewServer(hooks.handler())
	t.Cleanup(hts.Close)
	e.sim.webhook = hts.URL + "/webhooks/telnyx"

	for _, sc := range catalog {
		if sc.Name != "human_answered" && sc.Name != "voicemail_drop" {
			continue
		}
		lead := e.addLead("(512) 555-" + sc.Suffix)
		c := e.dial(lead, sc)
		if c.ReportState != "reported" || c.Outcome != sc.Expect || e.crm.logged[c.ID] == nil {
			t.Fatalf("%s: %s %s, logged %v", sc.Name, c.ReportState, c.Outcome, e.crm.logged[c.ID] != nil)
		}
	}
	if status, _ := e.call("POST", "/api/v1/sms", map[string]any{"lead_id": e.addLead("+15125552222"), "text": "Hi"}); status != 404 {
		t.Fatalf("texting through the calls API: %d", status)
	}
	res, err := http.Post(e.ts.URL+"/webhooks/telnyx", "application/json", strings.NewReader("{}"))
	if err != nil || res.StatusCode != 404 {
		t.Fatalf("a webhook to the calls API: %v %v", err, res.StatusCode)
	}
	res.Body.Close()
}
