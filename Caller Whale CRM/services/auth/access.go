package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

type workspaceAccess struct {
	OrgID         string   `json:"org_id"`
	Roles         []string `json:"roles"`
	BusinessOwner bool     `json:"business_owner"`
}

type accessProfile struct {
	UserID        string            `json:"user_id"`
	PlatformRole  string            `json:"platform_role"`
	PlatformLabel string            `json:"platform_label,omitempty"`
	Workspaces    []workspaceAccess `json:"workspaces"`
}

var errAccessUnavailable = errors.New("authorization profile unavailable")

func readAccess(ctx context.Context, base, token, userID string) (accessProfile, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/v1/people/"+userID, nil)
	if err != nil {
		return accessProfile{}, errAccessUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := (&http.Client{Timeout: 4 * time.Second}).Do(req)
	if err != nil {
		return accessProfile{}, errAccessUnavailable
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return accessProfile{}, errAccessUnavailable
	}
	var profile accessProfile
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&profile); err != nil || profile.UserID != userID {
		return accessProfile{}, errAccessUnavailable
	}
	if profile.Workspaces == nil {
		profile.Workspaces = []workspaceAccess{}
	}
	return profile, nil
}

// meAccess reads only the signed-in person's own membership and platform role.
// The authz machine token stays on this server, never in browser code.
func (s *server) meAccess(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	unavailable := newError(http.StatusServiceUnavailable, "access_unavailable", "Membership information is unavailable right now.")
	if s.cfg.authzURL == "" || s.cfg.authzToken == "" {
		return unavailable
	}
	profile, err := readAccess(r.Context(), s.cfg.authzURL, s.cfg.authzToken, c.Sub)
	if err != nil {
		return unavailable
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"platform_role":  profile.PlatformRole,
		"platform_label": profile.PlatformLabel,
		"workspaces":     profile.Workspaces,
	})
	return nil
}
