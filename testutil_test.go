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
	standing  map[string][3]bool               // org -> suspended, payment required, paused
	staff     map[string]string                // user -> platform role
	failNext  bool
	openOwner map[string]string
	teamsBy   map[string][]team  // org -> teams
	limits    map[string][2]*int // org -> seats, clients
	names     map[string]string  // org -> agency name
	switches  map[string][]string
	admins    map[string]*int
	log       map[string][]peopleEntry
	logID     int64
}

func newMem() *memEngine {
	return &memEngine{roleDefs: map[string]map[string]role{}, people: map[string]map[string]membership{}, standing: map[string][3]bool{}, staff: map[string]string{}, openOwner: map[string]string{}, teamsBy: map[string][]team{}, limits: map[string][2]*int{}, names: map[string]string{}, switches: map[string][]string{}, admins: map[string]*int{}, log: map[string][]peopleEntry{}}
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
	f.suspended, f.paymentRequired, f.paused = st[0], st[1], st[2]
	p, ok := m.people[org][user]
	if !ok || len(p.Roles) == 0 {
		return f, nil
	}
	f.member = true
	f.memberSuspended = p.SuspendedAt != nil
	f.roles = activeRoles(p.Roles)
	for _, t := range m.teamsBy[org] {
		t = memTeam(t)
		if slices.Contains(t.ManagerIDs, user) {
			f.managed = append(f.managed, t.TeamID)
		}
		if slices.Contains(t.DeputyIDs, user) {
			f.deputyOf = append(f.deputyOf, t.TeamID)
		}
	}
	scopeSet := map[string]bool{}
	ownTeamScope := false
	for _, key := range f.roles {
		r := m.roleDefs[org][key]
		for _, c := range r.Capabilities {
			f.capabilities[c] = true
		}
		if r.Scope != "none" && r.Scope != "" {
			scopeSet[r.Scope] = true
		}
		ownTeamScope = ownTeamScope || (r.Scope == "team" && key != "manager")
		f.secondStep = f.secondStep || r.SecondStep
	}
	settleScopes(&f, scopeSet, p.Restrictions, p.TeamIDs, ownTeamScope)
	f.projects = p.ProjectIDs
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
		return m.staff[user] == "owner" || m.staff[user] == "cofounder", m.down()
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
		return m.staff[user] == "owner" || m.staff[user] == "cofounder" || slices.ContainsFunc(p.Roles, func(r string) bool { return slices.Contains(heldRoles, r) }), nil
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
	if old, ok := m.people[org][p.UserID]; ok {
		p.SuspendedAt, p.SuspendedBy, p.SuspendedReason = old.SuspendedAt, old.SuspendedBy, old.SuspendedReason
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

func (m *memEngine) setStanding(_ context.Context, org string, c standingChange) error {
	st := m.standing[org]
	if c.Suspended != nil {
		st[0] = *c.Suspended
	}
	if c.PaymentRequired != nil {
		st[1] = *c.PaymentRequired
	}
	if c.Paused != nil {
		st[2] = *c.Paused
	}
	m.standing[org] = st
	l := m.limits[org]
	if c.SeatsSet {
		l[0] = c.Seats
	}
	if c.ClientsSet {
		l[1] = c.Clients
	}
	m.limits[org] = l
	return m.down()
}

func (m *memEngine) setWorkspaceName(_ context.Context, org, name string) error {
	if _, ok := m.openOwner[org]; ok {
		m.names[org] = name
	}
	return m.down()
}

func (m *memEngine) setOwner(_ context.Context, org, owner string) error {
	m.openOwner[org] = owner
	return m.down()
}

func (m *memEngine) workspaceInfo(_ context.Context, org string) (string, string, bool, error) {
	owner, ok := m.openOwner[org]
	return owner, m.names[org], ok, m.down()
}

func (m *memEngine) seatLimits(_ context.Context, org string) (*int, *int, error) {
	l := m.limits[org]
	return l[0], l[1], m.down()
}

// memTeam reads a team written by an older test with only ManagerID as having that one lead.
func memTeam(t team) team {
	if len(t.ManagerIDs) == 0 && t.ManagerID != "" {
		t.ManagerIDs = []string{t.ManagerID}
	}
	t.ManagerIDs, t.DeputyIDs = slices.Clone(t.ManagerIDs), slices.Clone(t.DeputyIDs)
	t.settle()
	return t
}

func (m *memEngine) teams(_ context.Context, org string) ([]team, error) {
	out := []team{}
	for _, t := range m.teamsBy[org] {
		out = append(out, memTeam(t))
	}
	return out, m.down()
}

func (m *memEngine) features(_ context.Context, org string) ([]string, error) {
	return slices.Clone(m.switches[org]), m.down()
}

func (m *memEngine) setFeature(_ context.Context, org, name string, on bool) error {
	m.switches[org] = slices.DeleteFunc(m.switches[org], func(s string) bool { return s == name })
	if on {
		m.switches[org] = append(m.switches[org], name)
	}
	return m.down()
}

func (m *memEngine) adminLimit(_ context.Context, org string) (*int, error) {
	return m.admins[org], m.down()
}

func (m *memEngine) setTeam(_ context.Context, org string, t team) error {
	t = memTeam(t)
	for i, old := range m.teamsBy[org] {
		if old.TeamID == t.TeamID {
			m.teamsBy[org][i] = t
			return m.down()
		}
	}
	m.teamsBy[org] = append(m.teamsBy[org], t)
	return m.down()
}

func (m *memEngine) removeTeam(_ context.Context, org, teamID string) error {
	m.teamsBy[org] = slices.DeleteFunc(m.teamsBy[org], func(t team) bool { return t.TeamID == teamID })
	return m.down()
}

func (m *memEngine) setSuspension(_ context.Context, org, user string, at *int64, by, reason string) error {
	p, ok := m.people[org][user]
	if !ok {
		return m.down()
	}
	p.SuspendedAt, p.SuspendedBy, p.SuspendedReason = at, by, reason
	m.people[org][user] = p
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
	if code, out := h.call(coreToken, "PUT", "/v1/orgs/"+org1+"/teams/"+team1, map[string]any{"actor_id": ownerID, "actor_second_step": true, "name": "Team one"}); code != 200 {
		h.t.Fatalf("team: %d %v", code, out)
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

func (m *memEngine) logPeople(_ context.Context, org string, e peopleEntry) error {
	m.logID++
	e.ID = m.logID
	m.log[org] = append([]peopleEntry{e}, m.log[org]...)
	return m.down()
}

func (m *memEngine) peopleLog(_ context.Context, org string, since int64, limit int) ([]peopleEntry, error) {
	out := []peopleEntry{}
	for _, e := range m.log[org] {
		if e.At >= since && len(out) < limit {
			out = append(out, e)
		}
	}
	return out, m.down()
}
