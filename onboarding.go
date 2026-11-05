package main

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"
)

// What a person agrees to and tells us when they sign up, after the age check: the terms and privacy notice (by version, so a new
// version is asked again) and a few answers about their work, so Caller Whale can be set up to fit them.

// termsVersion names the terms and privacy notice people agree to. Change it when they change: everyone is asked again.
const termsVersion = "2026-11"

// Answers a person can give about their work. The website offers exactly these; anything else is refused.
var (
	workRoles = []string{
		"business_owner", // sells their own product or service
		"lead_buyer",     // a company or investor that calls to buy leads or properties
		"call_center",    // a call center or outreach team that calls for others
		"sales_team",     // an in-house sales team
		"solo_caller",    // works alone
		"data_provider",  // finds, cleans or sells contact data
		"other",
	}
	workTeamSizes = []string{"just_me", "2_10", "11_50", "51_plus"}
	workUses      = []string{"cold_calling", "buying_selling_leads", "managing_deals", "follow_ups", "skip_tracing", "team_reporting", "sms_email"}
)

type workProfile struct {
	Role     string   `json:"role"`
	TeamSize string   `json:"team_size"`
	Uses     []string `json:"uses"`
	Other    string   `json:"other"`
}

// cleanWorkProfile checks the answers and returns them tidied, or the reason they are not accepted.
func cleanWorkProfile(p workProfile) (workProfile, error) {
	if !slices.Contains(workRoles, p.Role) {
		return p, bad("Choose what describes you best.")
	}
	if !slices.Contains(workTeamSizes, p.TeamSize) {
		return p, bad("Choose your team size.")
	}
	seen := map[string]bool{}
	var uses []string
	for _, use := range p.Uses {
		if !slices.Contains(workUses, use) {
			return p, bad("Choose from the list of what you will use Caller Whale for.")
		}
		if !seen[use] {
			seen[use] = true
			uses = append(uses, use)
		}
	}
	if len(uses) == 0 {
		return p, bad("Choose at least one thing you will use Caller Whale for.")
	}
	other := strings.Join(strings.Fields(p.Other), " ")
	if utf8.RuneCountInString(other) > 200 {
		return p, bad("Describe your work in up to 200 characters.")
	}
	if p.Role == "other" && other == "" {
		return p, bad("Tell us a little about your work.")
	}
	return workProfile{Role: p.Role, TeamSize: p.TeamSize, Uses: uses, Other: other}, nil
}

// acceptTerms records that this person agreed to the current terms and privacy notice.
func (s *server) acceptTerms(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	var body struct {
		Version string `json:"version"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if body.Version != termsVersion {
		return bad("These terms have changed. Reload the page and read them again.")
	}
	if _, err := s.db.Exec(r.Context(), "UPDATE users SET terms_version = $1, terms_accepted_at = $2 WHERE id = $3", termsVersion, now(), c.Sub); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"terms_accepted": true})
	return nil
}

// setWorkProfile saves the person's answers about their work. It can be changed later from their profile.
func (s *server) setWorkProfile(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	var body workProfile
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	profile, err := cleanWorkProfile(body)
	if err != nil {
		return err
	}
	stored, err := json.Marshal(profile)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), "UPDATE users SET work_profile = $1, work_profile_at = $2 WHERE id = $3", string(stored), now(), c.Sub); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"work_profile": profile})
	return nil
}

// onboarding is what /v1/me tells about these steps: whether the current terms are accepted, and the work answers (null when none).
func (s *server) onboarding(r *http.Request, id string) (termsAccepted bool, profile *workProfile, err error) {
	var version, stored string
	var at int64
	if err = s.db.QueryRow(r.Context(), "SELECT terms_version, work_profile, work_profile_at FROM users WHERE id = $1", id).Scan(&version, &stored, &at); err != nil {
		return false, nil, err
	}
	termsAccepted = version == termsVersion
	if at > 0 && stored != "" {
		var p workProfile
		if json.Unmarshal([]byte(stored), &p) == nil {
			profile = &p
		}
	}
	return termsAccepted, profile, nil
}
