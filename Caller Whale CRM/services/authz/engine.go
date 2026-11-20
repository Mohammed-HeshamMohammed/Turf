package main

import (
	"context"
	"errors"
)

// role is a role's definition in one workspace. Display names stay with the core API's pages; the rules need only the key.
type role struct {
	Key          string   `json:"key"`
	Capabilities []string `json:"capabilities"`
	Scope        string   `json:"scope"`
	SecondStep   bool     `json:"second_step"`
}

// membership is one person's place in one workspace.
type membership struct {
	UserID       string   `json:"user_id"`
	Roles        []string `json:"roles"`
	Restrictions []string `json:"restrictions"`
	TeamIDs      []string `json:"team_ids"`
	ProjectIDs   []string `json:"project_ids"`
	// Set while the person is suspended: they keep their place, but every grant is refused.
	SuspendedAt     *int64 `json:"suspended_at,omitempty"`
	SuspendedBy     string `json:"suspended_by,omitempty"`
	SuspendedReason string `json:"suspended_reason,omitempty"`
}

type staffMember struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"`
}

var errAlreadyOpen = errors.New("this workspace already has an owner")

// engine is the rules store (PostgreSQL in production, memEngine in tests). Every method is one consistent read or one atomic
// write there.
type engine interface {
	facts(ctx context.Context, user, org string) (facts, error)
	staffRole(ctx context.Context, user string) (string, error)
	staffMembers(ctx context.Context) ([]staffMember, error)
	check(ctx context.Context, user, org, permission string) (bool, error)
	roles(ctx context.Context, org string) ([]role, error)
	membership(ctx context.Context, org, user string) (membership, bool, error)
	members(ctx context.Context, org string) ([]membership, error)
	setMembership(ctx context.Context, org string, m membership) error
	removeMember(ctx context.Context, org, user string) error
	setRole(ctx context.Context, org string, r role) error
	openWorkspace(ctx context.Context, org, owner, ownerRole string) error
	// setOwner records a new owner of an open workspace (a handover, step 13); their roles are set with setMembership.
	setOwner(ctx context.Context, org, owner string) error
	// setWorkspaceName keeps the agency's name as the CRM shows it, so invitations can say which agency they come from.
	setWorkspaceName(ctx context.Context, org, name string) error
	// workspaceInfo is a workspace's owner and name; found is false when it was never opened.
	workspaceInfo(ctx context.Context, org string) (owner, name string, found bool, err error)
	// features are the workspace's switches that are on (D104); setFeature turns one on or off.
	features(ctx context.Context, org string) ([]string, error)
	setFeature(ctx context.Context, org, name string, on bool) error
	// accessLimits are the countries and networks the agency's members may work from (step 35, D243); empty: anywhere.
	accessLimits(ctx context.Context, org string) (countries, networks []string, err error)
	setAccessLimits(ctx context.Context, org string, countries, networks []string) error
	// logPeople records one change to people; peopleLog reads the newest first, older entries than two years are dropped.
	logPeople(ctx context.Context, org string, e peopleEntry) error
	peopleLog(ctx context.Context, org string, since int64, limit int) ([]peopleEntry, error)
	// adminLimit is how many admins the workspace may have when staff changed it (nil: the default).
	adminLimit(ctx context.Context, org string) (*int, error)
	setStanding(ctx context.Context, org string, change standingChange) error
	// standingOf is the agency's plan stage and pause (step 18).
	standingOf(ctx context.Context, org string) (standingView, error)
	// Support access (step 19): until when staff may come in (0: not open), set or ended (nil) by the owner, and every agency open now.
	supportUntil(ctx context.Context, org string) (int64, error)
	setSupport(ctx context.Context, org string, until *int64, by string) error
	supportOpen(ctx context.Context, now int64) (map[string]int64, error)
	// seatLimits is how many seats and client places the workspace has (nil: unlimited).
	seatLimits(ctx context.Context, org string) (seats, clients *int, err error)
	teams(ctx context.Context, org string) ([]team, error)
	setTeam(ctx context.Context, org string, t team) error
	removeTeam(ctx context.Context, org, teamID string) error
	// setSuspension suspends (at set) or restores (at nil) a member.
	setSuspension(ctx context.Context, org, user string, at *int64, by, reason string) error
	setStaff(ctx context.Context, user, staffRole string) error
	// setPlatformOwner makes someone the Caller Whale owner. It does nothing when they already are, and refuses when someone else is.
	setPlatformOwner(ctx context.Context, user string) error
	setCofounder(ctx context.Context, user string) error
	// workspaces lists the workspaces a person belongs to.
	workspaces(ctx context.Context, user string) ([]string, error)
}

var errOwnerTaken = errors.New("Caller Whale already has an owner")
var errCofounderTaken = errors.New("Caller Whale already has a cofounder")

// checkable are the names /v1/check answers for, besides the capabilities.
var checkable = []string{"member", "manage_access", "staff", "manage_staff", "tester"}
