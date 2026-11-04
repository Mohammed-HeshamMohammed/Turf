package main

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	"github.com/authzed/authzed-go/v1"
	"github.com/authzed/grpcutil"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

//go:embed schema.zed
var schemaText string

// platformID is the one platform object: Caller Whale's own staff.
const platformID = "callerwhale"

// spice is the rules store in SpiceDB. Every read is fully consistent, so a removed person loses access at once.
type spice struct {
	client *authzed.Client
}

var fullyConsistent = &v1.Consistency{Requirement: &v1.Consistency_FullyConsistent{FullyConsistent: true}}

func newSpice(cfg config) (*spice, error) {
	var opts []grpc.DialOption
	if cfg.spicedbTLS {
		certs, err := grpcutil.WithSystemCerts(grpcutil.VerifyCA)
		if err != nil {
			return nil, err
		}
		opts = append(opts, certs, grpcutil.WithBearerToken(cfg.spicedbKey))
	} else {
		// On the private Docker network only: SpiceDB has no public address.
		opts = append(opts, grpc.WithTransportCredentials(insecure.NewCredentials()), grpcutil.WithInsecureBearerToken(cfg.spicedbKey))
	}
	client, err := authzed.NewClient(cfg.spicedbEndpoint, opts...)
	if err != nil {
		return nil, err
	}
	return &spice{client: client}, nil
}

// writeSchema puts schema.zed in place, waiting up to a minute for SpiceDB to come up after a restart of both.
func (s *spice) writeSchema(ctx context.Context) error {
	var err error
	for wait := time.Second; wait <= 16*time.Second; wait *= 2 {
		if _, err = s.client.WriteSchema(ctx, &v1.WriteSchemaRequest{Schema: schemaText}); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
	return fmt.Errorf("the rules store did not take the schema: %w", err)
}

func obj(kind, id string) *v1.ObjectReference {
	return &v1.ObjectReference{ObjectType: kind, ObjectId: id}
}
func subject(kind, id string) *v1.SubjectReference {
	return &v1.SubjectReference{Object: obj(kind, id)}
}
func everyone() *v1.SubjectReference { return subject("user", "*") }
func rel(resource *v1.ObjectReference, relation string, sub *v1.SubjectReference) *v1.Relationship {
	return &v1.Relationship{Resource: resource, Relation: relation, Subject: sub}
}
func touch(r *v1.Relationship) *v1.RelationshipUpdate {
	return &v1.RelationshipUpdate{Operation: v1.RelationshipUpdate_OPERATION_TOUCH, Relationship: r}
}
func drop(r *v1.Relationship) *v1.RelationshipUpdate {
	return &v1.RelationshipUpdate{Operation: v1.RelationshipUpdate_OPERATION_DELETE, Relationship: r}
}

func (s *spice) write(ctx context.Context, updates []*v1.RelationshipUpdate) error {
	if len(updates) == 0 {
		return nil
	}
	_, err := s.client.WriteRelationships(ctx, &v1.WriteRelationshipsRequest{Updates: updates})
	return err
}

// read lists the relationships matching a filter.
func (s *spice) read(ctx context.Context, filter *v1.RelationshipFilter) ([]*v1.Relationship, error) {
	stream, err := s.client.ReadRelationships(ctx, &v1.ReadRelationshipsRequest{Consistency: fullyConsistent, RelationshipFilter: filter})
	if err != nil {
		return nil, err
	}
	var out []*v1.Relationship
	for {
		res, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		out = append(out, res.Relationship)
	}
}

// lookup lists the ids of the objects of one kind the person has a permission on, inside one workspace.
func (s *spice) lookup(ctx context.Context, kind, permission, user, org string) ([]string, error) {
	stream, err := s.client.LookupResources(ctx, &v1.LookupResourcesRequest{
		Consistency: fullyConsistent, ResourceObjectType: kind, Permission: permission, Subject: subject("user", user),
	})
	if err != nil {
		return nil, err
	}
	prefix := org + "/"
	var ids []string
	for {
		res, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			return ids, nil
		}
		if err != nil {
			return nil, err
		}
		if id, ok := strings.CutPrefix(res.ResourceObjectId, prefix); ok {
			ids = append(ids, id)
		}
	}
}

// bulk checks several permissions for one person on one object, in one request.
func (s *spice) bulk(ctx context.Context, resource *v1.ObjectReference, user string, permissions []string) (map[string]bool, error) {
	items := make([]*v1.CheckBulkPermissionsRequestItem, len(permissions))
	for i, p := range permissions {
		items[i] = &v1.CheckBulkPermissionsRequestItem{Resource: resource, Permission: p, Subject: subject("user", user)}
	}
	res, err := s.client.CheckBulkPermissions(ctx, &v1.CheckBulkPermissionsRequest{Consistency: fullyConsistent, Items: items})
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, pair := range res.Pairs {
		switch r := pair.Response.(type) {
		case *v1.CheckBulkPermissionsPair_Item:
			out[pair.Request.Permission] = r.Item.Permissionship == v1.CheckPermissionResponse_PERMISSIONSHIP_HAS_PERMISSION
		case *v1.CheckBulkPermissionsPair_Error:
			return nil, fmt.Errorf("checking %s: %s", pair.Request.Permission, r.Error.GetMessage())
		}
	}
	return out, nil
}

func (s *spice) facts(ctx context.Context, user, org string) (facts, error) {
	names := []string{"member", "second_step", "is_suspended", "needs_payment"}
	for _, c := range capabilities {
		names = append(names, "cap_"+schemaName(c))
	}
	for _, sc := range scopes {
		names = append(names, "scope_"+sc)
	}
	has, err := s.bulk(ctx, obj("organization", org), user, names)
	if err != nil {
		return facts{}, err
	}
	f := facts{member: has["member"], secondStep: has["second_step"], suspended: has["is_suspended"], paymentRequired: has["needs_payment"], capabilities: map[string]bool{}}
	for _, c := range capabilities {
		f.capabilities[c] = has["cap_"+schemaName(c)]
	}
	for _, sc := range scopes {
		if has["scope_"+sc] {
			f.scopes = append(f.scopes, sc)
		}
	}
	if !f.member {
		return f, nil
	}
	if f.teams, err = s.lookup(ctx, "team", "belongs", user, org); err != nil {
		return facts{}, err
	}
	if f.projects, err = s.lookup(ctx, "project", "belongs", user, org); err != nil {
		return facts{}, err
	}
	return f, nil
}

func (s *spice) staffRole(ctx context.Context, user string) (string, error) {
	has, err := s.bulk(ctx, obj("platform", platformID), user, []string{"is_owner", "is_admin"})
	switch {
	case err != nil:
		return "", err
	case has["is_owner"]:
		return "owner", nil
	case has["is_admin"]:
		return "admin", nil
	}
	return "", nil
}

func (s *spice) check(ctx context.Context, user, org, permission string) (bool, error) {
	resource, name := obj("organization", org), permission
	switch {
	case permission == "staff" || permission == "manage_staff":
		resource = obj("platform", platformID)
	case slices.Contains(capabilities, permission):
		name = "cap_" + schemaName(permission)
	}
	has, err := s.bulk(ctx, resource, user, []string{name})
	return has[name], err
}

// grantRelations are a role's flags in the store, by the capability or scope they stand for.
func grantRelations(r role) []string {
	var out []string
	for _, c := range r.Capabilities {
		out = append(out, "grants_"+schemaName(c))
	}
	if r.Scope != "" && r.Scope != "none" {
		out = append(out, "scope_"+r.Scope)
	}
	if r.SecondStep {
		out = append(out, "second_step")
	}
	if slices.Contains(heldRoles, r.Key) {
		out = append(out, "manages_access")
	}
	return out
}

func (s *spice) roles(ctx context.Context, org string) ([]role, error) {
	rels, err := s.read(ctx, &v1.RelationshipFilter{ResourceType: "role", OptionalResourceIdPrefix: org + "/", OptionalSubjectFilter: &v1.SubjectFilter{SubjectType: "user", OptionalSubjectId: "*"}})
	if err != nil {
		return nil, err
	}
	byKey := map[string]*role{}
	var keys []string
	for _, r := range rels {
		key := strings.TrimPrefix(r.Resource.ObjectId, org+"/")
		if byKey[key] == nil {
			byKey[key] = &role{Key: key, Capabilities: []string{}, Scope: "none"}
			keys = append(keys, key)
		}
		switch name := r.Relation; {
		case strings.HasPrefix(name, "grants_"):
			c := strings.TrimPrefix(name, "grants_")
			if c == "public_comment" {
				c = "publicComment"
			}
			byKey[key].Capabilities = append(byKey[key].Capabilities, c)
		case strings.HasPrefix(name, "scope_"):
			byKey[key].Scope = strings.TrimPrefix(name, "scope_")
		case name == "second_step":
			byKey[key].SecondStep = true
		}
	}
	slices.Sort(keys)
	out := make([]role, 0, len(keys))
	for _, k := range keys {
		r := *byKey[k]
		r.Capabilities = orderCapabilities(r.Capabilities)
		out = append(out, r)
	}
	return out, nil
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

// relationsOf are every relationship that makes up one person's membership in one workspace.
func membershipRelations(org string, m membership) []*v1.Relationship {
	user := subject("user", m.UserID)
	var out []*v1.Relationship
	for _, r := range m.Roles {
		out = append(out, rel(obj("role", org+"/"+r), "member", user))
	}
	for _, r := range m.Restrictions {
		name := "without_" + schemaName(r)
		if sc, ok := strings.CutPrefix(r, "scope:"); ok {
			name = "without_scope_" + sc
		}
		out = append(out, rel(obj("organization", org), name, user))
	}
	for _, t := range m.TeamIDs {
		out = append(out, rel(obj("team", org+"/"+t), "member", user))
	}
	for _, p := range m.ProjectIDs {
		out = append(out, rel(obj("project", org+"/"+p), "member", user))
	}
	return out
}

func (s *spice) membership(ctx context.Context, org, user string) (membership, bool, error) {
	all, err := s.readMembers(ctx, org, user)
	if err != nil {
		return membership{}, false, err
	}
	m, ok := all[user]
	if !ok {
		return membership{UserID: user, Roles: []string{}, Restrictions: []string{}, TeamIDs: []string{}, ProjectIDs: []string{}}, false, nil
	}
	return *m, len(m.Roles) > 0, nil
}

func (s *spice) members(ctx context.Context, org string) ([]membership, error) {
	all, err := s.readMembers(ctx, org, "")
	if err != nil {
		return nil, err
	}
	out := []membership{}
	for _, m := range all {
		if len(m.Roles) > 0 {
			out = append(out, *m)
		}
	}
	slices.SortFunc(out, func(a, b membership) int { return strings.Compare(a.UserID, b.UserID) })
	return out, nil
}

// readMembers reads roles, restrictions, teams and projects in a workspace, for one person or (user "") everyone.
func (s *spice) readMembers(ctx context.Context, org, user string) (map[string]*membership, error) {
	people := &v1.SubjectFilter{SubjectType: "user", OptionalSubjectId: user}
	all := map[string]*membership{}
	get := func(id string) *membership {
		if all[id] == nil {
			all[id] = &membership{UserID: id, Roles: []string{}, Restrictions: []string{}, TeamIDs: []string{}, ProjectIDs: []string{}}
		}
		return all[id]
	}
	for _, kind := range []string{"role", "team", "project"} {
		rels, err := s.read(ctx, &v1.RelationshipFilter{ResourceType: kind, OptionalResourceIdPrefix: org + "/", OptionalRelation: "member", OptionalSubjectFilter: people})
		if err != nil {
			return nil, err
		}
		for _, r := range rels {
			id, m := strings.TrimPrefix(r.Resource.ObjectId, org+"/"), get(r.Subject.Object.ObjectId)
			switch kind {
			case "role":
				m.Roles = append(m.Roles, id)
			case "team":
				m.TeamIDs = append(m.TeamIDs, id)
			case "project":
				m.ProjectIDs = append(m.ProjectIDs, id)
			}
		}
	}
	rels, err := s.read(ctx, &v1.RelationshipFilter{ResourceType: "organization", OptionalResourceId: org, OptionalSubjectFilter: people})
	if err != nil {
		return nil, err
	}
	for _, r := range rels {
		name, ok := strings.CutPrefix(r.Relation, "without_")
		if !ok || r.Subject.Object.ObjectId == "*" {
			continue
		}
		if sc, isScope := strings.CutPrefix(name, "scope_"); isScope {
			name = "scope:" + sc
		} else if name == "public_comment" {
			name = "publicComment"
		}
		m := get(r.Subject.Object.ObjectId)
		m.Restrictions = append(m.Restrictions, name)
	}
	for _, m := range all {
		slices.Sort(m.Roles)
		slices.Sort(m.Restrictions)
		slices.Sort(m.TeamIDs)
		slices.Sort(m.ProjectIDs)
	}
	return all, nil
}

// replace writes, in one atomic change, the relationships in "want" and removes those in "have" that are not wanted.
func replace(have, want []*v1.Relationship) []*v1.RelationshipUpdate {
	key := func(r *v1.Relationship) string {
		return r.Resource.ObjectType + ":" + r.Resource.ObjectId + "#" + r.Relation + "@" + r.Subject.Object.ObjectType + ":" + r.Subject.Object.ObjectId
	}
	wanted := map[string]bool{}
	var updates []*v1.RelationshipUpdate
	for _, r := range want {
		wanted[key(r)] = true
		updates = append(updates, touch(r))
	}
	for _, r := range have {
		if !wanted[key(r)] {
			updates = append(updates, drop(r))
		}
	}
	return updates
}

func (s *spice) setMembership(ctx context.Context, org string, m membership) error {
	current, _, err := s.membership(ctx, org, m.UserID)
	if err != nil {
		return err
	}
	want := membershipRelations(org, m)
	for _, t := range m.TeamIDs {
		want = append(want, rel(obj("team", org+"/"+t), "organization", subject("organization", org)))
	}
	for _, p := range m.ProjectIDs {
		want = append(want, rel(obj("project", org+"/"+p), "organization", subject("organization", org)))
	}
	return s.write(ctx, replace(membershipRelations(org, current), want))
}

func (s *spice) removeMember(ctx context.Context, org, user string) error {
	current, _, err := s.membership(ctx, org, user)
	if err != nil {
		return err
	}
	return s.write(ctx, replace(membershipRelations(org, current), nil))
}

func roleRelations(org string, r role) []*v1.Relationship {
	id := obj("role", org+"/"+r.Key)
	out := []*v1.Relationship{rel(obj("organization", org), "role", subject("role", org+"/"+r.Key))}
	for _, name := range grantRelations(r) {
		out = append(out, rel(id, name, everyone()))
	}
	return out
}

func (s *spice) setRole(ctx context.Context, org string, r role) error {
	have, err := s.read(ctx, &v1.RelationshipFilter{ResourceType: "role", OptionalResourceId: org + "/" + r.Key, OptionalSubjectFilter: &v1.SubjectFilter{SubjectType: "user", OptionalSubjectId: "*"}})
	if err != nil {
		return err
	}
	return s.write(ctx, replace(have, roleRelations(org, r)))
}

func (s *spice) openWorkspace(ctx context.Context, org, owner, ownerRole string) error {
	for _, held := range heldRoles {
		rels, err := s.read(ctx, &v1.RelationshipFilter{ResourceType: "role", OptionalResourceId: org + "/" + held, OptionalRelation: "member"})
		if err != nil {
			return err
		}
		for _, r := range rels {
			if r.Subject.Object.ObjectId != owner {
				return errAlreadyOpen
			}
		}
	}
	var updates []*v1.RelationshipUpdate
	for _, p := range presets {
		for _, r := range roleRelations(org, role{Key: p.key, Capabilities: p.capabilities, Scope: p.scope, SecondStep: p.secondStep}) {
			updates = append(updates, touch(r))
		}
	}
	updates = append(updates,
		touch(rel(obj("organization", org), "platform", subject("platform", platformID))),
		touch(rel(obj("role", org+"/"+ownerRole), "member", subject("user", owner))),
	)
	return s.write(ctx, updates)
}

func (s *spice) setStanding(ctx context.Context, org string, suspended, paymentRequired bool) error {
	flag := func(on bool, relation string) *v1.RelationshipUpdate {
		r := rel(obj("organization", org), relation, everyone())
		if on {
			return touch(r)
		}
		return drop(r)
	}
	return s.write(ctx, []*v1.RelationshipUpdate{flag(suspended, "suspended"), flag(paymentRequired, "payment_required")})
}

func (s *spice) setStaff(ctx context.Context, user, staffRole string) error {
	updates := []*v1.RelationshipUpdate{drop(rel(obj("platform", platformID), "admin", subject("user", user)))}
	if staffRole != "" {
		updates = []*v1.RelationshipUpdate{touch(rel(obj("platform", platformID), staffRole, subject("user", user)))}
	}
	return s.write(ctx, updates)
}
