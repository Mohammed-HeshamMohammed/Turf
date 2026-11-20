package main

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

var dialerRoute = regexp.MustCompile(`"((?:GET|POST|PUT|PATCH|DELETE) /api/[^"]*)"`)

// Step 43, D305: signed in to another agency, every route of the dialer, given every id of the first agency's calls and texts, shows
// none of them and changes none of them.
func TestNoDialerRouteReachesAnotherAgency(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	lead := e.addLead("+15125556666")
	e.simCall("/sim/inbound-sms", map[string]any{"from": "+15125556666", "to": e.number, "text": "Isolation text body"})
	e.sim.drain()
	if status, out := e.call("POST", "/api/v1/calls", map[string]any{"lead_id": lead}); status != 200 {
		t.Fatalf("a call in agency A: %d %v", status, out)
	}
	var ids []string
	rows, _ := e.s.st.db.Query(ctx, `SELECT id::text FROM sms_messages WHERE org_id = $1 UNION SELECT id::text FROM calls WHERE org_id = $1`, e.org)
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	ids = append(ids, lead)
	if len(ids) < 3 {
		t.Fatalf("agency A has %d ids", len(ids))
	}
	// Agency B: another workspace with its own owner, who may do everything there.
	rules := e.s.rules.(*fakeRules)
	ownerA, orgA := e.user, e.org
	e.user, e.org = newUUID(), newUUID()
	rules.grants[e.user+"|"+e.org] = grantReply{Allowed: true, Scopes: []string{"organization"}, Capabilities: []string{"call", "message", "admin"}, Roles: []string{"owner"}}
	files, _ := filepath.Glob("*.go")
	var routes []string
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, _ := os.ReadFile(f)
		for _, m := range dialerRoute.FindAllStringSubmatch(string(src), -1) {
			if !slices.Contains(routes, m[1]) {
				routes = append(routes, m[1])
			}
		}
	}
	if len(routes) < 30 {
		t.Fatalf("only %d routes found", len(routes))
	}
	secrets := []string{"Isolation text body", "5125556666", "555-6666"}
	param := regexp.MustCompile(`\{[^}]+\}`)
	for _, route := range routes {
		method, path, _ := strings.Cut(route, " ")
		tries := []string{path}
		if param.MatchString(path) {
			tries = tries[:0]
			for _, id := range ids {
				tries = append(tries, param.ReplaceAllString(path, id))
			}
		}
		for _, p := range tries {
			var body any
			if method != "GET" && method != "DELETE" {
				body = map[string]any{}
			}
			_, out := e.call(method, p, body)
			text := strings.ToLower(strings.Join(flatten(out), " "))
			for _, s := range secrets {
				if strings.Contains(text, strings.ToLower(s)) {
					t.Errorf("%s %s as agency B shows %q", method, p, s)
				}
			}
			for _, id := range ids {
				if strings.Contains(text, id) && !strings.Contains(p, id) {
					t.Errorf("%s %s as agency B shows agency A's id %s", method, p, id)
				}
			}
		}
	}
	// The control: agency A's owner does see the text, so a leak would be seen.
	e.user, e.org = ownerA, orgA
	if _, out := e.call("GET", "/api/v1/sms/threads/"+lead, nil); !strings.Contains(strings.Join(flatten(out), " "), "Isolation text body") {
		t.Fatalf("the control: agency A does not see its own text: %v", out)
	}
	var calls, texts int
	_ = e.s.st.db.QueryRow(ctx, `SELECT count(*) FROM calls WHERE org_id = $1`, orgA).Scan(&calls)
	_ = e.s.st.db.QueryRow(ctx, `SELECT count(*) FROM sms_messages WHERE org_id = $1`, orgA).Scan(&texts)
	if calls < 1 || texts < 1 {
		t.Fatalf("agency A's calls %d texts %d", calls, texts)
	}
}

// flatten is every string in a JSON answer.
func flatten(v any) []string {
	switch x := v.(type) {
	case string:
		return []string{x}
	case map[string]any:
		var out []string
		for k, y := range x {
			out = append(out, k)
			out = append(out, flatten(y)...)
		}
		return out
	case []any:
		var out []string
		for _, y := range x {
			out = append(out, flatten(y)...)
		}
		return out
	}
	return nil
}
