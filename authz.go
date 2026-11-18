package main

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

// rules is what crm-core asks the authorization service: who is in which workspace, and what each person may do there.
type rules interface {
	people(ctx context.Context, user string) (peopleReply, error)
	grant(ctx context.Context, user, org string, secondStep bool) (grantReply, error)
	members(ctx context.Context, org string) ([]member, error)
	open(ctx context.Context, org, user, role string) error
	teams(ctx context.Context, org string) ([]authzTeam, error)
	putTeam(ctx context.Context, org, id, name, actor string, secondStep bool) error
	// nameOrg tells authz the agency's name, so an invitation can say which agency it comes from.
	nameOrg(ctx context.Context, org, name string) error
	// upgrade makes a solo workspace an agency (step 17).
	upgrade(ctx context.Context, org, user, teamID, teamName string) error
}

type workspaceRoles struct {
	OrgID         string   `json:"org_id"`
	Roles         []string `json:"roles"`
	BusinessOwner bool     `json:"business_owner"`
}

type peopleReply struct {
	UserID       string           `json:"user_id"`
	PlatformRole string           `json:"platform_role"`
	Workspaces   []workspaceRoles `json:"workspaces"`
}

// grantReply is the answer to "may this person work in this workspace": the rights to use, or a code and a reason.
type grantReply struct {
	Allowed      bool     `json:"allowed"`
	Code         string   `json:"code"`
	Reason       string   `json:"reason"`
	Scopes       []string `json:"scopes"`
	TeamIDs      []string `json:"team_ids"`
	ProjectIDs   []string `json:"project_ids"`
	Capabilities []string `json:"capabilities"`
	// The person's workspace roles and the teams they manage (a team manager monitors those teams' callers and closers).
	Roles          []string `json:"roles"`
	ManagedTeamIDs []string `json:"managed_team_ids"`
	// The teams they are a deputy lead of, and the teams whose leads the "team" scope shows them (nil from an older authz: then
	// team_ids, as before).
	DeputyTeamIDs []string `json:"deputy_team_ids"`
	TeamScopeIDs  []string `json:"team_scope_ids"`
}

// seeTeams is the teams whose leads the "team" scope shows: a deputy's team, but not a caller's own team they only work in.
func (g grantReply) seeTeams() []string {
	if g.TeamScopeIDs != nil {
		return g.TeamScopeIDs
	}
	return g.TeamIDs
}

type member struct {
	UserID      string   `json:"user_id"`
	Roles       []string `json:"roles"`
	TeamIDs     []string `json:"team_ids"`
	SuspendedAt *int64   `json:"suspended_at,omitempty"`
}

var (
	errUnavailable = errors.New("the authorization service cannot be reached")
	errNoCaller    = errors.New("the authorization service refused crm-core's token")
)

type authzClient struct {
	base, token string
	http        *http.Client
	ttl         time.Duration

	mu    sync.Mutex
	cache map[string]cached
}

type cached struct {
	reply   grantReply
	expires time.Time
}

func newAuthz(base, token string, ttl time.Duration) *authzClient {
	return &authzClient{base: base, token: token, ttl: ttl, http: &http.Client{Timeout: 5 * time.Second}, cache: map[string]cached{}}
}

func (a *authzClient) call(ctx context.Context, method, path string, body, into any) error {
	var reader io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, a.base+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := a.http.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", errUnavailable, err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return errNoCaller
	case res.StatusCode != http.StatusOK:
		return fmt.Errorf("%w: status %d", errUnavailable, res.StatusCode)
	}
	return json.Unmarshal(data, into)
}

func (a *authzClient) people(ctx context.Context, user string) (peopleReply, error) {
	var r peopleReply
	return r, a.call(ctx, http.MethodGet, "/v1/people/"+url.PathEscape(user), nil, &r)
}

// open sets up a workspace with its owner. Asking again for the same owner changes nothing.
func (a *authzClient) open(ctx context.Context, org, user, role string) error {
	var out map[string]any
	return a.call(ctx, http.MethodPut, "/v1/orgs/"+url.PathEscape(org)+"/owner", map[string]string{"user_id": user, "role": role}, &out)
}

func (a *authzClient) members(ctx context.Context, org string) ([]member, error) {
	var r struct {
		Members []member `json:"members"`
	}
	return r.Members, a.call(ctx, http.MethodGet, "/v1/orgs/"+url.PathEscape(org)+"/members", nil, &r)
}

// authzTeam is one team of a workspace as authz keeps it (the single source of the team tree).
type authzTeam struct {
	TeamID     string   `json:"team_id"`
	Name       string   `json:"name"`
	ManagerID  string   `json:"manager_id"`
	ManagerIDs []string `json:"manager_ids"`
	DeputyIDs  []string `json:"deputy_ids"`
}

// leads are the team's leads: several under the new team rules (D43), the one manager from an older authz.
func (t authzTeam) leads() []string {
	if len(t.ManagerIDs) > 0 {
		return t.ManagerIDs
	}
	if t.ManagerID != "" {
		return []string{t.ManagerID}
	}
	return nil
}

// teamOf is the team a lead given to m goes to: the first of their teams that the giver leads, else their first team. "" for
// someone in no team.
func teamOf(m member, managed []string) string {
	for _, t := range m.TeamIDs {
		if slices.Contains(managed, t) {
			return t
		}
	}
	if len(m.TeamIDs) > 0 {
		return m.TeamIDs[0]
	}
	return ""
}

// inTeams is whether m works in any of these teams.
func inTeams(m member, teams []string) bool {
	return slices.ContainsFunc(m.TeamIDs, func(t string) bool { return slices.Contains(teams, t) })
}

func (a *authzClient) teams(ctx context.Context, org string) ([]authzTeam, error) {
	var r struct {
		Teams []authzTeam `json:"teams"`
	}
	return r.Teams, a.call(ctx, http.MethodGet, "/v1/orgs/"+url.PathEscape(org)+"/teams", nil, &r)
}

// putTeam creates or renames a team in authz for the person asking (authz decides whether they may).
func (a *authzClient) putTeam(ctx context.Context, org, id, name, actor string, secondStep bool) error {
	var out map[string]any
	return a.call(ctx, http.MethodPut, "/v1/orgs/"+url.PathEscape(org)+"/teams/"+url.PathEscape(id),
		map[string]any{"actor_id": actor, "actor_second_step": secondStep, "name": name}, &out)
}

func (a *authzClient) nameOrg(ctx context.Context, org, name string) error {
	var out map[string]any
	return a.call(ctx, http.MethodPut, "/v1/orgs/"+url.PathEscape(org)+"/name", map[string]any{"name": name}, &out)
}

// grant asks for the "read" grant, which carries everything the person holds in the workspace. Answers are kept for a few
// seconds so a burst of requests asks once; a removed member loses access within that time.
func (a *authzClient) grant(ctx context.Context, user, org string, secondStep bool) (grantReply, error) {
	key := fmt.Sprintf("%s|%s|%t", user, org, secondStep)
	a.mu.Lock()
	if hit, ok := a.cache[key]; ok && time.Now().Before(hit.expires) {
		a.mu.Unlock()
		return hit.reply, nil
	}
	a.mu.Unlock()
	var r grantReply
	err := a.call(ctx, http.MethodPost, "/v1/grant", map[string]any{"user_id": user, "org_id": org, "action": "read", "second_step_passed": secondStep}, &r)
	if err != nil {
		return r, err
	}
	a.mu.Lock()
	if len(a.cache) > 10000 {
		a.cache = map[string]cached{}
	}
	a.cache[key] = cached{r, time.Now().Add(a.ttl)}
	a.mu.Unlock()
	return r, nil
}

// staffWorkspaceID is the workspace id of a platform staff member's own workspace: made from their account id, so asking twice
// finds the same one.
func staffWorkspaceID(user string) string {
	h := sha1.Sum([]byte("callerwhale-staff-workspace:" + strings.ToLower(user)))
	h[6] = h[6]&0x0f | 0x50 // version 5
	h[8] = h[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", h[0:4], h[4:6], h[6:8], h[8:10], h[10:16])
}

// scope is one person acting in one workspace: what their transactions run as.
type scope struct {
	userID, orgID, label string
	roles, scopes        []string
	teamIDs, projectIDs  []string
	seeTeams             []string // the teams the "team" scope shows (grantReply.seeTeams)
	peekTeams            []string // the person's teams that let agents see the whole team, read-only (D124)
	caps                 []string
	secondStep           bool
	managed, deputyOf    []string // the teams they lead and deputise (the dialer's lead threads, step 10)
}

// visibleTeams is the teams whose leads the "team" scope shows; a scope built without them (an older queued run) uses its teams.
func (sc scope) visibleTeams() []string {
	if sc.seeTeams != nil {
		return sc.seeTeams
	}
	return sc.teamIDs
}

func (s scope) can(capability string) bool { return slices.Contains(s.caps, capability) }

// external is true for a client who sees only what was explicitly shared with them.
func (s scope) external() bool {
	return len(s.scopes) > 0 && !slices.ContainsFunc(s.scopes, func(x string) bool { return x != "shared" })
}

// accessRevision changes whenever what the person may see changes, so a device holding an older one starts over with a
// fresh snapshot. It is a number that fits JavaScript's safe integers.
func accessRevision(g grantReply, peek ...string) int64 {
	parts := func(v []string) []string { v = slices.Clone(v); slices.Sort(v); return v }
	var b []byte
	if len(peek) == 0 {
		b, _ = json.Marshal([]any{parts(g.Scopes), parts(g.TeamIDs), parts(g.ProjectIDs), parts(g.Capabilities)})
	} else {
		// The teams seen read-only (D124) are part of what this person sees: switching the team view changes the revision.
		b, _ = json.Marshal([]any{parts(g.Scopes), parts(g.TeamIDs), parts(g.ProjectIDs), parts(g.Capabilities), parts(peek)})
	}
	h := uint64(14695981039346656037)
	for _, c := range b {
		h = (h ^ uint64(c)) * 1099511628211
	}
	return int64(h & (1<<50 - 1))
}
