package main

import (
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Support access. The owner lets Caller Whale's staff into the agency for a set time (24 hours by default), and can end
// it early (D83). Meanwhile the platform owner and cofounder, with their second step, open it as "support": they see its screens and
// can change its workspace rules to fix a problem, but cannot edit, export or delete leads, message anyone (so internal chats stay
// closed to them) or spend money (D202). Each visit goes into the agency's record of people changes, which the owner sees.

const (
	supportDefaultHours = 24
	supportMaxHours     = 72
	supportRecordEvery  = 10 * time.Minute // one record per staff member and agency in this time, however many requests they make
)

// supportFacts are the facts of a staff member in an agency that granted support access: everything visible, only the rules to change.
func supportFacts(f facts) facts {
	f.member = true
	f.roles = []string{"support"}
	f.scopes = []string{"organization"}
	f.capabilities = map[string]bool{"rules": true}
	f.secondStep = true
	f.memberSuspended = false
	return f
}

var supportSeen sync.Map // staff|org -> time of the last record

// asSupport turns a non-member's facts into support facts when the agency granted access and the person is the platform owner or
// cofounder (system admins are switched off for now); it records the visit.
func (s *server) asSupport(r *http.Request, user, org string, f facts) (facts, error) {
	if f.member {
		return f, nil
	}
	until, err := s.rules.supportUntil(r.Context(), org)
	if err != nil || until <= s.now().Unix() {
		return f, err
	}
	staff, err := s.rules.staffRole(r.Context(), user)
	if err != nil || (staff != "owner" && staff != "cofounder") {
		return f, err
	}
	key := user + "|" + org
	if last, ok := supportSeen.Load(key); !ok || s.now().Sub(last.(time.Time)) > supportRecordEvery {
		supportSeen.Store(key, s.now())
		s.record(r.Context(), org, user, "", "support_visited", nil, nil)
	}
	return supportFacts(f), nil
}

// putSupport answers PUT /v1/orgs/{org}/support {hours, actor_id} (the owner, through auth): staff may come in for that long.
// DELETE ends it. GET says until when.
func (s *server) putSupport(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	var body struct {
		Hours   int    `json:"hours"`
		ActorID string `json:"actor_id"`
	}
	if r.Method != http.MethodGet {
		if err := readJSON(w, r, &body); err != nil {
			return err
		}
	}
	switch r.Method {
	case http.MethodGet:
		until, err := s.rules.supportUntil(r.Context(), org)
		if err != nil {
			return store(err)
		}
		var shown any
		if until > s.now().Unix() {
			shown = until
		}
		writeJSON(w, http.StatusOK, map[string]any{"until": shown})
		return nil
	case http.MethodDelete:
		if err := store(s.rules.setSupport(r.Context(), org, nil, body.ActorID)); err != nil {
			return err
		}
		s.record(r.Context(), org, body.ActorID, "", "support_ended", nil, nil)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "until": nil})
		return nil
	}
	if body.Hours == 0 {
		body.Hours = supportDefaultHours
	}
	if body.Hours < 1 || body.Hours > supportMaxHours || !validID(body.ActorID) {
		return bad(fmt.Sprintf("Allow support for 1 to %d hours, and send actor_id.", supportMaxHours))
	}
	until := s.now().Unix() + int64(body.Hours)*3600
	if err := store(s.rules.setSupport(r.Context(), org, &until, body.ActorID)); err != nil {
		return err
	}
	s.record(r.Context(), org, body.ActorID, "", "support_granted", nil, map[string]any{"hours": body.Hours, "until": until})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "until": until})
	return nil
}

// supportList answers GET /v1/support: the agencies whose support access is open now, for the staff screen.
func (s *server) supportList(w http.ResponseWriter, r *http.Request) error {
	open, err := s.rules.supportOpen(r.Context(), s.now().Unix())
	if err != nil {
		return store(err)
	}
	out := []map[string]any{}
	for org, until := range open {
		_, name, _, err := s.rules.workspaceInfo(r.Context(), org)
		if err != nil {
			return store(err)
		}
		out = append(out, map[string]any{"org_id": org, "name": name, "until": until})
	}
	writeJSON(w, http.StatusOK, map[string]any{"agencies": out})
	return nil
}
