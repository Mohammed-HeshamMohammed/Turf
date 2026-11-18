package main

// The dialer service's private door into the CRM (services/features/dialer-sms). The carrier (Telnyx, or its simulator) tells the
// dialer what happened on a call; the dialer asks here whether a lead may be called and records each finished call as the same
// `call.record` operation a person's device sends, run as the person who made the call. So permissions, do-not-call, stages,
// callback tasks, the audit trail, live updates and the team's numbers are exactly those of a call logged by hand.
//
// These routes are under /internal, which the gateway never forwards from outside, and need DIALER_TOKEN as well. The dialer
// uses its own call id as the operation id, so a webhook delivered twice, or a report retried, records one call.

import (
	"context"
	"crypto/subtle"
	"net/http"
	"regexp"
	"slices"
	"strings"
)

func (s *server) dialerRoutes(mux *http.ServeMux) {
	if s.cfg.dialerToken == "" {
		return
	}
	mux.Handle("POST /internal/v1/dialer/lead", s.dialerOnly(s.dialerLead))
	mux.Handle("POST /internal/v1/dialer/find-lead", s.dialerOnly(s.dialerFindLead))
	mux.Handle("POST /internal/v1/dialer/calls", s.dialerOnly(s.dialerOp("call.record")))
	mux.Handle("POST /internal/v1/dialer/recording", s.dialerOnly(s.dialerOp("call.recording")))
}

type dialerAsk struct {
	OrgID       string         `json:"org_id"`
	UserID      string         `json:"user_id"`
	LeadID      string         `json:"lead_id"`
	Phone       string         `json:"phone"`
	OperationID string         `json:"operation_id"`
	Payload     map[string]any `json:"payload"`
}

func (s *server) dialerOnly(h func(http.ResponseWriter, *http.Request, dialerAsk, scope) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(bearer(r)), []byte(s.cfg.dialerToken)) != 1 {
			writeError(w, &apiError{http.StatusUnauthorized, "unauthorized", "Only the dialer service may call this."})
			return
		}
		var ask dialerAsk
		if err := readJSON(w, r, &ask); err != nil {
			writeError(w, err)
			return
		}
		if !validID(ask.OrgID) || !validID(ask.UserID) {
			writeError(w, bad("org_id and user_id are required."))
			return
		}
		sc, err := s.dialerScope(r.Context(), ask.OrgID, ask.UserID)
		if err == nil {
			err = h(w, r, ask, sc)
		}
		if err != nil {
			writeError(w, err)
		}
	})
}

// dialerScope is the person who made (or took) the call, with the rights authz gives them now: a removed or suspended person's
// calls are refused like their own requests would be.
func (s *server) dialerScope(ctx context.Context, org, user string) (scope, error) {
	g, err := s.rules.grant(ctx, user, org, false)
	if err != nil {
		return scope{}, err
	}
	if !g.Allowed {
		return scope{}, refusal(g)
	}
	var name string
	_ = s.st.db.QueryRow(ctx, `SELECT coalesce(nullif(name, ''), email) FROM people WHERE user_id = $1`, user).Scan(&name)
	if name == "" {
		name = "Dialer"
	}
	return scope{userID: user, orgID: org, label: name, roles: g.Roles, scopes: g.Scopes, teamIDs: g.TeamIDs, seeTeams: g.seeTeams(), projectIDs: g.ProjectIDs, caps: g.Capabilities,
		managed: g.ManagedTeamIDs, deputyOf: g.DeputyTeamIDs}, nil
}

// dialerLead answers "may this person call this lead, and on which number": the dialer dials the CRM's number, never one a
// browser sent.
func (s *server) dialerLead(w http.ResponseWriter, r *http.Request, ask dialerAsk, sc scope) error {
	if !validID(ask.LeadID) {
		return bad("lead_id is required.")
	}
	ctx := r.Context()
	tx, err := s.st.begin(ctx, sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	run := &run{s: s, ctx: ctx, sc: sc, tx: tx}
	lead, err := run.lead(strings.ToLower(ask.LeadID), false)
	if err != nil {
		return err
	}
	if lead == nil {
		return notFound("The lead was not found, was deleted, or is outside this person's access.")
	}
	reply := dialerLeadReply(lead, sc)
	// For the lead's text thread (step 10): who works the lead, its team's leads and deputies (told when a text waits too long), and
	// the asker's rank toward it, for who may send and take over.
	reply["assignee_id"], reply["team_id"], reply["client_id"] = lead["assignee_id"], lead["team_id"], lead["client_id"]
	reply["rank"] = threadRank(sc, lead)
	leads, deputies := []string{}, []string{}
	if team := asString(lead["team_id"]); team != "" {
		if teams, err := s.rules.teams(ctx, sc.orgID); err == nil {
			for _, t := range teams {
				if t.TeamID == team {
					leads, deputies = nonNil(t.leads()), nonNil(t.DeputyIDs)
				}
			}
		}
	}
	if len(leads) == 0 { // a team without a lead: the owner is told instead (D20)
		if members, err := s.rules.members(ctx, sc.orgID); err == nil {
			for _, m := range members {
				if slices.Contains(m.Roles, "owner") || slices.Contains(m.Roles, "solo") {
					leads = append(leads, m.UserID)
				}
			}
		}
	}
	// The team's agents, for an incoming call that its own agent cannot take (step 21, D150).
	agents := []string{}
	if team := asString(lead["team_id"]); team != "" {
		if members, err := s.rules.members(ctx, sc.orgID); err == nil {
			for _, m := range members {
				if slices.Contains(m.TeamIDs, team) && !slices.Contains(leads, m.UserID) {
					agents = append(agents, m.UserID)
				}
			}
		}
	}
	reply["team_agents"] = agents
	reply["team_leads"], reply["team_deputies"] = leads, deputies
	writeJSON(w, http.StatusOK, reply)
	return nil
}

// threadRank is the asker's place toward a lead's text thread, highest first (D76): the owner or an admin, a lead of the lead's team,
// its deputy, the agent it is assigned to; "" for anyone else who may see it.
func threadRank(sc scope, lead map[string]any) string {
	team := asString(lead["team_id"])
	switch {
	case slices.Contains(sc.roles, "owner") || slices.Contains(sc.roles, "solo") || slices.Contains(sc.roles, "admin"):
		return "owner"
	case team != "" && slices.Contains(sc.managed, team):
		return "lead"
	case team != "" && slices.Contains(sc.deputyOf, team):
		return "deputy"
	case asString(lead["assignee_id"]) == sc.userID:
		return "agent"
	}
	return ""
}

func dialerLeadReply(lead map[string]any, sc scope) map[string]any {
	reason := ""
	switch {
	case !sc.can("call"):
		reason = "This person's role does not allow calls."
	case !canEditLead(sc, lead):
		reason = "This person can only call leads assigned to them."
	case lead["do_not_call"] == true:
		reason = "This lead is do-not-call."
	case strings.TrimSpace(asString(lead["phone"])) == "":
		reason = "This lead has no phone number."
	}
	return map[string]any{"lead_id": lead["id"], "name": lead["name"], "phone": lead["phone"], "stage": lead["stage"],
		"verdict": lead["verdict"], "do_not_call": lead["do_not_call"] == true, "may_call": reason == "", "reason": reason}
}

var nonDigits = regexp.MustCompile(`\D`)

// lastTen is a phone number's last ten digits: how a US number is matched whatever its formatting.
func lastTen(phone string) string {
	d := nonDigits.ReplaceAllString(phone, "")
	if len(d) > 10 {
		d = d[len(d)-10:]
	}
	return d
}

// dialerFindLead finds the lead an inbound call or text came from, among the leads the number's owner may see.
func (s *server) dialerFindLead(w http.ResponseWriter, r *http.Request, ask dialerAsk, sc scope) error {
	digits := lastTen(ask.Phone)
	if len(digits) < 7 {
		return bad("phone is required.")
	}
	ctx := r.Context()
	tx, err := s.st.begin(ctx, sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	lead, err := queryOne(ctx, tx, `SELECT to_jsonb(l) FROM leads l WHERE l.org_id = cw_org() AND l.deleted_at IS NULL AND cw_visible_lead(l.id)
		AND right(regexp_replace(l.phone, '\D', '', 'g'), 10) = $1 ORDER BY l.updated_at DESC LIMIT 1`, digits)
	if err != nil {
		return err
	}
	if lead == nil {
		writeJSON(w, http.StatusOK, map[string]any{"found": false})
		return nil
	}
	reply := dialerLeadReply(lead, sc)
	reply["found"] = true
	writeJSON(w, http.StatusOK, reply)
	return nil
}

// dialerOp applies one operation as the person, with the dialer's id for it: asking again answers "duplicate".
func (s *server) dialerOp(kind string) func(http.ResponseWriter, *http.Request, dialerAsk, scope) error {
	return func(w http.ResponseWriter, r *http.Request, ask dialerAsk, sc scope) error {
		res, err := s.apply(r.Context(), sc, op{ID: strings.ToLower(ask.OperationID), Kind: kind, Payload: ask.Payload, DeviceID: "dialer", internal: true})
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, res)
		return nil
	}
}

// callRecording adds a recording that the carrier saved after the call was already logged (operation_id names that call).
func (r *run) callRecording(p map[string]any) (any, error) {
	callOp, err := uuidField(p, "call_operation_id")
	if err != nil {
		return nil, err
	}
	url := str(p, "recording_url")
	if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
		return nil, reject("recording_url must be a web address")
	}
	start, err := optTime(p, "recording_started_at")
	if err != nil {
		return nil, err
	}
	end, err := optTime(p, "recording_ended_at")
	if err != nil {
		return nil, err
	}
	event, err := r.one(`UPDATE call_events SET details = details || jsonb_build_object('recording_url', $2::text),
			recording_started_at = coalesce($3, recording_started_at), recording_ended_at = coalesce($4, recording_ended_at)
		WHERE operation_id = $1 AND org_id = cw_org() RETURNING to_jsonb(call_events.*)`, callOp, url, start, end)
	if err != nil {
		return nil, err
	}
	if event == nil {
		return nil, reject("That call is not logged")
	}
	leadID := asString(event["lead_id"])
	return event, r.record(change{entity: "call", kind: "call.recording_added", id: asString(event["id"]), leadID: leadID, after: event})
}
