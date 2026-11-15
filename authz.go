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
}

type member struct {
	UserID  string   `json:"user_id"`
	Roles   []string `json:"roles"`
	TeamIDs []string `json:"team_ids"`
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
	TeamID    string `json:"team_id"`
	Name      string `json:"name"`
	ManagerID string `json:"manager_id"`
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
	caps                 []string
	secondStep           bool
}

func (s scope) can(capability string) bool { return slices.Contains(s.caps, capability) }

// external is true for a client who sees only what was explicitly shared with them.
func (s scope) external() bool {
	return len(s.scopes) > 0 && !slices.ContainsFunc(s.scopes, func(x string) bool { return x != "shared" })
}

// accessRevision changes whenever what the person may see changes, so a device holding an older one starts over with a
// fresh snapshot. It is a number that fits JavaScript's safe integers.
func accessRevision(g grantReply) int64 {
	parts := func(v []string) []string { v = slices.Clone(v); slices.Sort(v); return v }
	b, _ := json.Marshal([]any{parts(g.Scopes), parts(g.TeamIDs), parts(g.ProjectIDs), parts(g.Capabilities)})
	h := uint64(14695981039346656037)
	for _, c := range b {
		h = (h ^ uint64(c)) * 1099511628211
	}
	return int64(h & (1<<50 - 1))
}
