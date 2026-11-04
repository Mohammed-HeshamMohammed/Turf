package main

import (
	"context"
	"os"
	"slices"
	"testing"
	"time"
)

// TestSpiceDB runs the real rules store against a SpiceDB started with `spicedb serve-testing` (an empty in-memory store per
// key). Set SPICEDB_TEST_ENDPOINT (like localhost:50051) to run it; without it the test is skipped.
func TestSpiceDB(t *testing.T) {
	endpoint := os.Getenv("SPICEDB_TEST_ENDPOINT")
	if endpoint == "" {
		t.Skip("SPICEDB_TEST_ENDPOINT is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	s, err := newSpice(config{spicedbEndpoint: endpoint, spicedbKey: "test-" + time.Now().Format("150405.000000")})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.writeSchema(ctx); err != nil {
		t.Fatalf("schema.zed is refused: %v", err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(s.openWorkspace(ctx, org1, ownerID, "owner"))
	if err := s.openWorkspace(ctx, org1, strangerID, "owner"); err != errAlreadyOpen {
		t.Errorf("a second owner: %v", err)
	}
	must(s.openWorkspace(ctx, org1, ownerID, "owner"))

	owner, err := s.facts(ctx, ownerID, org1)
	must(err)
	if !owner.member || !owner.secondStep || !owner.capabilities["admin"] || !slices.Equal(owner.scopes, []string{"organization"}) {
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

	must(s.setStanding(ctx, org1, false, true))
	caller, _ = s.facts(ctx, callerID, org1)
	if !caller.paymentRequired || caller.suspended {
		t.Errorf("standing: %+v", caller)
	}
	must(s.setStanding(ctx, org1, false, false))

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
	must(s.setMembership(ctx, org1, membership{UserID: callerID, Roles: []string{"caller"}}))
	if spaces, err := s.workspaces(ctx, callerID); err != nil || !slices.Equal(spaces, []string{org1}) {
		t.Errorf("workspaces: %v %v", spaces, err)
	}
	must(s.removeMember(ctx, org1, callerID))
	must(s.setStaff(ctx, strangerID, "admin"))
	if r, _ := s.staffRole(ctx, strangerID); r != "admin" {
		t.Errorf("staff: %q", r)
	}
	must(s.setStaff(ctx, strangerID, ""))
	if r, _ := s.staffRole(ctx, strangerID); r != "" {
		t.Errorf("staff removed: %q", r)
	}
}
