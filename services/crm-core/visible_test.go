package crm

import (
	"context"
	"fmt"
	"slices"
	"testing"
)

// leadVisible (the condition the snapshot writes out for its bulk queries) must show a person exactly the leads cw_visible_lead does,
// whatever mix of scopes they have.
func TestTheSnapshotsLeadConditionMatchesTheVisibilityFunction(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	e.call(alice, orgA, "GET", "/sync/snapshot?limit=1", nil) // the workspace is made when it is first used
	me := "aaaaaaaa-0000-4000-8000-000000000001"
	other := "aaaaaaaa-0000-4000-8000-000000000002"
	team, otherTeam := "bbbbbbbb-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000002"
	list, otherList := "cccccccc-0000-4000-8000-000000000001", "cccccccc-0000-4000-8000-000000000002"
	for _, stmt := range []string{
		fmt.Sprintf(`INSERT INTO crm.teams (id, org_id, name) VALUES ('%s', '%s', 'mine'), ('%s', '%s', 'other')`, team, orgA, otherTeam, orgA),
		fmt.Sprintf(`INSERT INTO crm.projects (id, org_id, name) VALUES ('%s', '%s', 'mine'), ('%s', '%s', 'other')`, list, orgA, otherList, orgA),
	} {
		if _, err := e.admin.Exec(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	// Every combination of: assigned to me or someone else or no one, my team or another or none, my list or another or none, and deleted or not.
	n := 0
	for _, assignee := range []string{me, other, ""} {
		for _, tm := range []string{team, otherTeam, ""} {
			for _, pr := range []string{list, otherList, ""} {
				for _, deleted := range []bool{false, true} {
					n++
					id := fmt.Sprintf("dddddddd-0000-4000-8000-%012d", n)
					if _, err := e.admin.Exec(ctx, `INSERT INTO crm.leads (id, org_id, name, assignee_id, team_id, project_id, deleted_at)
						VALUES ($1::uuid, $2, $1::text, NULLIF($3, '')::uuid, NULLIF($4, '')::uuid, NULLIF($5, '')::uuid, CASE WHEN $6 THEN now() END)`, id, orgA, assignee, tm, pr, deleted); err != nil {
						t.Fatal(err)
					}
				}
			}
		}
	}
	// A handoff to me of a lead assigned to someone else, and a lead shared with me.
	if _, err := e.admin.Exec(ctx, `INSERT INTO crm.handoffs (org_id, lead_id, from_user, to_user, note, status) SELECT org_id, id, $1::uuid, $2::uuid, '', 'Requested' FROM crm.leads WHERE name = 'dddddddd-0000-4000-8000-000000000041'`, other, me); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admin.Exec(ctx, `INSERT INTO crm.lead_shares (org_id, lead_id, user_id) SELECT org_id, id, $1::uuid FROM crm.leads WHERE name = 'dddddddd-0000-4000-8000-000000000053'`, me); err != nil {
		t.Fatal(err)
	}
	for _, scopes := range [][]string{{"organization"}, {"team"}, {"project"}, {"own"}, {"shared"}, {"team", "own"}, {"project", "shared"}, {"team", "project", "own", "shared"}, {}} {
		sc := scope{userID: me, orgID: orgA, scopes: scopes, teamIDs: []string{team}, projectIDs: []string{list}}
		tx, err := e.s.st.begin(ctx, sc)
		if err != nil {
			t.Fatal(err)
		}
		where, args := leadVisible(sc, "l", nil)
		ids := func(sql string, a ...any) []string {
			rows, err := tx.Query(ctx, sql, a...)
			if err != nil {
				t.Fatal(err)
			}
			defer rows.Close()
			var out []string
			for rows.Next() {
				var id string
				if err = rows.Scan(&id); err != nil {
					t.Fatal(err)
				}
				out = append(out, id)
			}
			slices.Sort(out)
			return out
		}
		byFunction := ids(`SELECT l.id::text FROM leads l WHERE cw_visible_lead(l.id)`)
		byCondition := ids(`SELECT l.id::text FROM leads l WHERE `+where, args...)
		_ = tx.Rollback(ctx)
		if !slices.Equal(byFunction, byCondition) {
			t.Fatalf("scopes %v: the function shows %d leads, the condition %d", scopes, len(byFunction), len(byCondition))
		}
		if len(scopes) == 1 && scopes[0] == "organization" && len(byCondition) == 0 {
			t.Fatalf("an organization-wide person sees nothing: the test has no leads to compare")
		}
	}
}

// A caller who is a deputy lead of another team (D62) sees that team's leads and their own, never their own team's other leads,
// both through row security and through the snapshot's condition.
func TestADeputySeesTheTeamTheyDeputiseNotTheirOwnTeamsLeads(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	e.call(alice, orgA, "GET", "/sync/snapshot?limit=1", nil)
	me, other := "aaaaaaaa-0000-4000-8000-000000000011", "aaaaaaaa-0000-4000-8000-000000000012"
	own, deputised := "bbbbbbbb-0000-4000-8000-000000000011", "bbbbbbbb-0000-4000-8000-000000000012"
	if _, err := e.admin.Exec(ctx, fmt.Sprintf(`INSERT INTO crm.teams (id, org_id, name) VALUES ('%s', '%s', 'own'), ('%s', '%s', 'deputised')`, own, orgA, deputised, orgA)); err != nil {
		t.Fatal(err)
	}
	leads := map[string][2]string{ // name -> assignee, team
		"colleague's lead in my team": {other, own},
		"the deputised team's lead":   {other, deputised},
		"my own lead":                 {me, own},
	}
	for name, l := range leads {
		if _, err := e.admin.Exec(ctx, `INSERT INTO crm.leads (org_id, name, assignee_id, team_id) VALUES ($1, $2, $3::uuid, $4::uuid)`, orgA, name, l[0], l[1]); err != nil {
			t.Fatal(err)
		}
	}
	g := grantReply{Scopes: []string{"own", "team"}, TeamIDs: []string{own, deputised}, TeamScopeIDs: []string{deputised}}
	sc := scope{userID: me, orgID: orgA, scopes: g.Scopes, teamIDs: g.TeamIDs, seeTeams: g.seeTeams()}
	tx, err := e.s.st.begin(ctx, sc)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	names := func(sql string, a ...any) []string {
		rows, err := tx.Query(ctx, sql, a...)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var n string
			if err = rows.Scan(&n); err != nil {
				t.Fatal(err)
			}
			out = append(out, n)
		}
		slices.Sort(out)
		return out
	}
	want := []string{"my own lead", "the deputised team's lead"}
	if got := names(`SELECT l.name FROM leads l WHERE cw_visible_lead(l.id)`); !slices.Equal(got, want) {
		t.Fatalf("row security shows %v, want %v", got, want)
	}
	where, args := leadVisible(sc, "l", nil)
	if got := names(`SELECT l.name FROM leads l WHERE `+where, args...); !slices.Equal(got, want) {
		t.Fatalf("the snapshot's condition shows %v, want %v", got, want)
	}
	// An older authz (no team_scope_ids) keeps the old meaning.
	if old := (grantReply{TeamIDs: []string{own}}).seeTeams(); !slices.Equal(old, []string{own}) {
		t.Fatalf("older grant: %v", old)
	}
}
