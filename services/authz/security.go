package main

// Build step 35, D238: the owner can require the second step (an authenticator) of everyone in the agency. It is the workspace's
// "mfa_everyone" switch; with it on, every member's grant asks for the second step, as owners' and admins' always do. A member without an
// authenticator is asked to set one up at their next sign-in before they can work.

import (
	"context"
	"net"
	"net/http"
	"slices"
	"strings"
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
			MFAEveryone *bool     `json:"mfa_everyone"`
			Countries   *[]string `json:"countries"` // two-letter codes; empty: anywhere (D243)
			Networks    *[]string `json:"networks"`  // office addresses or ranges (CIDR); empty: any network
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
		if body.Countries != nil || body.Networks != nil {
			countries, networks, err := s.rules.accessLimits(ctx, org)
			if err != nil {
				return store(err)
			}
			if body.Countries != nil {
				if countries, err = cleanCountries(*body.Countries); err != nil {
					return err
				}
			}
			if body.Networks != nil {
				if networks, err = cleanNetworks(*body.Networks); err != nil {
					return err
				}
			}
			if err := s.rules.setAccessLimits(ctx, org, countries, networks); err != nil {
				return store(err)
			}
		}
	}
	on, err := s.rules.features(ctx, org)
	if err != nil {
		return store(err)
	}
	countries, networks, err := s.rules.accessLimits(ctx, org)
	if err != nil {
		return store(err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"mfa_everyone": slices.Contains(on, mfaEveryone), "countries": nonNil(countries), "networks": nonNil(networks)})
	return nil
}

func cleanCountries(in []string) ([]string, error) {
	out := []string{}
	for _, c := range in {
		c = strings.ToUpper(strings.TrimSpace(c))
		if len(c) != 2 || c[0] < 'A' || c[0] > 'Z' || c[1] < 'A' || c[1] > 'Z' {
			return nil, bad("Countries are two-letter codes, like US.")
		}
		if !slices.Contains(out, c) {
			out = append(out, c)
		}
	}
	if len(out) > 50 {
		return nil, bad("Choose up to 50 countries.")
	}
	return out, nil
}

// cleanNetworks takes office addresses ("203.0.113.7") or ranges ("203.0.113.0/24") and keeps each as a range.
func cleanNetworks(in []string) ([]string, error) {
	out := []string{}
	for _, n := range in {
		n = strings.TrimSpace(n)
		if !strings.Contains(n, "/") {
			ip := net.ParseIP(n)
			if ip == nil {
				return nil, bad("Networks are addresses or ranges, like 203.0.113.7 or 203.0.113.0/24.")
			}
			if ip.To4() != nil {
				n += "/32"
			} else {
				n += "/128"
			}
		}
		_, cidr, err := net.ParseCIDR(n)
		if err != nil {
			return nil, bad("Networks are addresses or ranges, like 203.0.113.7 or 203.0.113.0/24.")
		}
		if ones, _ := cidr.Mask.Size(); (cidr.IP.To4() != nil && ones < 8) || (cidr.IP.To4() == nil && ones < 24) {
			return nil, bad("That range is too wide to be an office network.")
		}
		if !slices.Contains(out, cidr.String()) {
			out = append(out, cidr.String())
		}
	}
	if len(out) > 50 {
		return nil, bad("Choose up to 50 networks.")
	}
	return out, nil
}

// accessLimits is GET /v1/orgs/{org}/access-limits (the gateway): the agency's countries and networks, and who is never limited (its
// owner, so the agency can always be reached to change them).
func (s *server) accessLimits(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	countries, networks, err := s.rules.accessLimits(ctx, org)
	if err != nil {
		return store(err)
	}
	exempt := []string{}
	if len(countries) > 0 || len(networks) > 0 {
		members, err := s.rules.members(ctx, org)
		if err != nil {
			return store(err)
		}
		for _, m := range members {
			if slices.Contains(m.Roles, "owner") || slices.Contains(m.Roles, "solo") {
				exempt = append(exempt, m.UserID)
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"countries": nonNil(countries), "networks": nonNil(networks), "exempt": exempt})
	return nil
}
