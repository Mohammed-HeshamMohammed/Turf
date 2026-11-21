package crm

import (
	"context"
	"testing"
)

// Step 28, part A: the agency's and a client's stages (D154); a closer's hours inside the range their team's lead allows (D156); the
// team's caller sees free slots and books one, which becomes the closer's appointment task and cannot be taken twice (D155); a won deal
// is credited to the caller who set it and the closer, and its lead leaves the queues (D157, D283).
func TestPipelineBookingAndCredit(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	const teamT, teamU = "aaaaaaaa-0000-4000-8000-0000000000d1", "aaaaaaaa-0000-4000-8000-0000000000d2"
	const dave, carl, erin = "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"
	e.rules.mu.Lock()
	e.rules.teamList = map[string][]authzTeam{orgA: {{TeamID: teamT, Name: "T", ManagerID: dave}, {TeamID: teamU, Name: "U"}}}
	e.rules.roster[orgA] = []member{{UserID: alice, Roles: []string{"owner"}}, {UserID: bob, Roles: []string{"caller"}, TeamIDs: []string{teamT}},
		{UserID: carl, Roles: []string{"closer"}, TeamIDs: []string{teamT}}, {UserID: dave, Roles: []string{"manager"}, TeamIDs: []string{teamT}},
		{UserID: erin, Roles: []string{"caller"}, TeamIDs: []string{teamU}}}
	e.rules.grants[dave+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"team", "own"}, TeamIDs: []string{teamT}, TeamScopeIDs: []string{teamT}, ManagedTeamIDs: []string{teamT}, Capabilities: []string{"edit", "assign", "call"}, Roles: []string{"manager"}}
	e.rules.grants[bob+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"own"}, TeamIDs: []string{teamT}, Capabilities: []string{"edit", "call"}, Roles: []string{"caller"}}
	e.rules.grants[carl+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"own"}, TeamIDs: []string{teamT}, Capabilities: []string{"edit", "call", "finance"}, Roles: []string{"closer"}}
	e.rules.grants[erin+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"own"}, TeamIDs: []string{teamU}, Capabilities: []string{"edit", "call"}, Roles: []string{"caller"}}
	for _, p := range []string{dave, carl, erin} {
		e.rules.people_[p] = peopleReply{UserID: p, Workspaces: []workspaceRoles{{OrgID: orgA, Roles: []string{"caller"}}}}
	}
	e.rules.mu.Unlock()
	e.call(alice, orgA, "GET", "/api/v1/admin/teams", nil)

	// Stages: only the owner or an admin; deals use them.
	if status, _ := e.call(dave, orgA, "PUT", "/api/v1/pipeline", map[string]any{"stages": []string{"Mine"}}); status != 403 {
		t.Fatalf("a team lead sets stages: %d", status)
	}
	if status, out := e.call(alice, orgA, "PUT", "/api/v1/pipeline", map[string]any{"stages": []string{"New offer", "Signed"}}); status != 200 || len(out["stages"].([]any)) != 4 {
		t.Fatalf("stages: %d %v", status, out)
	}
	lead := newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": lead, "name": "Pat", "phone": "512-555-0601"}), "applied")
	if _, err := e.admin.Exec(ctx, `UPDATE crm.leads SET team_id = $2, assignee_id = $3 WHERE id = $1`, lead, teamT, bob); err != nil {
		t.Fatal(err)
	}
	if out := e.op(alice, orgA, "deal.create", map[string]any{"lead_id": lead, "stage": "Qualified"}); out["status"] != "rejected" {
		t.Fatalf("a stage the agency does not use: %v", out)
	}

	// Hours inside the lead's limit.
	if status, _ := e.call(carl, orgA, "PUT", "/api/v1/closers/"+carl+"/limit", map[string]any{"from": "06:00", "until": "22:00"}); status != 403 {
		t.Fatalf("a closer limits their own range: %d", status)
	}
	if status, _ := e.call(dave, orgA, "PUT", "/api/v1/closers/"+carl+"/limit", map[string]any{"from": "09:00", "until": "17:00"}); status != 200 {
		t.Fatalf("the lead limits: %d", status)
	}
	week := func(from, until string) []map[string]any {
		var days []map[string]any
		for d := 0; d < 7; d++ {
			days = append(days, map[string]any{"weekday": d, "from": from, "until": until})
		}
		return days
	}
	if status, _ := e.call(carl, orgA, "PUT", "/api/v1/closers/"+carl+"/hours", map[string]any{"days": week("08:00", "17:00")}); status != 400 {
		t.Fatalf("hours outside the limit: %d", status)
	}
	if status, _ := e.call(carl, orgA, "PUT", "/api/v1/closers/"+carl+"/hours", map[string]any{"days": week("09:00", "17:00")}); status != 200 {
		t.Fatalf("hours: %d", status)
	}

	// Slots and booking.
	if status, _ := e.call(erin, orgA, "GET", "/api/v1/teams/"+teamT+"/slots", nil); status != 403 {
		t.Fatalf("another team's caller sees the slots: %d", status)
	}
	_, slots := e.call(bob, orgA, "GET", "/api/v1/teams/"+teamT+"/slots", nil)
	list := slots["slots"].([]any)
	if len(list) == 0 || slots["closers"].(map[string]any)[carl] == nil && list[0].(map[string]any)["closer_id"] != carl {
		t.Fatalf("slots: %v", slots)
	}
	first := list[0].(map[string]any)
	book := map[string]any{"lead_id": lead, "closer_id": carl, "starts_at": first["starts_at"]}
	status, appt := e.call(bob, orgA, "POST", "/api/v1/appointments", book)
	if status != 200 {
		t.Fatalf("book: %d %v", status, appt)
	}
	if status, _ := e.call(bob, orgA, "POST", "/api/v1/appointments", book); status != 409 {
		t.Fatalf("the same slot twice: %d", status)
	}
	var tasks int
	if err := e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.tasks WHERE assignee_id = $1 AND type = 'Appointment' AND lead_id = $2`, carl, lead).Scan(&tasks); err != nil || tasks != 1 {
		t.Fatalf("the closer's appointment task: %d %v", tasks, err)
	}

	// Credit and the won lead.
	deal := newID(t)
	e.want(e.op(alice, orgA, "deal.create", map[string]any{"id": deal, "lead_id": lead, "fee": 5000}), "applied")
	if _, err := e.admin.Exec(ctx, `UPDATE crm.leads SET assignee_id = $2 WHERE id = $1`, lead, carl); err != nil { // handed to the closer
		t.Fatal(err)
	}
	e.want(e.op(carl, orgA, "deal.update", map[string]any{"id": deal, "changes": map[string]any{"stage": "Closed won"}}), "applied")
	credits := map[string]string{}
	rows, err := e.admin.Query(ctx, `SELECT role, user_id::text FROM crm.deal_credits WHERE deal_id = $1`, deal)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var role, user string
		_ = rows.Scan(&role, &user)
		credits[role] = user
	}
	rows.Close()
	if credits["closer"] != carl || credits["caller"] != bob {
		t.Fatalf("credits: %v", credits)
	}
	var stage, verdict string
	if err := e.admin.QueryRow(ctx, `SELECT stage, verdict FROM crm.leads WHERE id = $1`, lead).Scan(&stage, &verdict); err != nil || stage != "Closed" || verdict != "Won" {
		t.Fatalf("the won lead: %s %s %v", stage, verdict, err)
	}
}
