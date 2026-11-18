package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
)

const flowOrg = "66666666-6666-4666-8666-666666666666"
const flowTeam = "77777777-7777-4777-8777-777777777777"

// fakeWorkspaceAuthz is authz for one workspace called Blue Door Homes, owned by owner(): it allows every invitation and records
// who joined.
type fakeWorkspaceAuthz struct {
	mu     sync.Mutex
	owner  string
	joined map[string]bool
	named  bool // false: authz has no name for the workspace yet
	// goneTeam is a team that was deleted: inviting into it is refused, as authz refuses a team not in the workspace.
	goneTeam string
	// Step 3: the roles each member was given, each team's leads, and whether every seat is taken.
	roles     map[string][]string
	leads     map[string][]string
	seatsFull bool
	// Step 13: Caller Whale staff (platform owner), and whether the agency is paused.
	staff  string
	paused bool
}

func (f *fakeWorkspaceAuthz) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/v1/people/"):
		user := strings.TrimPrefix(r.URL.Path, "/v1/people/")
		spaces := []map[string]any{}
		if user == f.owner {
			spaces = append(spaces, map[string]any{"org_id": flowOrg, "roles": []string{"owner"}, "business_owner": true})
		} else if f.joined[user] {
			roles := f.roles[user]
			if len(roles) == 0 {
				roles = []string{"caller"}
			}
			spaces = append(spaces, map[string]any{"org_id": flowOrg, "roles": roles})
		}
		platform := ""
		if user == f.staff {
			platform = "owner"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"user_id": user, "platform_role": platform, "workspaces": spaces})
	case r.Method == "GET" && r.URL.Path == "/v1/orgs/"+flowOrg+"/members":
		members := []map[string]any{{"user_id": f.owner, "roles": []string{"owner"}, "team_ids": []string{}}}
		for user := range f.joined {
			roles := f.roles[user]
			if len(roles) == 0 {
				roles = []string{"caller"}
			}
			members = append(members, map[string]any{"user_id": user, "roles": roles, "team_ids": []string{flowTeam}})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"members": members, "teams": []any{}})
	case r.Method == "PUT" && r.URL.Path == "/v1/orgs/"+flowOrg+"/owner/handover":
		var body struct {
			From     string   `json:"from"`
			To       string   `json:"to"`
			OldRoles []string `json:"old_roles"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.From != f.owner {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":"That person does not own this agency.","code":"not_owner"}`))
			return
		}
		if f.roles == nil {
			f.roles = map[string][]string{}
		}
		delete(f.joined, body.To)
		f.owner, f.paused = body.To, false
		if len(body.OldRoles) > 0 {
			f.joined[body.From], f.roles[body.From] = true, body.OldRoles
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	case r.Method == "PUT" && r.URL.Path == "/v1/orgs/"+flowOrg+"/standing":
		var body struct {
			Paused *bool `json:"paused"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Paused != nil {
			f.paused = *body.Paused
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	case r.Method == "GET" && r.URL.Path == "/v1/orgs/"+flowOrg+"/roles":
		_, _ = w.Write([]byte(`{"roles":[{"key":"caller","assignable":true},{"key":"closer","assignable":true},{"key":"manager","assignable":true}]}`))
	case r.Method == "POST" && r.URL.Path == "/v1/orgs/"+flowOrg+"/relations/check":
		var asked struct {
			TeamID string `json:"team_id"`
		}
		_ = json.NewDecoder(r.Body).Decode(&asked)
		if f.seatsFull {
			_, _ = w.Write([]byte(`{"allowed":false,"code":"seats_full","reason":"Every seat on this plan is taken."}`))
			return
		}
		if f.goneTeam != "" && asked.TeamID == f.goneTeam {
			_, _ = w.Write([]byte(`{"allowed":false,"code":"bad_request","reason":"That team is not in this workspace."}`))
			return
		}
		_, _ = w.Write([]byte(`{"allowed":true}`))
	case r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, "/v1/orgs/"+flowOrg+"/members/"),
		r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/suspend"):
		_, _ = w.Write([]byte(`{"ok":true}`))
	case r.Method == "GET" && r.URL.Path == "/v1/orgs/"+flowOrg:
		name := ""
		if f.named {
			name = "Blue Door Homes"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"org_id": flowOrg, "owner_id": f.owner, "name": name})
	case r.Method == "PUT" && strings.HasPrefix(r.URL.Path, "/v1/orgs/"+flowOrg+"/members/"):
		user := strings.TrimPrefix(r.URL.Path, "/v1/orgs/"+flowOrg+"/members/")
		var body struct {
			Roles []string `json:"roles"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.joined[user] = true
		if f.roles == nil {
			f.roles = map[string][]string{}
		}
		f.roles[user] = body.Roles
		_, _ = w.Write([]byte(`{"ok":true}`))
	case r.Method == "GET" && r.URL.Path == "/v1/orgs/"+flowOrg+"/people-log":
		viewer := r.URL.Query().Get("viewer")
		_ = json.NewEncoder(w).Encode(map[string]any{"view": "mine", "entries": []map[string]any{{"id": 1, "at": 1, "actor_id": f.owner, "target_id": viewer, "action": "suspended", "detail": map[string]any{"reason": "On leave"}, "team_ids": []string{}}}})
	case r.Method == "GET" && r.URL.Path == "/v1/orgs/"+flowOrg+"/teams":
		teams := []map[string]any{}
		for _, id := range []string{flowTeam, goneTeam} {
			leads := f.leads[id]
			if leads == nil {
				leads = []string{}
			}
			first := ""
			if len(leads) > 0 {
				first = leads[0]
			}
			teams = append(teams, map[string]any{"team_id": id, "name": "Team " + id[:4], "manager_id": first, "manager_ids": leads, "deputy_ids": []string{}})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"teams": teams})
	case r.Method == "PUT" && strings.HasPrefix(r.URL.Path, "/v1/orgs/"+flowOrg+"/teams/"):
		id := strings.TrimPrefix(r.URL.Path, "/v1/orgs/"+flowOrg+"/teams/")
		var body struct {
			Name       string   `json:"name"`
			ManagerIDs []string `json:"manager_ids"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if f.leads == nil {
			f.leads = map[string][]string{}
		}
		f.leads[id] = body.ManagerIDs
		first := ""
		if len(body.ManagerIDs) > 0 {
			first = body.ManagerIDs[0]
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"team": map[string]any{"team_id": id, "name": body.Name, "manager_id": first, "manager_ids": body.ManagerIDs}})
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"not here","code":"not_found"}`))
	}
}

func (w *world) idOf(email string) string {
	w.t.Helper()
	var id string
	if err := w.s.db.QueryRow(w.t.Context(), "SELECT id FROM users WHERE email=$1", email).Scan(&id); err != nil {
		w.t.Fatal(err)
	}
	return id
}

func TestAnInvitationSaysWhereItComesFromAndWhyItCannotBeUsed(t *testing.T) {
	fake := &fakeWorkspaceAuthz{joined: map[string]bool{}, named: true}
	authz := httptest.NewServer(http.HandlerFunc(fake.serve))
	defer authz.Close()
	w := newWorld(t, func(c *config) { c.authzURL = authz.URL; c.authzToken = "token" })
	owner := w.confirmed("owner@example.com").access()
	fake.mu.Lock()
	fake.owner = w.idOf("owner@example.com")
	fake.mu.Unlock()

	invite := func(email string) answer {
		t.Helper()
		a := w.call("POST", "/v1/orgs/"+flowOrg+"/invitations", map[string]any{"email": email, "role": "caller", "team_id": flowTeam}, owner)
		if a.status != http.StatusCreated {
			t.Fatalf("invite %s: %d %v", email, a.status, a.body)
		}
		return a
	}

	// The email names the agency and opens this invitation, not the dashboard in general.
	sent := invite("sami@example.com")
	id := sent.str("id")
	if sent.str("delivery_state") != "sent" || sent.str("link") != "http://landing.example/dashboard?invitation="+id {
		t.Fatalf("sent: %v", sent.body)
	}
	// The email's link is the same with its one-time key (step 15), which only the invited mailbox gets.
	if last := len(w.mail.links) - 1; !strings.HasPrefix(w.mail.links[last], sent.str("link")+"&key=") || w.mail.agencies[len(w.mail.agencies)-1] != "Blue Door Homes" {
		t.Fatalf("the email links to the invitation and names the agency: %v %v", w.mail.links, w.mail.agencies)
	}

	// A failed send is told apart from email being switched off.
	w.mail.fail = true
	if a := invite("fail@example.com"); a.str("delivery_state") != "failed" {
		t.Fatalf("failed send: %v", a.body)
	}
	w.mail.fail = false

	// Someone signed in with another address learns which one, masked, and cannot report or accept it.
	other := w.confirmed("other@example.com").access()
	a := w.call("GET", "/v1/me/invitations/"+id, nil, other)
	if a.status != 403 || a.str("code") != "other_address" || !strings.Contains(a.str("error"), "s•••••@example.com") || strings.Contains(a.str("error"), "sami") {
		t.Fatalf("other address: %d %v", a.status, a.body)
	}
	if a := w.call("POST", "/v1/me/invitations/"+id+"/accept", nil, other); a.status != 403 || a.str("code") != "other_address" {
		t.Fatalf("other address accepts: %d %v", a.status, a.body)
	}
	if a := w.call("POST", "/v1/me/invitations/"+id+"/report", map[string]any{"reason": "x"}, other); a.status != 404 {
		t.Fatalf("other address reports: %d %v", a.status, a.body)
	}

	// An unconfirmed address is told an invitation waits, and nothing more.
	invite("nora@example.com")
	nora := w.signUp("nora@example.com").access()
	a = w.call("GET", "/v1/me/invitations", nil, nora)
	if a.status != 200 || a.body["waiting"] != true || len(a.body["invitations"].([]any)) != 0 {
		t.Fatalf("unconfirmed list: %d %v", a.status, a.body)
	}

	// The invited person sees the agency, its owner, who sent it and when, opens it from the link, reports it, and accepts.
	sami := w.confirmed("sami@example.com").access()
	a = w.call("GET", "/v1/me/invitations", nil, sami)
	items, _ := a.body["invitations"].([]any)
	if a.status != 200 || len(items) != 1 {
		t.Fatalf("list: %d %v", a.status, a.body)
	}
	item := items[0].(map[string]any)
	if item["org_name"] != "Blue Door Homes" || !regexp.MustCompile(`^Sami#[A-HJ-NP-Z2-9]{4}$`).MatchString(item["owner_name"].(string)) || item["inviter_name"] != "Sami" || item["created_at"].(float64) == 0 {
		t.Fatalf("where it comes from: %v", item)
	}
	if a := w.call("GET", "/v1/me/invitations/"+id, nil, sami); a.status != 200 {
		t.Fatalf("open from the link: %d %v", a.status, a.body)
	}
	for range 2 {
		if a := w.call("POST", "/v1/me/invitations/"+id+"/report", map[string]any{"reason": "I do not know them"}, sami); a.status != 200 {
			t.Fatalf("report: %d %v", a.status, a.body)
		}
	}
	if n := w.count("SELECT COUNT(*) FROM invitation_reports WHERE invitation_id=$1", id); n != 1 {
		t.Fatalf("one report per person: %d", n)
	}
	if a := w.call("GET", "/v1/admin/invitation-reports", nil, owner); a.status != 403 {
		t.Fatalf("an agency owner does not read staff reports: %d", a.status)
	}
	a = w.call("POST", "/v1/me/invitations/"+id+"/accept", nil, sami)
	if a.status != 200 || a.str("org_id") != flowOrg {
		t.Fatalf("accept names the agency joined: %d %v", a.status, a.body)
	}
	if a := w.call("GET", "/v1/me/invitations/"+id, nil, sami); a.status != 409 || a.str("code") != "accepted" {
		t.Fatalf("accepted already: %d %v", a.status, a.body)
	}

	// A withdrawn invitation says it was cancelled.
	lina := invite("lina@example.com").str("id")
	if a := w.call("DELETE", "/v1/invitations/"+lina, nil, owner); a.status != 200 {
		t.Fatalf("withdraw: %d %v", a.status, a.body)
	}
	linaToken := w.confirmed("lina@example.com").access()
	if a := w.call("GET", "/v1/me/invitations/"+lina, nil, linaToken); a.status != 410 || a.str("code") != "cancelled" {
		t.Fatalf("cancelled: %d %v", a.status, a.body)
	}

	// An agency authz has no name for yet is called after its owner.
	fake.mu.Lock()
	fake.named = false
	fake.mu.Unlock()
	invite("kai@example.com")
	kai := w.confirmed("kai@example.com").access()
	a = w.call("GET", "/v1/me/invitations", nil, kai)
	if items := a.body["invitations"].([]any); len(items) != 1 || items[0].(map[string]any)["org_name"] != "Sami's workspace" {
		t.Fatalf("unnamed agency: %v", a.body)
	}
}

func TestMaskEmailShowsTheFirstLetterAndTheDomain(t *testing.T) {
	for in, want := range map[string]string{"mo@gmail.com": "m•••••@gmail.com", "a@b.co": "a•••••@b.co", "émile@x.fr": "é•••••@x.fr", "broken": "•••••"} {
		if got := maskEmail(in); got != want {
			t.Fatalf("maskEmail(%q) = %q, want %q", in, got, want)
		}
	}
}
