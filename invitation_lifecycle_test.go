package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

const goneTeam = "88888888-8888-4888-8888-888888888888"

// lifecycleWorld is an agency owned by owner@example.com, with email on.
func lifecycleWorld(t *testing.T) (*world, *fakeWorkspaceAuthz, string) {
	t.Helper()
	fake := &fakeWorkspaceAuthz{joined: map[string]bool{}, named: true, goneTeam: goneTeam}
	authz := httptest.NewServer(http.HandlerFunc(fake.serve))
	t.Cleanup(authz.Close)
	w := newWorld(t, func(c *config) { c.authzURL = authz.URL; c.authzToken = "token" })
	owner := w.confirmed("owner@example.com").access()
	fake.mu.Lock()
	fake.owner = w.idOf("owner@example.com")
	fake.mu.Unlock()
	return w, fake, owner
}

func (w *world) inviteInto(owner, email, team string) answer {
	w.t.Helper()
	return w.call("POST", "/v1/orgs/"+flowOrg+"/invitations", map[string]any{"email": email, "role": "caller", "team_id": team}, owner)
}

// agencySees is the invitation as the agency's list shows it.
func (w *world) agencySees(owner, id string) map[string]any {
	w.t.Helper()
	a := w.call("GET", "/v1/orgs/"+flowOrg+"/invitations", nil, owner)
	for _, item := range a.body["invitations"].([]any) {
		if m := item.(map[string]any); m["id"] == id {
			return m
		}
	}
	w.t.Fatalf("invitation %s is not in the agency's list: %v", id, a.body)
	return nil
}

func (w *world) exec(sql string, args ...any) {
	w.t.Helper()
	if _, err := w.s.db.Exec(w.t.Context(), sql, args...); err != nil {
		w.t.Fatal(err)
	}
}

func TestResendAndExtendAreLimited(t *testing.T) {
	w, _, owner := lifecycleWorld(t)
	id := w.inviteInto(owner, "sami@example.com", flowTeam).str("id")
	seen := w.agencySees(owner, id)
	if seen["status"] != "pending" || seen["resends_left"].(float64) != 3 || seen["extends_left"].(float64) != 2 {
		t.Fatalf("a new invitation: %v", seen)
	}
	if a := w.call("POST", "/v1/invitations/"+id+"/resend", nil, owner); a.status != 429 || a.str("code") != "resend_wait" {
		t.Fatalf("resent within the hour: %d %v", a.status, a.body)
	}
	for n := range 3 {
		w.exec("UPDATE access_invitations SET last_sent_at = last_sent_at - 3601 WHERE id=$1", id)
		if a := w.call("POST", "/v1/invitations/"+id+"/resend", nil, owner); a.status != 200 || a.str("delivery_state") != "sent" {
			t.Fatalf("resend %d: %d %v", n+1, a.status, a.body)
		}
	}
	w.exec("UPDATE access_invitations SET last_sent_at = last_sent_at - 3601 WHERE id=$1", id)
	if a := w.call("POST", "/v1/invitations/"+id+"/resend", nil, owner); a.status != 409 || a.str("code") != "resend_limit" {
		t.Fatalf("a fourth resend: %d %v", a.status, a.body)
	}

	// An ended invitation shows as expired to the agency, is extended from now by the agency's days, and then works again.
	w.exec("UPDATE access_invitations SET expires_at = $2 WHERE id=$1", id, now()-10)
	if seen := w.agencySees(owner, id); seen["status"] != "expired" {
		t.Fatalf("expired: %v", seen)
	}
	if a := w.call("PUT", "/v1/orgs/"+flowOrg+"/invitation-settings", map[string]any{"valid_days": 3}, owner); a.status != 200 || a.body["valid_days"].(float64) != 3 {
		t.Fatalf("the owner sets 3 days: %d %v", a.status, a.body)
	}
	for n := range 2 {
		a := w.call("POST", "/v1/invitations/"+id+"/extend", nil, owner)
		if a.status != 200 || int64(a.body["expires_at"].(float64)) < now()+3*86400-60 {
			t.Fatalf("extend %d: %d %v", n+1, a.status, a.body)
		}
	}
	if a := w.call("POST", "/v1/invitations/"+id+"/extend", nil, owner); a.status != 409 || a.str("code") != "extend_limit" {
		t.Fatalf("a third extend: %d %v", a.status, a.body)
	}
	if seen := w.agencySees(owner, id); seen["status"] != "pending" {
		t.Fatalf("extended: %v", seen)
	}
	sami := w.confirmed("sami@example.com").access()
	if a := w.call("GET", "/v1/me/invitations/"+id, nil, sami); a.status != 200 {
		t.Fatalf("an extended invitation opens: %d %v", a.status, a.body)
	}
	for _, bad := range []int{0, 31} {
		if a := w.call("PUT", "/v1/orgs/"+flowOrg+"/invitation-settings", map[string]any{"valid_days": bad}, owner); a.status != 400 {
			t.Fatalf("%d days: %d", bad, a.status)
		}
	}
}

func TestTheInvitedPersonDeclinesOrBlocksTheAgency(t *testing.T) {
	w, _, owner := lifecycleWorld(t)
	id := w.inviteInto(owner, "sami@example.com", flowTeam).str("id")
	sami := w.confirmed("sami@example.com").access()
	if a := w.call("POST", "/v1/me/invitations/"+id+"/decline", nil, sami); a.status != 200 {
		t.Fatalf("decline: %d %v", a.status, a.body)
	}
	if seen := w.agencySees(owner, id); seen["status"] != "declined" {
		t.Fatalf("the sender sees Declined: %v", seen)
	}
	if a := w.call("GET", "/v1/me/invitations/"+id, nil, sami); a.status != 410 || a.str("code") != "declined" {
		t.Fatalf("declined, opened again: %d %v", a.status, a.body)
	}
	if a := w.call("POST", "/v1/me/invitations/"+id+"/accept", nil, sami); a.status != 410 {
		t.Fatalf("a declined invitation cannot be accepted: %d %v", a.status, a.body)
	}

	// Declining frees the place: a new invitation to the same address goes out.
	again := w.inviteInto(owner, "sami@example.com", flowTeam)
	if again.status != 201 {
		t.Fatalf("invited again after declining: %d %v", again.status, again.body)
	}
	if a := w.call("POST", "/v1/me/blocked-agencies", map[string]any{"invitation_id": again.str("id")}, sami); a.status != 200 || a.str("org_name") != "Blue Door Homes" {
		t.Fatalf("block: %d %v", a.status, a.body)
	}
	if seen := w.agencySees(owner, again.str("id")); seen["status"] != "declined" {
		t.Fatalf("blocking declines what was waiting: %v", seen)
	}
	if a := w.inviteInto(owner, "sami@example.com", flowTeam); a.status != 403 {
		t.Fatalf("a blocked agency cannot invite: %d %v", a.status, a.body)
	}
	if a := w.inviteInto(owner, "SAMI@example.com", flowTeam); a.status != 403 {
		t.Fatalf("not even with capitals: %d", a.status)
	}
	listed := w.call("GET", "/v1/me/blocked-agencies", nil, sami)
	if agencies := listed.body["agencies"].([]any); len(agencies) != 1 || agencies[0].(map[string]any)["org_id"] != flowOrg {
		t.Fatalf("blocked list: %v", listed.body)
	}
	if a := w.call("DELETE", "/v1/me/blocked-agencies/"+flowOrg, nil, sami); a.status != 200 {
		t.Fatalf("unblock: %d", a.status)
	}
	if a := w.inviteInto(owner, "sami@example.com", flowTeam); a.status != 201 {
		t.Fatalf("invited after unblocking: %d %v", a.status, a.body)
	}

	// Someone else cannot block the agency for this person.
	other := w.confirmed("other@example.com").access()
	if a := w.call("POST", "/v1/me/blocked-agencies", map[string]any{"invitation_id": id}, other); a.status != 404 {
		t.Fatalf("another address blocks: %d", a.status)
	}
}

func TestAnInvitationThatCannotBeAcceptedShowsAsBlocked(t *testing.T) {
	w, _, owner := lifecycleWorld(t)
	id := w.inviteInto(owner, "sami@example.com", flowTeam).str("id")
	// The team was deleted after sending: authz now refuses that team.
	w.exec("UPDATE access_invitations SET team_id=$2 WHERE id=$1", id, goneTeam)
	seen := w.agencySees(owner, id)
	if seen["status"] != "blocked" || seen["status_reason"] != "That team is not in this workspace." {
		t.Fatalf("the agency sees why: %v", seen)
	}
	sami := w.confirmed("sami@example.com").access()
	mine := w.call("GET", "/v1/me/invitations", nil, sami).body["invitations"].([]any)
	if len(mine) != 1 || mine[0].(map[string]any)["status"] != "blocked" {
		t.Fatalf("the invited person sees it is blocked before accepting: %v", mine)
	}
}

func TestARemovedInviterCancelsWhatTheySent(t *testing.T) {
	w, _, owner := lifecycleWorld(t)
	w.confirmed("lead@example.com")
	lead := w.idOf("lead@example.com")
	// A team lead's invitation (team leads invite from step 3; it is written directly here).
	id := uuid.NewString()
	w.exec(`INSERT INTO access_invitations (id,scope,org_id,email,role,team_id,invited_by,created_at,expires_at,last_sent_at,org_name) VALUES ($1,'workspace',$2,'nora@example.com','caller',$3,$4,$5,$6,$5,'Blue Door Homes')`, id, flowOrg, flowTeam, lead, now(), now()+86400)
	kept := w.inviteInto(owner, "kai@example.com", flowTeam).str("id")
	if a := w.call("DELETE", "/v1/orgs/"+flowOrg+"/members/"+lead, nil, owner); a.status != 200 {
		t.Fatalf("remove the lead: %d %v", a.status, a.body)
	}
	seen := w.agencySees(owner, id)
	if seen["status"] != "cancelled" || seen["status_reason"] != "The person who sent it can no longer invite." {
		t.Fatalf("cancelled when the inviter left: %v", seen)
	}
	if seen := w.agencySees(owner, kept); seen["status"] != "pending" {
		t.Fatalf("other people's invitations stay: %v", seen)
	}
	nora := w.confirmed("nora@example.com").access()
	if a := w.call("GET", "/v1/me/invitations/"+id, nil, nora); a.status != 410 || a.str("code") != "cancelled" || a.str("error") != "This invitation was cancelled." {
		t.Fatalf("the invited person is told only that it was cancelled: %d %v", a.status, a.body)
	}
	// A suspended inviter's invitations go the same way.
	id2 := uuid.NewString()
	w.exec(`INSERT INTO access_invitations (id,scope,org_id,email,role,team_id,invited_by,created_at,expires_at,last_sent_at) VALUES ($1,'workspace',$2,'lina@example.com','caller',$3,$4,$5,$6,$5)`, id2, flowOrg, flowTeam, lead, now(), now()+86400)
	if a := w.call("POST", "/v1/orgs/"+flowOrg+"/members/"+lead+"/suspend", map[string]any{"reason": ""}, owner); a.status != 200 {
		t.Fatalf("suspend: %d %v", a.status, a.body)
	}
	if seen := w.agencySees(owner, id2); seen["status"] != "cancelled" {
		t.Fatalf("cancelled on suspension: %v", seen)
	}
}

func TestTheDailyNumberOfInvitationsIsCapped(t *testing.T) {
	w, _, owner := lifecycleWorld(t)
	if a := w.call("PUT", "/v1/orgs/"+flowOrg+"/invitation-settings", map[string]any{"daily_cap": 500}, owner); a.status != 403 {
		t.Fatalf("only staff raise the daily number: %d", a.status)
	}
	if a := w.call("GET", "/v1/orgs/"+flowOrg+"/invitation-settings", nil, owner); a.body["valid_days"].(float64) != 7 || a.body["daily_cap"].(float64) != 50 {
		t.Fatalf("defaults: %v", a.body)
	}
	w.exec("INSERT INTO workspace_invitation_settings (org_id,valid_days,daily_cap,updated_at) VALUES ($1,7,2,$2)", flowOrg, now())
	w.inviteInto(owner, "a@example.com", flowTeam)
	w.inviteInto(owner, "b@example.com", flowTeam)
	if a := w.inviteInto(owner, "c@example.com", flowTeam); a.status != 429 || a.str("code") != "daily_cap" {
		t.Fatalf("over the daily number: %d %v", a.status, a.body)
	}
}
