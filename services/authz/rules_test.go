package main

import (
	"slices"
	"testing"
)

func caps(names ...string) map[string]bool {
	out := map[string]bool{}
	for _, n := range names {
		out[n] = true
	}
	return out
}

func TestDecide(t *testing.T) {
	caller := facts{member: true, capabilities: caps("edit", "handoff", "call", "message"), scopes: []string{"own"}, teams: []string{"t2", "t1"}}
	owner := facts{member: true, capabilities: caps("edit", "admin", "finance"), scopes: []string{"organization"}, secondStep: true}
	adminOnly := facts{member: true, capabilities: caps("admin")}
	// The agency's owner as step 18 needs them: their role named, and allowed to export.
	agencyOwner := facts{member: true, capabilities: caps("edit", "admin", "finance", "export", "call"), scopes: []string{"organization"}, roles: []string{"owner"}}
	cases := []struct {
		name   string
		f      facts
		action string
		second bool
		want   string // "" when allowed, else the refusal code
		role   string
	}{
		{"a stranger is refused", facts{capabilities: map[string]bool{}}, "read", false, "not_member", ""},
		{"a caller reads their records", caller, "read", false, "", "cw_read"},
		{"a caller edits", caller, "edit", false, "", "cw_write"},
		{"a caller cannot export", caller, "export", false, "missing_capability", ""},
		{"an owner without the second step is refused", owner, "admin", false, "second_step_required", ""},
		{"an owner with the second step administers", owner, "admin", true, "", "cw_admin"},
		{"admin alone sees no records", adminOnly, "read", false, "no_scope", ""},
		{"a suspended workspace refuses everything", func() facts { f := owner; f.suspended = true; return f }(), "pay", true, "suspended", ""},
		{"an unpaid workspace works through its grace period", func() facts { f := caller; f.paymentRequired = true; f.unpaidFor = 3 * 86_400; return f }(), "call", true, "", "cw_write"},
		{"after the grace period it is read-only", func() facts { f := caller; f.paymentRequired = true; f.unpaidFor = 8 * 86_400; return f }(), "call", false, "read_only", ""},
		{"read-only still reads", func() facts { f := caller; f.paymentRequired = true; f.unpaidFor = 8 * 86_400; return f }(), "read", true, "", "cw_read"},
		{"read-only still exports", func() facts { f := agencyOwner; f.paymentRequired = true; f.unpaidFor = 8 * 86_400; return f }(), "export", true, "", "cw_export"},
		{"after 37 days unpaid it is closed to members", func() facts { f := caller; f.paymentRequired = true; f.unpaidFor = 38 * 86_400; return f }(), "read", false, "closed", ""},
		{"a closed agency lets its owner export", func() facts { f := agencyOwner; f.closed = true; return f }(), "export", true, "", "cw_export"},
		{"a closed agency lets nobody work", func() facts { f := agencyOwner; f.closed = true; return f }(), "call", false, "closed", ""},
		{"an unpaid workspace still lets the owner pay", func() facts { f := owner; f.paymentRequired = true; return f }(), "pay", true, "", "cw_finance"},
		{"a caller cannot pay", func() facts { f := caller; f.paymentRequired = true; return f }(), "pay", false, "missing_capability", ""},
	}
	for _, c := range cases {
		d := decide(c.f, grantRequest{Action: c.action, SecondStepPassed: c.second}, true)
		if c.want == "" && (!d.Allowed || d.DBRole != c.role) {
			t.Errorf("%s: got %+v", c.name, d)
		}
		if c.want != "" && (d.Allowed || d.Code != c.want) {
			t.Errorf("%s: want %s, got %+v", c.name, c.want, d)
		}
	}
	d := decide(caller, grantRequest{Action: "read"}, true)
	if !slices.Equal(d.TeamIDs, []string{"t1", "t2"}) || !slices.Equal(d.Capabilities, []string{"edit", "handoff", "call", "message"}) {
		t.Errorf("the grant carries sorted teams and capabilities in catalogue order: %+v", d)
	}
	if !decide(owner, grantRequest{Action: "admin"}, false).Allowed {
		t.Error("with the second step not required, the owner is not asked for it")
	}
}

func TestDecideStaff(t *testing.T) {
	if d := decideStaff("", true, true); d.Allowed || d.Code != "not_staff" {
		t.Errorf("not staff: %+v", d)
	}
	if d := decideStaff("cofounder", false, true); d.Allowed || d.Code != "second_step_required" {
		t.Errorf("staff without the second step: %+v", d)
	}
	if d := decideStaff("system_admin", true, true); !d.Allowed || d.DBRole != "cw_staff" {
		t.Errorf("a system admin is staff (D391): %+v", d)
	}
	if d := decideStaff("tester", true, true); d.Allowed || d.Code != "not_staff" {
		t.Errorf("a tester is not: %+v", d)
	}
	if d := decideStaff("cofounder", true, true); !d.Allowed || d.DBRole != "cw_staff" {
		t.Errorf("cofounder: %+v", d)
	}
	if d := decideStaff("tester", true, true); d.Allowed || d.Code != "not_staff" {
		t.Errorf("tester must not get staff database rights: %+v", d)
	}
}

func TestEveryActionHasADatabaseRole(t *testing.T) {
	for _, c := range capabilities {
		if !knownAction(c) {
			t.Errorf("capability %s has no database role", c)
		}
	}
	for _, p := range presets {
		for _, c := range p.capabilities {
			if !slices.Contains(capabilities, c) {
				t.Errorf("preset %s grants unknown %s", p.key, c)
			}
		}
	}
}

func TestRestrictions(t *testing.T) {
	for _, ok := range []string{"call", "publicComment", "scope:team"} {
		if !validRestriction(ok) {
			t.Errorf("%s should be a restriction", ok)
		}
	}
	for _, no := range []string{"fly", "scope:", "scope:planet", ""} {
		if validRestriction(no) {
			t.Errorf("%q should not be a restriction", no)
		}
	}
}
