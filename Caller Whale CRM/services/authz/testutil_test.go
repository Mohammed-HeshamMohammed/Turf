package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"
)

// memEngine is the rules store in memory: a person's capabilities and scopes are the union of
// their roles' grants minus their restrictions; standing flags apply to everyone in the workspace.
type memEngine struct {
	roleDefs  map[string]map[string]role       // org -> key -> role
	people    map[string]map[string]membership // org -> user -> membership
	standing  map[string][2]bool               // org -> suspended, payment required
	staff     map[string]string                // user -> platform role
	failNext  bool
	openOwner map[string]string
}

func newMem() *memEngine {
	return &memEngine{roleDefs: map[string]map[string]role{}, people: map[string]map[string]membership{}, standing: map[string][2]bool{}, staff: map[string]string{}, openOwner: map[string]string{}}
}

var errStoreDown = errors.New("rules store down")

func (m *memEngine) down() error {
	if m.failNext {
		return errStoreDown
	}
	return nil
}

func (m *memEngine) facts(_ context.Context, user, org string) (facts, error) {
	if err := m.down(); err != nil {
		return facts{}, err
	}
	f := facts{capabilities: map[string]bool{}}
	st := m.standing[org]
	f.suspended, f.paymentRequired = st[0], st[1]
	p, ok := m.people[org][user]
	if !ok || len(p.Roles) == 0 {
		return f, nil
	}
	f.member = true
	scopeSet := map[string]bool{}
	for _, key := range p.Roles {
		r := m.roleDefs[org][key]
		for _, c := range r.Capabilities {
			f.capabilities[c] = true
		}
		if r.Scope != "none" && r.Scope != "" {
			scopeSet[r.Scope] = true
		}
		f.secondStep = f.secondStep || r.SecondStep
	}
	for _, restriction := range p.Restrictions {
		if sc, isScope := strings.CutPrefix(restriction, "scope:"); isScope {
			delete(scopeSet, sc)
		} else {
			delete(f.capabilities, restriction)
		}
	}
	for _, sc := range scopes {
		if scopeSet[sc] {
			f.scopes = append(f.scopes, sc)
		}
	}
	f.teams, f.projects = p.TeamIDs, p.ProjectIDs
	return f, nil
}

func (m *memEngine) staffRole(_ context.Context, user string) (string, error) {
	return m.staff[user], m.down()
}

func (m *memEngine) staffMembers(_ context.Context) ([]staffMember, error) {
	members := []staffMember{}
	for user, role := range m.staff {
		members = append(members, staffMember{UserID: user, Role: role})
	}
	return members, m.down()
}

func (m *memEngine) check(ctx context.Context, user, org, permission string) (bool, error) {
	switch permission {
	case "staff":
		return m.staff[user] == "owner" || m.staff[user] == "cofounder" || m.staff[user] == "system_admin", m.down()
	case "manage_staff":
		return m.staff[user] == "owner" || m.staff[user] == "cofounder", m.down()
	case "tester":
		return m.staff[user] == "tester", m.down()
	}
	f, err := m.facts(ctx, user, org)
	if err != nil {
		return false, err
	}
	switch permission {
	case "member":
		return f.member, nil
	case "manage_access":
		p := m.people[org][user]
		return m.staff[user] == "owner" || m.staff[user] == "cofounder" || m.staff[user] == "system_admin" || slices.ContainsFunc(p.Roles, func(r string) bool { return slices.Contains(heldRoles, r) }), nil
	}
	return f.capabilities[permission], nil
}

func (m *memEngine) roles(_ context.Context, org string) ([]role, error) {
	var out []role
	for _, r := range m.roleDefs[org] {
		out = append(out, r)
	}
	slices.SortFunc(out, func(a, b role) int { return strings.Compare(a.Key, b.Key) })
	return out, m.down()
}

func (m *memEngine) membership(_ context.Context, org, user string) (membership, bool, error) {
	p, ok := m.people[org][user]
	return p, ok && len(p.Roles) > 0, m.down()
}

func (m *memEngine) members(_ context.Context, org string) ([]membership, error) {
	out := []membership{}
	for _, p := range m.people[org] {
		out = append(out, p)
	}
	slices.SortFunc(out, func(a, b membership) int { return strings.Compare(a.UserID, b.UserID) })
	return out, m.down()
}

func (m *memEngine) setMembership(_ context.Context, org string, p membership) error {
	if err := m.down(); err != nil {
		return err
	}
	if m.people[org] == nil {
		m.people[org] = map[string]membership{}
	}
	m.people[org][p.UserID] = p
	return nil
}

func (m *memEngine) removeMember(_ context.Context, org, user string) error {
	delete(m.people[org], user)
	return m.down()
}

func (m *memEngine) setRole(_ context.Context, org string, r role) error {
	if err := m.down(); err != nil {
		return err
	}
	if m.roleDefs[org] == nil {
		m.roleDefs[org] = map[string]role{}
	}
	m.roleDefs[org][r.Key] = r
	return nil
}

func (m *memEngine) openWorkspace(ctx context.Context, org, owner, ownerRole string) error {
	if err := m.down(); err != nil {
		return err
	}
	if existing, ok := m.openOwner[org]; ok && existing != owner {
		return errAlreadyOpen
	}
	m.openOwner[org] = owner
	for _, p := range presets {
		_ = m.setRole(ctx, org, role{Key: p.key, Capabilities: p.capabilities, Scope: p.scope, SecondStep: p.secondStep})
	}
	return m.setMembership(ctx, org, membership{UserID: owner, Roles: []string{ownerRole}})
}

func (m *memEngine) setStanding(_ context.Context, org string, suspended, paymentRequired bool) error {
	m.standing[org] = [2]bool{suspended, paymentRequired}
	return m.down()
}

func (m *memEngine) setPlatformOwner(_ context.Context, user string) error {
	if m.staff[user] == "cofounder" {
		return errCofounderTaken
	}
	for other, role := range m.staff {
		if role == "owner" && other != user {
			return errOwnerTaken
		}
	}
	m.staff[user] = "owner"
	return m.down()
}

func (m *memEngine) setCofounder(_ context.Context, user string) error {
	for other, role := range m.staff {
		if role == "cofounder" && other != user {
			return errCofounderTaken
		}
	}
	if m.staff[user] == "owner" {
		return errOwnerTaken
	}
	m.staff[user] = "cofounder"
	return m.down()
}

func (m *memEngine) workspaces(_ context.Context, user string) ([]string, error) {
	var out []string
	for org, people := range m.people {
		if p, ok := people[user]; ok && len(p.Roles) > 0 {
			out = append(out, org)
		}
	}
	slices.Sort(out)
	return out, m.down()
}

func (m *memEngine) setStaff(_ context.Context, user, staffRole string) error {
	if m.staff[user] == "owner" || m.staff[user] == "cofounder" {
		return nil
	}
	if staffRole != "" && staffRole != "system_admin" && staffRole != "tester" {
		return errors.New("unknown platform role")
	}
	if staffRole == "" {
		delete(m.staff, user)
	} else {
		m.staff[user] = staffRole
	}
	return m.down()
}

const (
	coreToken    = "core-api-token-0123456789abcdef0123456789"
	authToken    = "auth-token-0123456789abcdef0123456789"
	billingToken = "billing-token-0123456789abcdef0123456789"
	gatewayToken = "gateway-token-0123456789abcdef0123456789"
	org1         = "11111111-1111-4111-8111-111111111111"
	ownerID      = "22222222-2222-4222-8222-222222222222"
	callerID     = "33333333-3333-4333-8333-333333333333"
	strangerID   = "44444444-4444-4444-8444-444444444444"
	team1        = "55555555-5555-4555-8555-555555555555"
)

type harness struct {
	t     *testing.T
	mem   *memEngine
	keys  *keys
	srv   *httptest.Server
	clock time.Time
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	k, err := generateKeys()
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, mem: newMem(), keys: k, clock: time.Unix(1_800_000_000, 0)}
	cfg := config{
		tokens:            map[string]string{coreToken: "core-api", authToken: "auth", billingToken: "billing", gatewayToken: "gateway"},
		grantSeconds:      60,
		requireSecondStep: true,
		staffSecondStep:   true,
	}
	s := &server{cfg: cfg, rules: h.mem, keys: k, now: func() time.Time { return h.clock }}
	h.srv = httptest.NewServer(s.handler())
	t.Cleanup(h.srv.Close)
	return h
}

// call sends a request as a calling service and decodes the JSON answer.
func (h *harness) call(token, method, path string, body any) (int, map[string]any) {
	h.t.Helper()
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, &buf)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

// opened is a workspace opened by ownerID, with callerID holding the caller role in team1.
func (h *harness) opened() {
	h.t.Helper()
	if code, out := h.call(coreToken, "PUT", "/v1/orgs/"+org1+"/owner", map[string]any{"user_id": ownerID}); code != 200 {
		h.t.Fatalf("open: %d %v", code, out)
	}
	code, out := h.call(coreToken, "PUT", "/v1/orgs/"+org1+"/members/"+callerID, map[string]any{
		"actor_id": ownerID, "actor_second_step": true, "roles": []string{"caller"}, "team_ids": []string{team1},
	})
	if code != 200 {
		h.t.Fatalf("add caller: %d %v", code, out)
	}
}

func (h *harness) grant(user, action string, secondStep bool) (int, map[string]any) {
	return h.call(coreToken, "POST", "/v1/grant", map[string]any{"user_id": user, "org_id": org1, "action": action, "second_step_passed": secondStep})
}
