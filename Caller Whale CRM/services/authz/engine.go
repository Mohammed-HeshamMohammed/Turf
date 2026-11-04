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
}

var errAlreadyOpen = errors.New("this workspace already has an owner")

// engine is the rules store (SpiceDB in production, memEngine in tests). Every method is one consistent read or one atomic
// write there.
type engine interface {
	facts(ctx context.Context, user, org string) (facts, error)
	staffRole(ctx context.Context, user string) (string, error)
	check(ctx context.Context, user, org, permission string) (bool, error)
	roles(ctx context.Context, org string) ([]role, error)
	membership(ctx context.Context, org, user string) (membership, bool, error)
	members(ctx context.Context, org string) ([]membership, error)
	setMembership(ctx context.Context, org string, m membership) error
	removeMember(ctx context.Context, org, user string) error
	setRole(ctx context.Context, org string, r role) error
	openWorkspace(ctx context.Context, org, owner, ownerRole string) error
	setStanding(ctx context.Context, org string, suspended, paymentRequired bool) error
	setStaff(ctx context.Context, user, staffRole string) error
	// setPlatformOwner makes someone the Caller Whale owner. It does nothing when they already are, and refuses when someone else is.
	setPlatformOwner(ctx context.Context, user string) error
	// workspaces lists the workspaces a person belongs to.
	workspaces(ctx context.Context, user string) ([]string, error)
}

var errOwnerTaken = errors.New("Caller Whale already has an owner")

// checkable are the names /v1/check answers for, besides the capabilities.
var checkable = []string{"member", "manage_access", "staff", "manage_staff"}
