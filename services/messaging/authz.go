package main

import (
	"context"
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

// rules is what this service asks the authorization service: may this person work in this workspace, and who else is in it.
type rules interface {
	grant(ctx context.Context, user, org string, secondStep bool) (grantReply, error)
	roster(ctx context.Context, org string) (roster, error)
}

// grantReply is the answer to "may this person work in this workspace": the rights to use, or a code and a reason.
type grantReply struct {
	Allowed      bool     `json:"allowed"`
	Code         string   `json:"code"`
	Reason       string   `json:"reason"`
	Scopes       []string `json:"scopes"`
	Capabilities []string `json:"capabilities"`
}

type member struct {
	UserID  string   `json:"user_id"`
	Roles   []string `json:"roles"`
	TeamIDs []string `json:"team_ids"`
}

// team is one of the workspace's teams: its leads and deputy leads.
type team struct {
	TeamID     string   `json:"team_id"`
	Name       string   `json:"name"`
	ManagerIDs []string `json:"manager_ids"`
	DeputyIDs  []string `json:"deputy_ids"`
}

// roster is who is in a workspace and its teams, as authz has them.
type roster struct {
	Members []member `json:"members"`
	Teams   []team   `json:"teams"`
}

var (
	errUnavailable = errors.New("the authorization service cannot be reached")
	errNoCaller    = errors.New("the authorization service refused this service's token")
)

type authzClient struct {
	base, token string
	http        *http.Client
	ttl         time.Duration

	mu      sync.Mutex
	cache   map[string]cached
	rosters map[string]cachedRoster
}

type cachedRoster struct {
	roster  roster
	expires time.Time
}

type cached struct {
	reply   grantReply
	expires time.Time
}

func newAuthz(base, token string, ttl time.Duration) *authzClient {
	return &authzClient{base: base, token: token, ttl: ttl, http: &http.Client{Timeout: 5 * time.Second}, cache: map[string]cached{}, rosters: map[string]cachedRoster{}}
}

func (a *authzClient) call(ctx context.Context, method, path string, body io.Reader, into any) error {
	req, err := http.NewRequestWithContext(ctx, method, a.base+path, body)
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

// roster answers who is in the workspace and its teams, kept for as long as a grant is: team chats follow it on every request.
func (a *authzClient) roster(ctx context.Context, org string) (roster, error) {
	a.mu.Lock()
	if hit, ok := a.rosters[org]; ok && time.Now().Before(hit.expires) {
		a.mu.Unlock()
		return hit.roster, nil
	}
	a.mu.Unlock()
	var r roster
	if err := a.call(ctx, http.MethodGet, "/v1/orgs/"+url.PathEscape(org)+"/members", nil, &r); err != nil {
		return r, err
	}
	a.mu.Lock()
	if len(a.rosters) > 1000 {
		a.rosters = map[string]cachedRoster{}
	}
	a.rosters[org] = cachedRoster{r, time.Now().Add(a.ttl)}
	a.mu.Unlock()
	return r, nil
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
	body, _ := json.Marshal(map[string]any{"user_id": user, "org_id": org, "action": "read", "second_step_passed": secondStep})
	if err := a.call(ctx, http.MethodPost, "/v1/grant", strings.NewReader(string(body)), &r); err != nil {
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

// scope is one person acting in one workspace: what their transactions run as.
type scope struct {
	userID, orgID string
	scopes, caps  []string
}

func (s scope) can(capability string) bool { return slices.Contains(s.caps, capability) }

// external is true for a client who sees only what was explicitly shared with them: they are not part of the team's chats.
func (s scope) external() bool {
	return len(s.scopes) > 0 && !slices.ContainsFunc(s.scopes, func(x string) bool { return x != "shared" })
}
