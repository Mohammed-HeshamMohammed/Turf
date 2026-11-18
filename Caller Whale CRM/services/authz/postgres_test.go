package main

import (
	"context"
	"os"
	"slices"
	"testing"
	"time"
)

// TestPostgres runs against a dedicated disposable PostgreSQL database.
func TestPostgres(t *testing.T) {
	url := os.Getenv("AUTHZ_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("AUTHZ_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	s, err := newPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(s.openWorkspace(ctx, org1, ownerID, "owner"))
	if owner, name, found, err := s.workspaceInfo(ctx, org1); err != nil || !found || owner != ownerID || name != "" {
		t.Errorf("a new workspace has its owner and no name yet: %q %q %v %v", owner, name, found, err)
	}
	must(s.setWorkspaceName(ctx, org1, "Blue Door Homes"))
	if _, name, _, _ := s.workspaceInfo(ctx, org1); name != "Blue Door Homes" {
		t.Errorf("the name is kept: %q", name)
	}
	if _, _, found, err := s.workspaceInfo(ctx, strangerID); found || err != nil {
		t.Errorf("a workspace never opened is not found: %v %v", found, err)
	}
	if err := s.openWorkspace(ctx, org1, strangerID, "owner"); err != errAlreadyOpen {
		t.Errorf("a second owner: %v", err)
	}
	must(s.openWorkspace(ctx, org1, ownerID, "owner"))

	owner, err := s.facts(ctx, ownerID, org1)
	must(err)
	if !owner.member || owner.secondStep || !owner.capabilities["admin"] || !slices.Equal(owner.scopes, []string{"organization"}) {
		t.Errorf("owner facts: %+v", owner)
	}
	if ok, _ := s.check(ctx, ownerID, org1, "manage_access"); !ok {
		t.Error("the owner manages access")
	}

	must(s.setMembership(ctx, org1, membership{UserID: callerID, Roles: []string{"caller"}, Restrictions: []string{"call"}, TeamIDs: []string{team1}}))
	caller, err := s.facts(ctx, callerID, org1)
	must(err)
	if !caller.member || caller.capabilities["call"] || !caller.capabilities["edit"] || !slices.Equal(caller.scopes, []string{"own"}) || !slices.Equal(caller.teams, []string{team1}) {
		t.Errorf("caller facts: %+v", caller)
	}
	if d := decide(caller, grantRequest{Action: "read"}, true); !d.Allowed || d.DBRole != "cw_read" {
		t.Errorf("caller read: %+v", d)
	}

	m, ok, err := s.membership(ctx, org1, callerID)
	must(err)
	if !ok || !slices.Equal(m.Roles, []string{"caller"}) || !slices.Equal(m.Restrictions, []string{"call"}) || !slices.Equal(m.TeamIDs, []string{team1}) {
		t.Errorf("membership: %+v", m)
	}
	all, err := s.members(ctx, org1)
	must(err)
	if len(all) != 2 {
		t.Errorf("members: %+v", all)
	}

	must(s.setRole(ctx, org1, role{Key: "helper", Capabilities: []string{"export", "publicComment"}, Scope: "team"}))
	must(s.setMembership(ctx, org1, membership{UserID: callerID, Roles: []string{"caller", "helper"}}))
	caller, err = s.facts(ctx, callerID, org1)
	must(err)
	if !caller.capabilities["export"] || !caller.capabilities["call"] || !caller.capabilities["publicComment"] || !slices.Equal(caller.scopes, []string{"team", "own"}) || len(caller.teams) != 0 {
		t.Errorf("roles combine and the old restriction and team are gone: %+v", caller)
	}
	roles, err := s.roles(ctx, org1)
	must(err)
	i := slices.IndexFunc(roles, func(r role) bool { return r.Key == "helper" })
	if len(roles) != len(presets)+1 || i < 0 || !slices.Equal(roles[i].Capabilities, []string{"export", "publicComment"}) || roles[i].Scope != "team" {
		t.Errorf("roles: %+v", roles)
	}

	yes, no := true, false
	must(s.setStanding(ctx, org1, standingChange{Suspended: &no, PaymentRequired: &yes}))
	caller, _ = s.facts(ctx, callerID, org1)
	if !caller.paymentRequired || caller.suspended {
		t.Errorf("standing: %+v", caller)
	}
	must(s.setStanding(ctx, org1, standingChange{PaymentRequired: &no}))

	must(s.removeMember(ctx, org1, callerID))
	if f, _ := s.facts(ctx, callerID, org1); f.member {
		t.Error("a removed person is not a member")
	}

	must(s.setPlatformOwner(ctx, ownerID))
	must(s.setPlatformOwner(ctx, ownerID))
	if err := s.setPlatformOwner(ctx, callerID); err != errOwnerTaken {
		t.Errorf("a second Caller Whale owner: %v", err)
	}
	if r, _ := s.staffRole(ctx, ownerID); r != "owner" {
		t.Errorf("the Caller Whale owner: %q", r)
	}
	must(s.setCofounder(ctx, callerID))
	must(s.setCofounder(ctx, callerID))
	if err := s.setCofounder(ctx, strangerID); err != errCofounderTaken {
		t.Errorf("second cofounder: %v", err)
	}
	if _, err := s.db.Exec(ctx, `DELETE FROM authz_staff WHERE user_id=$1`, ownerID); err == nil {
		t.Error("database deleted the permanent owner")
	}
	if _, err := s.db.Exec(ctx, `UPDATE authz_staff SET role='tester' WHERE user_id=$1`, callerID); err == nil {
		t.Error("database changed the permanent cofounder")
	}
	if ok, err := s.check(ctx, callerID, "", "manage_staff"); err != nil || !ok {
		t.Errorf("cofounder manages staff: %t %v", ok, err)
	}
	must(s.setMembership(ctx, org1, membership{UserID: callerID, Roles: []string{"caller"}}))
	if spaces, err := s.workspaces(ctx, callerID); err != nil || !slices.Equal(spaces, []string{org1}) {
		t.Errorf("workspaces: %v %v", spaces, err)
	}
	must(s.removeMember(ctx, org1, callerID))
	must(s.setStaff(ctx, strangerID, "system_admin"))
	if r, _ := s.staffRole(ctx, strangerID); r != "system_admin" {
		t.Errorf("staff: %q", r)
	}
	must(s.setStaff(ctx, strangerID, ""))
	if r, _ := s.staffRole(ctx, strangerID); r != "" {
		t.Errorf("staff removed: %q", r)
	}
	must(s.setStaff(ctx, strangerID, "tester"))
	if ok, err := s.check(ctx, strangerID, "", "staff"); err != nil || ok {
		t.Errorf("tester got staff access: %t %v", ok, err)
	}
	if ok, err := s.check(ctx, strangerID, "", "tester"); err != nil || !ok {
		t.Errorf("tester identity: %t %v", ok, err)
	}
	// Startup runs schema setup again. Permanent roles must still belong to the same people.
	again, err := newPostgres(ctx, url)
	must(err)
	defer again.close()
	if r, err := again.staffRole(ctx, ownerID); err != nil || r != "owner" {
		t.Errorf("owner after redeploy: %q %v", r, err)
	}
	if r, err := again.staffRole(ctx, callerID); err != nil || r != "cofounder" {
		t.Errorf("cofounder after redeploy: %q %v", r, err)
	}
}

// The team tree's SQL: teams and their manager, suspension, and standing that changes only what is sent.
func TestPostgresTeamTree(t *testing.T) {
	url := os.Getenv("AUTHZ_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("AUTHZ_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	s, err := newPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	org := "12121212-1212-4212-8212-121212121212"
	must(s.openWorkspace(ctx, org, ownerID, "owner"))
	must(s.setMembership(ctx, org, membership{UserID: managerID, Roles: []string{"manager"}}))
	must(s.setTeam(ctx, org, team{TeamID: team1, Name: "Team one", ManagerID: managerID}))
	must(s.setTeam(ctx, org, team{TeamID: team2, Name: "Team two"}))
	must(s.setMembership(ctx, org, membership{UserID: callerID, Roles: []string{"caller"}, TeamIDs: []string{team1}}))
	if err := s.setTeam(ctx, org, team{TeamID: closerID, Name: "team ONE"}); err == nil {
		t.Error("two teams cannot share a name")
	}
	teams, err := s.teams(ctx, org)
	must(err)
	if len(teams) != 2 || teams[0].ManagerID != managerID || teams[1].ManagerID != "" {
		t.Errorf("teams: %+v", teams)
	}
	m, err := s.facts(ctx, managerID, org)
	must(err)
	if !slices.Equal(m.managed, []string{team1}) || !slices.Contains(m.teams, team1) || !m.capabilities["import"] {
		t.Errorf("a manager runs team one, sees its leads and uploads lists: %+v", m)
	}
	at := int64(1_800_000_000)
	must(s.setSuspension(ctx, org, callerID, &at, managerID, "on leave"))
	must(s.setMembership(ctx, org, membership{UserID: callerID, Roles: []string{"caller"}, TeamIDs: []string{team1}, Restrictions: []string{"export"}}))
	c, ok, err := s.membership(ctx, org, callerID)
	must(err)
	if !ok || c.SuspendedAt == nil || *c.SuspendedAt != at || c.SuspendedBy != managerID || c.SuspendedReason != "on leave" {
		t.Errorf("a suspension survives a change of restrictions: %+v", c)
	}
	if f, _ := s.facts(ctx, callerID, org); !f.memberSuspended {
		t.Error("a suspended caller's facts say so")
	}
	must(s.setSuspension(ctx, org, callerID, nil, "", ""))
	if f, _ := s.facts(ctx, callerID, org); f.memberSuspended {
		t.Error("restored")
	}
	yes, two := true, 2
	must(s.setStanding(ctx, org, standingChange{Suspended: &yes}))
	must(s.setStanding(ctx, org, standingChange{SeatsSet: true, Seats: &two}))
	if f, _ := s.facts(ctx, ownerID, org); !f.suspended {
		t.Error("setting the seats leaves a suspension alone")
	}
	seats, clients, err := s.seatLimits(ctx, org)
	must(err)
	if seats == nil || *seats != 2 || clients != nil {
		t.Errorf("seats %v clients %v", seats, clients)
	}
	must(s.removeTeam(ctx, org, team2))
	if teams, _ := s.teams(ctx, org); len(teams) != 1 {
		t.Errorf("team removed: %+v", teams)
	}
}

// The record of people changes in PostgreSQL: written, read newest first, and trimmed after two years.
func TestPostgresPeopleLog(t *testing.T) {
	url := os.Getenv("AUTHZ_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("AUTHZ_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	s, err := newPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	org := "13131313-1313-4313-8313-131313131313"
	now := time.Now().Unix()
	old := peopleEntry{At: now - 800*24*3600, ActorID: ownerID, TargetID: callerID, Action: "joined", TeamIDs: []string{team1}}
	recent := peopleEntry{At: now, ActorID: ownerID, TargetID: callerID, Action: "suspended", TeamIDs: []string{team1}, Detail: map[string]any{"reason": "On leave"}}
	if err := s.logPeople(ctx, org, old); err != nil {
		t.Fatal(err)
	}
	if err := s.logPeople(ctx, org, recent); err != nil {
		t.Fatal(err)
	}
	got, err := s.peopleLog(ctx, org, 0, 10)
	if err != nil || len(got) != 1 || got[0].Action != "suspended" || got[0].Detail["reason"] != "On leave" || got[0].TeamIDs[0] != team1 {
		t.Fatalf("the two-year-old entry is gone, the new one reads back: %+v %v", got, err)
	}
}
