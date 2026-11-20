package main

import (
	"slices"
	"testing"
)

// kindOf finds the person's conversation of one kind (and team), or nil.
func (e *env) kindOf(user, org, kind, teamID string) map[string]any {
	e.t.Helper()
	for _, c := range e.must(200, user, org, "GET", "/conversations", nil)["conversations"].([]any) {
		m := c.(map[string]any)
		if m["kind"] == kind && (teamID == "" || m["team_id"] == teamID) {
			return m
		}
	}
	return nil
}

func memberIDs(c map[string]any) []string {
	out := []string{}
	for _, m := range c["members"].([]any) {
		out = append(out, m.(map[string]any)["user_id"].(string))
	}
	slices.Sort(out)
	return out
}

func sorted(ids ...string) []string { out := slices.Clone(ids); slices.Sort(out); return out }

func ids(v any) []string {
	out := []string{}
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	slices.Sort(out)
	return out
}

// Step 16, part B: team chats follow their teams and cannot be left (D52, D185); the announcements channel holds everyone and only
// the owner, admins and leads post, marking posts important (D74, D350); @team, @everyone and @managers reach the right people (D86).
func TestTeamChatsAnnouncementsAndMentions(t *testing.T) {
	e := newEnv(t)
	org := newID()
	owner, lead, ann, ben, dee, client := newID(), newID(), newID(), newID(), newID(), newID()
	one, two := newID(), newID()
	e.rules.join(org, owner, lead, ann, ben, dee, client)
	e.rules.place(org, owner, []string{"owner"})
	e.rules.place(org, lead, []string{"manager"})
	e.rules.place(org, ann, []string{"caller"}, one)
	e.rules.place(org, ben, []string{"caller"}, two)
	e.rules.place(org, dee, []string{"closer"}, two)
	e.rules.place(org, client, []string{"client"})
	e.rules.setTeams(org, team{TeamID: one, Name: "Openers", ManagerIDs: []string{lead}, DeputyIDs: []string{dee}}, team{TeamID: two, Name: "Closers"})

	// Each team has its chat, named as the team, with its lead, deputy and members; the owner is not in it (D23).
	chat := e.kindOf(ann, org, "team", one)
	if chat == nil || chat["title"] != "Openers" || !slices.Equal(memberIDs(chat), sorted(lead, ann, dee)) {
		t.Fatalf("team one's chat: %v", chat)
	}
	if e.kindOf(owner, org, "team", "") != nil {
		t.Fatal("the owner is in a team chat they do not lead")
	}
	closers := e.kindOf(ben, org, "team", two)
	if closers == nil || !slices.Equal(memberIDs(closers), sorted(ben, dee)) {
		t.Fatalf("team two's chat: %v", closers)
	}
	// Everyone but the client is in announcements.
	news := e.kindOf(ann, org, "announcements", "")
	if news == nil || news["title"] != "Announcements" || !slices.Equal(memberIDs(news), sorted(owner, lead, ann, ben, dee)) {
		t.Fatalf("announcements: %v", news)
	}
	chatID, newsID, closersID := chat["id"].(string), news["id"].(string), closers["id"].(string)

	// Nobody leaves or renames a team chat; they can mute it.
	e.must(403, ann, org, "POST", "/conversations/"+chatID+"/members", map[string]any{"remove": []string{ann}})
	e.must(403, lead, org, "POST", "/conversations/"+chatID+"/members", map[string]any{"add": []string{ben}})
	e.must(403, ann, org, "POST", "/conversations/"+newsID+"/members", map[string]any{"remove": []string{ann}})
	e.must(403, lead, org, "PATCH", "/conversations/"+chatID, map[string]any{"title": "Mine"})
	if muted := e.must(200, ann, org, "PATCH", "/conversations/"+chatID, map[string]any{"muted": true}); muted["muted"] != true {
		t.Fatalf("mute: %v", muted)
	}
	e.send(ann, org, chatID, "before the move")
	e.send(ben, org, closersID, "before Ann came")

	// The chat follows the team: renamed with it, and Ann moved to team two leaves one's chat and joins two's with only what came after unread.
	e.rules.setTeams(org, team{TeamID: one, Name: "First callers", ManagerIDs: []string{lead}, DeputyIDs: []string{dee}}, team{TeamID: two, Name: "Closers"})
	e.rules.place(org, ann, []string{"caller"}, two)
	e.send(ben, org, closersID, "welcome")
	if e.conversation(ann, org, chatID) != nil {
		t.Fatal("Ann still has team one's chat")
	}
	e.must(404, ann, org, "GET", "/conversations/"+chatID+"/messages", nil)
	if c := e.conversation(lead, org, chatID); c["title"] != "First callers" || !slices.Equal(memberIDs(c), sorted(lead, dee)) {
		t.Fatalf("team one's chat after the change: %v", c)
	}
	if c := e.conversation(ann, org, closersID); c == nil || c["unread"] != float64(1) || !slices.Equal(memberIDs(c), sorted(ann, ben, dee)) {
		t.Fatalf("Ann in team two's chat: %v", c)
	}

	// Announcements: only the owner, admins and leads post; an important one mentions everyone; everyone reacts.
	e.must(403, ann, org, "POST", "/conversations/"+newsID+"/messages", map[string]any{"id": newID(), "body": "hi all"})
	post := e.must(201, lead, org, "POST", "/conversations/"+newsID+"/messages", map[string]any{
		"id": newID(), "body": "Office closed Friday", "important": true, "mention_groups": []string{"everyone"}})["message"].(map[string]any)
	if post["important"] != true || !slices.Equal(ids(post["mentions"]), sorted(owner, ann, ben, dee)) || !slices.Equal(ids(post["mention_groups"]), []string{"everyone"}) {
		t.Fatalf("the important announcement: %v", post)
	}
	e.must(200, ann, org, "PUT", "/messages/"+post["id"].(string)+"/reactions/👍", nil)
	e.must(400, lead, org, "POST", "/conversations/"+chatID+"/messages", map[string]any{"id": newID(), "body": "x", "important": true})

	// @team in a team chat reaches the team; @managers its leads and deputies; elsewhere @team needs the team named.
	m := e.must(201, ben, org, "POST", "/conversations/"+closersID+"/messages", map[string]any{"id": newID(), "body": "standup", "mention_groups": []string{"team"}})["message"].(map[string]any)
	if !slices.Equal(ids(m["mentions"]), sorted(ann, dee)) {
		t.Fatalf("@team: %v", m)
	}
	m = e.must(201, dee, org, "POST", "/conversations/"+chatID+"/messages", map[string]any{"id": newID(), "body": "help", "mention_groups": []string{"managers"}})["message"].(map[string]any)
	if !slices.Equal(ids(m["mentions"]), []string{lead}) {
		t.Fatalf("@managers: %v", m)
	}
	direct := e.must(201, ann, org, "POST", "/conversations", map[string]any{"kind": "direct", "member_ids": []string{ben}})["id"].(string)
	e.must(400, ann, org, "POST", "/conversations/"+direct+"/messages", map[string]any{"id": newID(), "body": "x", "mention_groups": []string{"team"}})
	e.must(400, ann, org, "POST", "/conversations/"+direct+"/messages", map[string]any{"id": newID(), "body": "x", "mention_groups": []string{"nobody"}})
	m = e.must(201, ann, org, "POST", "/conversations/"+direct+"/messages", map[string]any{"id": newID(), "body": "x", "mention_groups": []string{"team:" + two}})["message"].(map[string]any)
	if !slices.Equal(ids(m["mentions"]), []string{ben}) {
		t.Fatalf("@team:<id> in a direct chat: %v", m)
	}

	// A team that is gone takes its people out of its chat; its words stay where they were.
	e.rules.setTeams(org, team{TeamID: two, Name: "Closers"})
	if e.conversation(lead, org, chatID) != nil {
		t.Fatal("the lead still has a deleted team's chat")
	}
}
