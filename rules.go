package main

import (
	"regexp"
	"slices"
	"sort"
	"strings"
)

// capabilities are the things a role can allow in a workspace, with the same names the core API uses (access.rs).
var capabilities = []string{
	"edit", "assign", "handoff", "accept", "call", "message", "export", "finance", "import", "rules", "admin", "review", "publicComment",
}

// scopes are which records a role's holders see. "none" sees no records (a role that only administers).
var scopes = []string{"organization", "team", "project", "own", "shared"}

// preset is a role every workspace starts with (access.rs PRESETS): its capabilities, scope and whether it needs the second step.
type preset struct {
	key, name    string
	capabilities []string
	scope        string
	secondStep   bool
}

var presets = []preset{
	{"solo", "Solo operator", []string{"edit", "assign", "handoff", "accept", "call", "message", "export", "finance", "import", "rules", "admin", "review"}, "organization", false},
	// A researcher prepares leads in their teams (import, clean, merge, tag) and never calls, texts or sees deal money (D337).
	{"researcher", "Data researcher", []string{"edit", "import", "review"}, "team", false},
	{"caller", "Caller", []string{"edit", "handoff", "call", "message"}, "own", false},
	{"closer", "Acquisitions / closer", []string{"edit", "accept", "call", "message", "finance"}, "own", false},
	// On screen "Team lead" (D178); the key stays manager.
	{"manager", "Team lead", []string{"edit", "assign", "handoff", "accept", "call", "message", "export", "finance", "import", "rules"}, "team", false},
	// An admin does what the owner does with people, teams and settings, but not billing, handing over or closing (D100).
	{"admin", "Admin", []string{"edit", "assign", "handoff", "accept", "call", "message", "export", "finance", "import", "rules", "review", "admin"}, "organization", false},
	{"owner", "Agency owner", []string{"edit", "assign", "handoff", "accept", "call", "message", "export", "finance", "import", "rules", "review", "admin"}, "organization", false},
	{"client", "Client / partner", []string{"publicComment"}, "shared", false},
}

// heldRoles belong to whoever opened the workspace: never given by an invitation or a role change, and they manage access.
var heldRoles = []string{"owner", "solo"}

// dbRoles is the database role each action runs under in the core database (docs/plans/authorization-service.md). The role
// decides which tables can be touched at all; row security decides which rows.
var dbRoles = map[string]string{
	"read":          "cw_read",
	"edit":          "cw_write",
	"assign":        "cw_write",
	"handoff":       "cw_write",
	"accept":        "cw_write",
	"call":          "cw_write",
	"message":       "cw_write",
	"review":        "cw_write",
	"rules":         "cw_write",
	"publicComment": "cw_write",
	"import":        "cw_import",
	"export":        "cw_export",
	"finance":       "cw_finance",
	"pay":           "cw_finance",
	"admin":         "cw_admin",
	"platform":      "cw_staff",
}

var roleKey = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

// facts is what the rules store says about one person in one workspace.
type facts struct {
	member          bool
	capabilities    map[string]bool
	scopes          []string
	secondStep      bool // one of their roles needs the second step
	teams, projects []string
	roles           []string // their workspace roles, switched-off ones left out
	managed         []string // the teams they lead
	deputyOf        []string // the teams they are a deputy lead of
	teamScope       []string // the teams whose records the "team" scope shows them
	memberSuspended bool     // this person is suspended in the workspace
	suspended       bool
	paymentRequired bool
	paused          bool // the owner is gone (step 13, D27): members read, nobody works
}

// grantRequest is what a service asks before doing something for a person.
type grantRequest struct {
	UserID           string `json:"user_id"`
	OrgID            string `json:"org_id"`
	Action           string `json:"action"`
	SecondStepPassed bool   `json:"second_step_passed"`
}

// decision is the answer: allowed with the rights to use, or refused with a code programs read and a sentence people read.
type decision struct {
	Allowed      bool     `json:"allowed"`
	Code         string   `json:"code,omitempty"`
	Reason       string   `json:"reason,omitempty"`
	DBRole       string   `json:"db_role,omitempty"`
	Scopes       []string `json:"scopes,omitempty"`
	TeamIDs      []string `json:"team_ids,omitempty"`
	ProjectIDs   []string `json:"project_ids,omitempty"`
	Capabilities []string `json:"capabilities,omitempty"`
	// The person's workspace roles and the teams they manage, so a service can apply manager-to-agent rules itself.
	Roles          []string `json:"roles,omitempty"`
	ManagedTeamIDs []string `json:"managed_team_ids,omitempty"`
	// DeputyTeamIDs are the teams they are a deputy lead of. TeamScopeIDs are the teams whose records the "team" scope shows; a
	// service that knows it uses it in place of TeamIDs for that scope.
	DeputyTeamIDs []string `json:"deputy_team_ids,omitempty"`
	TeamScopeIDs  []string `json:"team_scope_ids,omitempty"`
}

func refuse(code, reason string) decision { return decision{Code: code, Reason: reason} }

// settleScopes applies the person's restrictions and works out their teams. teams are every team they are in, lead or deputise;
// teamScope is the teams the "team" scope shows: the ones they lead or deputise, and their own teams only when a role other than
// team lead gives them the team scope. So a caller who deputises another team sees that team's leads, not all of their own team's
// (D62). A restriction on the team scope takes all of it away.
func settleScopes(f *facts, scopeSet map[string]bool, restrictions, ownTeams []string, ownTeamScope bool) {
	if len(f.deputyOf) > 0 {
		scopeSet["team"] = true
	}
	for _, restriction := range restrictions {
		if sc, ok := strings.CutPrefix(restriction, "scope:"); ok {
			delete(scopeSet, sc)
		} else {
			delete(f.capabilities, restriction)
		}
	}
	f.scopes = nil
	for _, sc := range scopes {
		if scopeSet[sc] {
			f.scopes = append(f.scopes, sc)
		}
	}
	f.teams = teamsSeen(teamsSeen(ownTeams, f.managed), f.deputyOf)
	f.teamScope = teamsSeen(f.managed, f.deputyOf)
	if ownTeamScope {
		f.teamScope = teamsSeen(f.teamScope, ownTeams)
	}
	if !scopeSet["team"] {
		f.teamScope = nil
	}
}

// knownAction is true for an action a grant can be asked for.
func knownAction(action string) bool {
	_, ok := dbRoles[action]
	return ok
}

// decideStaff answers a request to act on Caller Whale's own platform pages.
func decideStaff(staffRole string, secondStepPassed, staffSecondStep bool) decision {
	if staffRole != "owner" && staffRole != "cofounder" { // system_admin is switched off for now (disabledRoles)
		return refuse("not_staff", "This is for Caller Whale's staff.")
	}
	if staffSecondStep && !secondStepPassed {
		return refuse("second_step_required", "Confirm it's you with your second step first.")
	}
	return decision{Allowed: true, DBRole: dbRoles["platform"]}
}

// decide answers a request in a workspace from the facts about the person there. It never reads anything else, so it is the
// whole rule in one place.
func decide(f facts, req grantRequest, requireSecondStep bool) decision {
	if !f.member {
		return refuse("not_member", "You are not a member of this workspace.")
	}
	if f.suspended {
		return refuse("suspended", "This workspace is suspended. Contact Caller Whale support.")
	}
	if f.memberSuspended {
		return refuse("member_suspended", "Your access to this workspace is suspended. Ask the person who manages you.")
	}
	if requireSecondStep && f.secondStep && !req.SecondStepPassed {
		return refuse("second_step_required", "Confirm it's you with your second step first.")
	}
	if f.paused && req.Action != "read" {
		return refuse("paused", "This agency is paused while Caller Whale hands it to a new owner. You can read, but not work.")
	}
	granted := decision{
		Allowed:        true,
		DBRole:         dbRoles[req.Action],
		Scopes:         sortedCopy(f.scopes),
		TeamIDs:        sortedCopy(f.teams),
		ProjectIDs:     sortedCopy(f.projects),
		Capabilities:   held(f.capabilities),
		Roles:          sortedCopy(f.roles),
		ManagedTeamIDs: sortedCopy(f.managed),
		DeputyTeamIDs:  sortedCopy(f.deputyOf),
		TeamScopeIDs:   sortedCopy(f.teamScope),
	}
	switch req.Action {
	case "pay":
		// Paying stays open while the plan needs paying, for the people who handle money or run the workspace.
		if !f.capabilities["finance"] && !f.capabilities["admin"] {
			return refuse("missing_capability", "Your role does not allow this (finance).")
		}
		return granted
	}
	if f.paymentRequired {
		return refuse("payment_required", "This workspace's plan needs paying before it can be used.")
	}
	if req.Action == "read" {
		if len(f.scopes) == 0 {
			return refuse("no_scope", "Your role does not show any records.")
		}
		return granted
	}
	if !f.capabilities[req.Action] {
		return refuse("missing_capability", "Your role does not allow this ("+req.Action+").")
	}
	return granted
}

func held(caps map[string]bool) []string {
	out := []string{}
	for _, c := range capabilities {
		if caps[c] {
			out = append(out, c)
		}
	}
	return out
}

func sortedCopy(in []string) []string {
	out := slices.Clone(in)
	sort.Strings(out)
	if out == nil {
		out = []string{}
	}
	return out
}

// validRestriction is a capability, or "scope:<scope>", that can be taken away from one person.
func validRestriction(r string) bool {
	if slices.Contains(capabilities, r) {
		return true
	}
	if len(r) > 6 && r[:6] == "scope:" {
		return slices.Contains(scopes, r[6:])
	}
	return false
}

func orderCapabilities(in []string) []string {
	out := []string{}
	for _, c := range capabilities {
		if slices.Contains(in, c) {
			out = append(out, c)
		}
	}
	return out
}
