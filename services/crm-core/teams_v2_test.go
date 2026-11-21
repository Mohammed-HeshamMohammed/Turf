package crm

import "testing"

// An agent in several teams (D97): a lead of any one of them can give them leads, into that team.
func TestALeadGivesWorkToAnAgentInSeveralTeamsThroughTheTeamTheyLead(t *testing.T) {
	agent := member{UserID: "u", TeamIDs: []string{"t1", "t2"}}
	if got := teamOf(agent, []string{"t2"}); got != "t2" || !inTeams(agent, []string{"t2"}) {
		t.Fatalf("the lead of t2: team %q", got)
	}
	if got := teamOf(agent, nil); got != "t1" || inTeams(agent, []string{"t3"}) {
		t.Fatalf("someone who leads neither: team %q", got)
	}
	if got := teamOf(member{UserID: "lead"}, []string{"t1"}); got != "" {
		t.Fatalf("someone in no team: %q", got)
	}
	if leads := (authzTeam{ManagerID: "a"}).leads(); len(leads) != 1 || leads[0] != "a" {
		t.Fatalf("an older authz's one manager: %v", leads)
	}
	if leads := (authzTeam{ManagerID: "a", ManagerIDs: []string{"a", "b"}}).leads(); len(leads) != 2 {
		t.Fatalf("two equal leads: %v", leads)
	}
}
