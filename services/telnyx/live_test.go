package telnyx

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"
)

// Step 21, part B: joining a live call by rank, the agent seeing it (D119); recording switched on for a team, the notice and pauses
// (D276, D277); voicemail messages per team (D278); a callback due while its agent is away (D153).
func TestLiveCallsRecordingVoicemailAndCallbacks(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	owner, agent, teamLead, stranger := e.user, newUUID(), newUUID(), newUUID()
	team := newUUID()
	rules := e.s.rules.(*fakeRules)
	g := rules.grants[owner+"|"+e.org]
	g.Roles = []string{"owner"}
	rules.grants[owner+"|"+e.org] = g
	for _, u := range []string{agent, teamLead, stranger} {
		rules.grants[u+"|"+e.org] = grantReply{Allowed: true, Scopes: []string{"team"}, Capabilities: []string{"call", "message"}, ManagedTeamIDs: func() []string {
			if u == teamLead {
				return []string{team}
			}
			return nil
		}()}
	}
	lead := e.addLead("+15125550001") // answered by a person in the simulator
	e.crm.mu.Lock()
	e.crm.leads[lead].AssigneeID, e.crm.leads[lead].TeamID, e.crm.leads[lead].TeamLeads = agent, team, []string{teamLead}
	e.crm.ranks = map[string]string{owner + "|" + lead: "owner", teamLead + "|" + lead: "lead", agent + "|" + lead: "agent"}
	e.crm.mu.Unlock()
	for _, u := range []string{owner, teamLead} {
		if _, err := e.s.st.db.Exec(ctx, `INSERT INTO agent_credentials (user_id, credential_id, sip_username) VALUES ($1, $2, $3)`, u, "cred-"+u[:4], "login"+u[:4]); err != nil {
			t.Fatal(err)
		}
	}

	// Recording on for the team; voicemail messages by the team's lead, not an agent.
	if status, _ := e.callAs(agent, "PUT", "/api/v1/recording", map[string]any{"team_id": team, "on": true}); status != 403 {
		t.Fatalf("an agent switches recording: %d", status)
	}
	if status, _ := e.call("PUT", "/api/v1/recording", map[string]any{"team_id": team, "on": true}); status != 200 {
		t.Fatalf("recording on: %d", status)
	}
	if status, _ := e.callAs(agent, "POST", "/api/v1/voicemail-drops", map[string]any{"name": "Hello", "audio_url": "https://example.com/vm.mp3", "team_id": team}); status != 403 {
		t.Fatalf("an agent records a voicemail message: %d", status)
	}
	status, drop := e.callAs(teamLead, "POST", "/api/v1/voicemail-drops", map[string]any{"name": "Hello", "audio_url": "https://example.com/vm.mp3", "team_id": team})
	if status != 200 {
		t.Fatalf("voicemail message: %d %v", status, drop)
	}
	if _, list := e.callAs(agent, "GET", "/api/v1/voicemail-drops?lead_id="+lead, nil); len(list["voicemail_drops"].([]any)) != 1 {
		t.Fatalf("the agent picks from: %v", list)
	}

	// The agent calls; it is recorded, with the notice first.
	status, call := e.callAs(agent, "POST", "/api/v1/calls", map[string]any{"lead_id": lead, "voicemail_drop_id": drop["id"]})
	if status != 200 || call["record"] != true || call["voicemail_drop_url"] != "https://example.com/vm.mp3" {
		t.Fatalf("call: %d %v", status, call)
	}
	id := call["id"].(string)
	for i := 0; i < 50; i++ {
		if c := e.loadCall(id); c != nil && c.AnsweredAt != nil {
			break
		}
		if !e.sim.step() {
			break
		}
	}
	e.sim.mu.Lock()
	spoke := slices.ContainsFunc(e.sim.actions, func(a string) bool { return strings.HasSuffix(a, "|speak") })
	e.sim.mu.Unlock()
	if !spoke {
		t.Fatal("the recording notice was not played")
	}

	// Joining: not the agent, not someone outside the team; the team's lead listens, the owner takes over.
	join := func(user, mode string) int {
		status, _ := e.callAs(user, "POST", "/api/v1/calls/"+id+"/join", map[string]any{"mode": mode})
		return status
	}
	if a, b, c := join(agent, "listen"), join(stranger, "listen"), join(teamLead, "shout"); a != 403 || b != 403 || c != 400 {
		t.Fatalf("who may join: %d %d %d", a, b, c)
	}
	if join(teamLead, "listen") != 200 || join(owner, "takeover") != 200 {
		t.Fatal("the lead listens and the owner takes over")
	}
	e.sim.mu.Lock()
	roles := slices.Clone(e.sim.supervisors)
	e.sim.mu.Unlock()
	if len(roles) != 2 || !strings.HasSuffix(roles[0], "|monitor") || !strings.HasSuffix(roles[1], "|barge") {
		t.Fatalf("the carrier was asked: %v", roles)
	}
	if _, seen := e.callAs(agent, "GET", "/api/v1/calls/"+id+"/joins", nil); len(seen["joins"].([]any)) != 2 {
		t.Fatalf("the agent sees who joined: %v", seen)
	}

	// The agent pauses and resumes the recording; the pause is kept.
	if status, _ := e.callAs(agent, "POST", "/api/v1/calls/"+id+"/recording", map[string]any{"pause": true}); status != 200 {
		t.Fatalf("pause: %d", status)
	}
	e.advance(30 * time.Second)
	e.callAs(agent, "POST", "/api/v1/calls/"+id+"/recording", map[string]any{"pause": false})
	if _, seen := e.callAs(agent, "GET", "/api/v1/calls/"+id+"/joins", nil); len(seen["recording_pauses"].([]any)) != 1 || seen["recording_pauses"].([]any)[0].(map[string]any)["resumed_at"] == nil {
		t.Fatalf("the pause is kept: %v", seen)
	}
	e.sim.drain()

	// A callback due while the agent is off: after the agency's wait, the team's lead is told, once.
	if _, err := e.s.st.db.Exec(ctx, `INSERT INTO calls (id, org_id, user_id, lead_id, direction, from_number, to_number, disposition, callback_at, created_at, ended_at)
		VALUES ($1, $2, $3, $4, 'outgoing', $5, '+15125550001', 'Callback', $6, $7, $7)`, newUUID(), e.org, agent, lead, e.number, e.now().Add(-20*time.Minute), e.now().Add(-3*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.st.db.Exec(ctx, `UPDATE calls SET created_at = $2 WHERE id = $1`, id, e.now().Add(-3*time.Hour)); err != nil {
		t.Fatal(err)
	}
	callbacks := func() int {
		if err := e.s.checkCallbacks(ctx); err != nil {
			t.Fatal(err)
		}
		_, a := e.callAs(teamLead, "GET", "/api/v1/sms/alerts", nil)
		n := 0
		for _, x := range a["alerts"].([]any) {
			if x.(map[string]any)["kind"] == "callback" {
				n++
			}
		}
		return n
	}
	if a, b := callbacks(), callbacks(); a != 1 || b != 1 {
		var told, calls int
		_ = e.s.st.db.QueryRow(ctx, `SELECT count(*) FROM callback_alerts`).Scan(&told)
		_ = e.s.st.db.QueryRow(ctx, `SELECT count(*) FROM calls WHERE lead_id = $1 AND created_at > now() - interval '2 hours'`, lead).Scan(&calls)
		t.Fatalf("the team's lead is told about the callback, once: %d %d (told %d, recent calls %d)", a, b, told, calls)
	}
}
