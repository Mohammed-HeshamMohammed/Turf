package main

// Build step 35, D238: the owner can require the second step (an authenticator) of everyone in the agency. It is the workspace's
// "mfa_everyone" switch; with it on, every member's grant asks for the second step, as owners' and admins' always do. A member without an
// authenticator is asked to set one up at their next sign-in before they can work.

import (
	"context"
	"net/http"
	"slices"
)

const mfaEveryone = "mfa_everyone"

// everyoneNeedsSecondStep makes a member's facts ask for the second step when the agency requires it of everyone.
func (s *server) everyoneNeedsSecondStep(ctx context.Context, org string, f facts) (facts, error) {
	if !f.member || f.secondStep {
		return f, nil
	}
	on, err := s.rules.features(ctx, org)
	if err != nil {
		return f, err
	}
	f.secondStep = slices.Contains(on, mfaEveryone)
	return f, nil
}

// orgSecurity is GET /v1/orgs/{org}/security (whether everyone needs the second step) and PUT {actor_id, actor_second_step, mfa_everyone}
// (only the agency's owner, with their second step).
func (s *server) orgSecurity(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if r.Method == http.MethodPut {
		var body struct {
			actor
			MFAEveryone *bool `json:"mfa_everyone"`
		}
		if err := readJSON(w, r, &body); err != nil {
			return err
		}
		if err := s.mayManage(ctx, org, body.actor); err != nil {
			return err
		}
		f, err := s.rules.facts(ctx, body.ActorID, org)
		if err != nil {
			return store(err)
		}
		if !slices.Contains(f.roles, "owner") && !slices.Contains(f.roles, "solo") {
			return forbidden("Only the agency's owner changes who needs an authenticator.")
		}
		if body.MFAEveryone != nil {
			if err := s.rules.setFeature(ctx, org, mfaEveryone, *body.MFAEveryone); err != nil {
				return store(err)
			}
		}
	}
	on, err := s.rules.features(ctx, org)
	if err != nil {
		return store(err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"mfa_everyone": slices.Contains(on, mfaEveryone)})
	return nil
}
