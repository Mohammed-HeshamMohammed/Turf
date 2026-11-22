package main

// Limits on AI.
//
//   - An outside AI (ChatGPT, Claude, Gemini) connected through MCP with the team:manage permission can read the people and teams of the
//     person's agency, within the person's own rights. Inviting, removing, changing roles, deleting a team and cancelling an invitation
//     are only requested: the person confirms each inside Caller Whale, and it is then made as them, with their rights at that moment
//     (D130). A request ends after a day.
//   - Nothing that spends money can be requested: paying, plans, seats and budgets are not among the changes an AI can ask for, and an
//     AI's connection reaches nothing else (D131).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"

	"github.com/google/uuid"
)

const connectorRequestSeconds = 24 * 3600

// moneyWords are kinds an AI might ask for that spend money; they are refused with the reason, whatever the wording.
var moneyWords = []string{"pay", "plan", "seat", "budget", "membership", "billing", "subscription", "charge", "refund", "credit"}

// connectorPeople is POST /v1/connectors/people {token, org}: the agency's people and teams, for an AI acting for its owner, an admin or
// a team lead (who see the people they manage in Caller Whale too).
func (s *server) connectorPeople(w http.ResponseWriter, r *http.Request) error {
	if err := s.serviceCaller(r); err != nil {
		return err
	}
	var body struct {
		Token string `json:"token"`
		Org   string `json:"org"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	who, err := s.connectorWhoIs(r, body.Token)
	if err != nil {
		return err
	}
	if who == nil || !strings.Contains(" "+who.Scope+" ", " team:manage ") {
		return errUnauthenticated
	}
	if _, err := uuid.Parse(body.Org); err != nil {
		return bad("Choose a valid workspace.")
	}
	roles, err := s.memberRoles(r, body.Org, who.UserID)
	if err != nil {
		return err
	}
	if !slices.ContainsFunc(roles, func(x string) bool { return x == "owner" || x == "solo" || x == "admin" || x == "manager" }) {
		return forbidden("Only the owner, admins and team leads manage people.")
	}
	var listed struct {
		Members []member `json:"members"`
		Teams   []team   `json:"teams"`
	}
	if _, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+body.Org+"/members", nil, &listed); err != nil {
		return err
	}
	people := []map[string]any{}
	for _, m := range listed.Members {
		var name string
		_ = s.db.QueryRow(r.Context(), "SELECT display_name FROM users WHERE id=$1", m.UserID).Scan(&name)
		people = append(people, map[string]any{"user_id": m.UserID, "name": name, "roles": nonNilStrings(m.Roles), "team_ids": nonNilStrings(m.TeamIDs), "suspended": m.SuspendedAt != nil})
	}
	teams := []map[string]any{}
	for _, t := range listed.Teams {
		teams = append(teams, map[string]any{"team_id": t.TeamID, "name": t.Name, "lead_ids": nonNilStrings(t.ManagerIDs)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"people": people, "teams": teams})
	return nil
}

// connectorRequest is POST /v1/connectors/requests {token, org, kind, args}: an AI asks for a change, which waits for the person.
func (s *server) connectorRequest(w http.ResponseWriter, r *http.Request) error {
	if err := s.serviceCaller(r); err != nil {
		return err
	}
	var body struct {
		Token string          `json:"token"`
		Org   string          `json:"org"`
		Kind  string          `json:"kind"`
		Args  json.RawMessage `json:"args"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	who, err := s.connectorWhoIs(r, body.Token)
	if err != nil {
		return err
	}
	if who == nil || !strings.Contains(" "+who.Scope+" ", " team:manage ") {
		return errUnauthenticated
	}
	kind := strings.ToLower(strings.TrimSpace(body.Kind))
	if slices.ContainsFunc(moneyWords, func(m string) bool { return strings.Contains(kind, m) }) {
		return forbidden("Spending money, plans, seats and budgets need the person themselves, in Caller Whale. No AI can ask for them.")
	}
	if _, err := uuid.Parse(body.Org); err != nil {
		return bad("Choose a valid workspace.")
	}
	var args struct {
		Email        string   `json:"email"`
		Roles        []string `json:"roles"`
		TeamIDs      []string `json:"team_ids"`
		UserID       string   `json:"user_id"`
		Reason       string   `json:"reason"`
		TeamID       string   `json:"team_id"`
		InvitationID string   `json:"invitation_id"`
	}
	if len(body.Args) > 0 {
		if err := json.Unmarshal(body.Args, &args); err != nil {
			return bad("The change's details are not valid.")
		}
	}
	idOK := func(v string) bool { _, err := uuid.Parse(v); return err == nil }
	var method, path, summary string
	var payload any
	switch kind {
	case "invite":
		if args.Email == "" || len(args.Roles) == 0 {
			return bad("Inviting needs an email and roles.")
		}
		method, path, payload = http.MethodPost, "/v1/orgs/"+body.Org+"/invitations", map[string]any{"email": args.Email, "roles": args.Roles, "team_ids": nonNilStrings(args.TeamIDs)}
		summary = fmt.Sprintf("Invite %s as %s", args.Email, strings.Join(args.Roles, ", "))
	case "remove":
		if !idOK(args.UserID) {
			return bad("Removing needs the person's user_id.")
		}
		method, path, payload = http.MethodDelete, "/v1/orgs/"+body.Org+"/members/"+args.UserID, map[string]any{"reason": args.Reason}
		summary = "Remove " + s.nameOf(r, args.UserID) + " from the agency"
	case "change_roles":
		if !idOK(args.UserID) || len(args.Roles) == 0 {
			return bad("Changing roles needs the person's user_id and their roles.")
		}
		method, path, payload = http.MethodPut, "/v1/orgs/"+body.Org+"/members/"+args.UserID, map[string]any{"roles": args.Roles, "team_ids": nonNilStrings(args.TeamIDs)}
		summary = fmt.Sprintf("Make %s %s", s.nameOf(r, args.UserID), strings.Join(args.Roles, ", "))
	case "delete_team":
		if !idOK(args.TeamID) {
			return bad("Deleting a team needs its team_id.")
		}
		method, path = http.MethodDelete, "/v1/orgs/"+body.Org+"/teams/"+args.TeamID
		summary = "Delete a team"
	case "cancel_invitation":
		if !idOK(args.InvitationID) {
			return bad("Cancelling needs the invitation_id.")
		}
		method, path = http.MethodDelete, "/v1/invitations/"+args.InvitationID
		summary = "Cancel an invitation"
	default:
		return bad("An AI can ask to invite, remove, change_roles, delete_team or cancel_invitation.")
	}
	raw := ""
	if payload != nil {
		b, _ := json.Marshal(payload)
		raw = string(b)
	}
	id := uuid.NewString()
	t := now()
	if _, err := s.db.Exec(r.Context(), `INSERT INTO connector_requests (id, grant_id, user_id, client_name, org_id, kind, method, path, body, summary, created_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, id, who.GrantID, who.UserID, who.ClientName, body.Org, kind, method, path, raw, summary, t, t+connectorRequestSeconds); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": "waiting", "summary": summary,
		"message": "Waiting for you to confirm it in Caller Whale (Dashboard). Nothing changes until you do."})
	return nil
}

func (s *server) nameOf(r *http.Request, user string) string {
	var name string
	if err := s.db.QueryRow(r.Context(), "SELECT display_name FROM users WHERE id=$1", user).Scan(&name); err != nil || name == "" {
		return "a member"
	}
	return name
}

// myAIRequests is GET /v1/me/ai-requests: the changes the person's AI connections asked for, waiting for them.
func (s *server) myAIRequests(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, client_name, org_id, kind, summary, created_at, expires_at FROM connector_requests
		WHERE user_id = $1 AND decided_at IS NULL AND expires_at > $2 ORDER BY created_at`, c.Sub, now())
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, client, org, kind, summary string
		var created, expires int64
		if err := rows.Scan(&id, &client, &org, &kind, &summary, &created, &expires); err != nil {
			return err
		}
		out = append(out, map[string]any{"id": id, "client_name": client, "org_id": org, "kind": kind, "summary": summary, "created_at": created, "expires_at": expires})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": out})
	return nil
}

// decideAIRequest is POST /v1/me/ai-requests/{id}/approve or /reject. Approving makes the change through this service's own routes, with
// the person's own sign-in on this request: their rights and their second step now decide, exactly as if they did it by hand.
func (s *server) decideAIRequest(approve bool) handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		c, err := s.person(r)
		if err != nil {
			return err
		}
		id := r.PathValue("id")
		var method, path, body string
		err = s.db.QueryRow(r.Context(), `UPDATE connector_requests SET decided_at = $3, decision = $4
			WHERE id = $1 AND user_id = $2 AND decided_at IS NULL AND expires_at > $3 RETURNING method, path, body`,
			id, c.Sub, now(), map[bool]string{true: "approved", false: "rejected"}[approve]).Scan(&method, &path, &body)
		if err != nil {
			return newError(http.StatusNotFound, "not_found", "This request has ended, was decided, or is not yours.")
		}
		if !approve {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "decision": "rejected"})
			return nil
		}
		inner := httptest.NewRequest(method, path, bytes.NewReader([]byte(body)))
		inner = inner.WithContext(r.Context())
		inner.Header.Set("Authorization", r.Header.Get("Authorization"))
		if body != "" {
			inner.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		s.handler().ServeHTTP(rec, inner)
		if _, err := s.db.Exec(r.Context(), `UPDATE connector_requests SET result_status = $2, result = $3 WHERE id = $1`, id, rec.Code, rec.Body.String()); err != nil {
			return err
		}
		var result any
		_ = json.Unmarshal(rec.Body.Bytes(), &result)
		writeJSON(w, http.StatusOK, map[string]any{"ok": rec.Code < 300, "decision": "approved", "status": rec.Code, "result": result})
		return nil
	}
}
