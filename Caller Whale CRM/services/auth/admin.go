package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type adminStaffMember struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"`
}

func (s *server) staffActor(r *http.Request, manage bool) (claims, error) {
	c, err := s.person(r)
	if err != nil {
		return claims{}, err
	}
	if !c.MFA {
		return claims{}, newError(http.StatusForbidden, "mfa_required", "Confirm your identity with a second step first.")
	}
	if s.cfg.authzURL == "" || s.cfg.authzToken == "" {
		return claims{}, errAccessUnavailable
	}
	profile, err := readAccess(r.Context(), s.cfg.authzURL, s.cfg.authzToken, c.Sub)
	if err != nil {
		return claims{}, errAccessUnavailable
	}
	if manage && profile.PlatformRole != "owner" && profile.PlatformRole != "cofounder" {
		return claims{}, forbidden("Only the platform owner or cofounder can manage staff.")
	}
	// system_admin is switched off for now (authz disabledRoles).
	if !manage && profile.PlatformRole != "owner" && profile.PlatformRole != "cofounder" {
		return claims{}, forbidden("This dashboard is for Caller Whale staff.")
	}
	return c, nil
}

func (s *server) adminStaff(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, false); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, s.cfg.authzURL+"/v1/staff", nil)
	if err != nil {
		return errAccessUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.authzToken)
	res, err := (&http.Client{Timeout: 4 * time.Second}).Do(req)
	if err != nil {
		return errAccessUnavailable
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return errAccessUnavailable
	}
	var listed struct {
		Staff []adminStaffMember `json:"staff"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&listed); err != nil {
		return errAccessUnavailable
	}
	staff := []map[string]string{}
	for _, member := range listed.Staff {
		var email, name string
		if err := s.db.QueryRow(r.Context(), "SELECT email, display_name FROM users WHERE id = $1", member.UserID).Scan(&email, &name); errors.Is(err, pgx.ErrNoRows) {
			// Bootstrap roles can refer to an account that has not yet signed in here.
			staff = append(staff, map[string]string{"role": member.Role, "name": "Account not found in auth"})
			continue
		} else if err != nil {
			return err
		}
		staff = append(staff, map[string]string{"role": member.Role, "name": name, "email": email})
	}
	writeJSON(w, http.StatusOK, map[string]any{"staff": staff})
	return nil
}

func (s *server) assignStaff(w http.ResponseWriter, r *http.Request) error {
	c, err := s.ownerActor(r)
	if err != nil {
		return err
	}
	var body struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	body.Email = strings.ToLower(strings.TrimSpace(body.Email))
	if body.Email == "" || (body.Role != "" && body.Role != "system_admin" && body.Role != "tester") {
		return bad("Choose an account email and a staff role.")
	}
	var target string
	if err := s.db.QueryRow(r.Context(), "SELECT id FROM users WHERE email = $1 AND disabled_at IS NULL", body.Email).Scan(&target); errors.Is(err, pgx.ErrNoRows) {
		return newError(http.StatusNotFound, "account_not_found", "That account has not signed in to Caller Whale yet.")
	} else if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{"actor_id": c.Sub, "actor_second_step": c.MFA, "role": body.Role})
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPut, s.cfg.authzURL+"/v1/staff/"+target, bytes.NewReader(payload))
	if err != nil {
		return errAccessUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.authzToken)
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 4 * time.Second}).Do(req)
	if err != nil {
		return errAccessUnavailable
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusForbidden {
		return forbidden("That staff role cannot be changed.")
	}
	if res.StatusCode != http.StatusOK {
		return errAccessUnavailable
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}
