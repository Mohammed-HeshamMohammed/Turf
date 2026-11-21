package crm

import (
	"context"
	"testing"
	"time"
)

// Step 12: a person who left or is suspended keeps their leads where their team's leads hold them, until someone hands them on: to
// one person, or back to the team's unassigned leads, team by team. A suspended person who returns finds what was not handed on.
func TestHandingOnTheWorkOfSomeoneWhoLeft(t *testing.T) {
	e := newEnv(t)
	e.seed()
	const teamT, teamU = "aaaaaaaa-0000-4000-8000-0000000000e1", "aaaaaaaa-0000-4000-8000-0000000000e2"
	const dave, erin, gone = "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "77777777-7777-4777-8777-777777777777"
	e.rules.mu.Lock()
	// "gone" left the agency: not in the roster any more. Erin is suspended.
	at := time.Now().Unix()
	e.rules.roster[orgA] = []member{{UserID: alice, Roles: []string{"owner"}}, {UserID: bob, Roles: []string{"caller"}, TeamIDs: []string{teamT}},
		{UserID: dave, Roles: []string{"manager"}}, {UserID: erin, Roles: []string{"caller"}, TeamIDs: []string{teamT}, SuspendedAt: &at}}
	e.rules.teamList = map[string][]authzTeam{orgA: {{TeamID: teamT, Name: "T", ManagerID: dave}, {TeamID: teamU, Name: "U"}}}
	e.rules.grants[dave+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"team", "own"}, TeamIDs: []string{teamT}, TeamScopeIDs: []string{teamT}, ManagedTeamIDs: []string{teamT}, Capabilities: []string{"edit", "assign", "call"}, Roles: []string{"manager"}}
	e.rules.grants[bob+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"own"}, TeamIDs: []string{teamT}, Capabilities: []string{"edit", "call"}, Roles: []string{"caller"}}
	e.rules.people_[dave] = peopleReply{UserID: dave, Workspaces: []workspaceRoles{{OrgID: orgA, Roles: []string{"manager"}}}}
	e.rules.mu.Unlock()
	ctx := context.Background()
	e.call(alice, orgA, "GET", "/api/v1/admin/teams", nil) // the CRM copies the team tree
	lead := func(owner, team string) string {
		t.Helper()
		id := newID(t)
		e.want(e.opWith(alice, orgA, "lead.create", map[string]any{"id": id, "name": "Lead " + id[:4]}, newID(t)), "applied")
		if _, err := e.admin.Exec(ctx, `UPDATE crm.leads SET assignee_id = $2, team_id = nullif($3, '')::uuid WHERE id = $1`, id, owner, team); err != nil {
			t.Fatal(err)
		}
		return id
	}
	t1, t2, u1, erinLead := lead(gone, teamT), lead(gone, teamT), lead(gone, teamU), lead(erin, teamT)
	if _, err := e.admin.Exec(ctx, `INSERT INTO crm.tasks (org_id, lead_id, assignee_id, title, due_at) VALUES ($1, $2, $3, 'Call back', now() + interval '1 day')`, orgA, t1, gone); err != nil {
		t.Fatal(err)
	}
	waiting := func(user string) map[string]map[string]any {
		_, out := e.call(user, orgA, "GET", "/api/v1/handon", nil)
		seen := map[string]map[string]any{}
		people, _ := out["people"].([]any)
		for _, raw := range people {
			p := raw.(map[string]any)
			seen[p["user_id"].(string)] = p
		}
		return seen
	}
	// The owner sees everyone's waiting work; the team's lead sees their team's; a caller sees nothing.
	all := waiting(alice)
	if all[gone]["leads"] != 3.0 || all[gone]["why"] != "left" || all[erin]["why"] != "suspended" {
		t.Fatalf("the owner's list: %v", all)
	}
	if mine := waiting(dave); mine[gone]["leads"] != 2.0 {
		t.Fatalf("the team lead sees their team's part: %v", mine)
	}
	if status, _ := e.call(bob, orgA, "GET", "/api/v1/handon", nil); status != 403 {
		t.Fatalf("a caller sees waiting work: %d", status)
	}
	// Meanwhile the team's lead holds the leads and can work them.
	e.want(e.op(dave, orgA, "lead.update", map[string]any{"id": t1, "changes": map[string]any{"stage": "Contacted"}}), "applied")

	// The team lead hands team T's part to Bob; the callback goes with its lead, due time kept.
	if status, _ := e.call(dave, orgA, "POST", "/api/v1/handon/"+gone, map[string]any{"to": bob, "team_id": teamU}); status != 403 {
		t.Fatalf("a team lead hands on another team's work: %d", status)
	}
	if status, _ := e.call(dave, orgA, "POST", "/api/v1/handon/"+bob, map[string]any{"to": dave}); status != 400 {
		t.Fatalf("handing on someone still working: %d", status)
	}
	if status, out := e.call(dave, orgA, "POST", "/api/v1/handon/"+gone, map[string]any{"to": bob}); status != 200 || out["leads"] != 2.0 || out["tasks"] != 1.0 {
		t.Fatalf("the team's part to Bob: %d %v", status, out)
	}
	owner := func(id string) string {
		var who *string
		if err := e.admin.QueryRow(ctx, `SELECT assignee_id::text FROM crm.leads WHERE id = $1`, id).Scan(&who); err != nil {
			t.Fatal(err)
		}
		if who == nil {
			return ""
		}
		return *who
	}
	if owner(t1) != bob || owner(t2) != bob || owner(u1) != gone {
		t.Fatalf("team T's leads went to Bob, team U's stayed: %s %s %s", owner(t1), owner(t2), owner(u1))
	}
	var taskOwner string
	var due time.Time
	if err := e.admin.QueryRow(ctx, `SELECT assignee_id::text, due_at FROM crm.tasks WHERE lead_id = $1`, t1).Scan(&taskOwner, &due); err != nil || taskOwner != bob || due.Before(time.Now()) {
		t.Fatalf("the callback followed its lead with its due time: %s %v %v", taskOwner, due, err)
	}
	// The owner sends the rest back to the team's unassigned leads.
	if status, out := e.call(alice, orgA, "POST", "/api/v1/handon/"+gone, map[string]any{}); status != 200 || out["leads"] != 1.0 {
		t.Fatalf("the rest to the team's pool: %d %v", status, out)
	}
	if owner(u1) != "" {
		t.Fatalf("unassigned in its team: %s", owner(u1))
	}
	// A suspended person's lead not handed on is still theirs when they return.
	if owner(erinLead) != erin {
		t.Fatal("nothing moves on suspension by itself")
	}
}
