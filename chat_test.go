package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestConfigNeedsItsSettings(t *testing.T) {
	env := map[string]string{"DATABASE_URL": "postgres://x", "AUTH_JWKS_URL": "http://auth/jwks", "AUTHZ_URL": "http://authz", "AUTHZ_TOKEN": strings.Repeat("a", 32)}
	get := func(k string) string { return env[k] }
	c, err := loadConfig(get)
	if err != nil || c.port != "8108" {
		t.Fatalf("a complete configuration was refused: %v (port %q)", err, c.port)
	}
	env["LIVE_API_URL"] = "http://centrifugo:8000/api"
	if _, err = loadConfig(get); err == nil {
		t.Fatal("a live server without its key and secret was accepted")
	}
	env["AUTHZ_TOKEN"] = "short"
	if _, err = loadConfig(get); err == nil {
		t.Fatal("a short authz token was accepted")
	}
}

func TestLiveTokenIsSignedForOnePerson(t *testing.T) {
	l := newLive(config{liveAPI: "http://x/api", liveSecret: testLiveSecret})
	now := time.Unix(1_800_000_000, 0)
	parts := strings.Split(l.token("11111111-1111-4111-8111-111111111111", now), ".")
	if len(parts) != 3 {
		t.Fatal("not a three-part token")
	}
	mac := hmac.New(sha256.New, []byte(testLiveSecret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) != parts[2] {
		t.Fatal("the signature does not match the secret")
	}
	raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var body struct {
		Sub string `json:"sub"`
		Exp int64  `json:"exp"`
	}
	if json.Unmarshal(raw, &body) != nil || body.Sub != "11111111-1111-4111-8111-111111111111" || body.Exp != now.Add(liveTokenTTL).Unix() {
		t.Fatalf("wrong claims: %s", raw)
	}
}

func TestTwoPeopleChat(t *testing.T) {
	e := newEnv(t)
	org, other := newID(), newID()
	alice, bob, carol, dave := newID(), newID(), newID(), newID()
	e.rules.join(org, alice, bob, carol)
	e.rules.join(other, dave)

	chat := e.must(201, alice, org, "POST", "/conversations", map[string]any{"kind": "direct", "member_ids": []string{bob}})
	id := chat["id"].(string)
	// Starting the same chat again, from either side, answers with the one that exists.
	if again := e.must(200, bob, org, "POST", "/conversations", map[string]any{"kind": "direct", "member_ids": []string{alice}}); again["id"] != id {
		t.Fatalf("a second direct chat was made: %v", again["id"])
	}
	// Someone outside the workspace cannot be added.
	if status, _ := e.call(alice, org, "POST", "/conversations", map[string]any{"kind": "direct", "member_ids": []string{dave}}); status != 400 {
		t.Fatalf("a chat with a stranger: status %d", status)
	}

	// A message sent twice with the same id is saved once.
	mid := newID()
	first := e.must(201, alice, org, "POST", "/conversations/"+id+"/messages", map[string]any{"id": mid, "body": " Hello Bob "})["message"].(map[string]any)
	retry := e.must(200, alice, org, "POST", "/conversations/"+id+"/messages", map[string]any{"id": mid, "body": "Hello Bob"})["message"].(map[string]any)
	if first["seq"] != float64(1) || retry["seq"] != float64(1) || first["body"] != "Hello Bob" {
		t.Fatalf("first %v, retry %v", first, retry)
	}
	// The same id from someone else is refused, not taken over.
	if status, _ := e.call(bob, org, "POST", "/conversations/"+id+"/messages", map[string]any{"id": mid, "body": "mine now"}); status != 409 {
		t.Fatalf("a reused id: status %d", status)
	}
	e.send(alice, org, id, "Are you there?")
	e.send(bob, org, id, "Here")

	// Numbers go up by one, and the list is oldest first.
	page := e.must(200, bob, org, "GET", "/conversations/"+id+"/messages", nil)
	if list := page["messages"].([]any); len(list) != 3 || list[0].(map[string]any)["seq"] != float64(1) || list[2].(map[string]any)["body"] != "Here" || page["last_seq"] != float64(3) {
		t.Fatalf("messages: %v", page)
	}
	// What was missed after a number, and the page before one.
	if list := e.must(200, bob, org, "GET", "/conversations/"+id+"/messages?after=1", nil)["messages"].([]any); len(list) != 2 || list[0].(map[string]any)["seq"] != float64(2) {
		t.Fatalf("after 1: %v", list)
	}
	if list := e.must(200, bob, org, "GET", "/conversations/"+id+"/messages?before=3&limit=1", nil)["messages"].([]any); len(list) != 1 || list[0].(map[string]any)["seq"] != float64(2) {
		t.Fatalf("before 3: %v", list)
	}

	// Alice has not read Bob's reply; Bob, who sent last, has nothing unread.
	if c := e.conversation(alice, org, id); c["unread"] != float64(1) || c["last_message"].(map[string]any)["body"] != "Here" {
		t.Fatalf("alice sees %v", c)
	}
	if c := e.conversation(bob, org, id); c["unread"] != float64(0) {
		t.Fatalf("bob sees %v", c)
	}
	// Reading moves forward only, and never past the newest message.
	e.must(200, alice, org, "POST", "/conversations/"+id+"/read", map[string]any{"seq": 99})
	if out := e.must(200, alice, org, "POST", "/conversations/"+id+"/read", map[string]any{"seq": 1}); out["last_read_seq"] != float64(3) {
		t.Fatalf("read went backwards: %v", out)
	}
	if c := e.conversation(alice, org, id); c["unread"] != float64(0) {
		t.Fatalf("alice still has unread: %v", c)
	}

	// A teammate who is not in the chat, and a person from another workspace, see nothing of it.
	for _, outsider := range []struct{ user, org string }{{carol, org}, {dave, other}} {
		if e.conversation(outsider.user, outsider.org, id) != nil {
			t.Fatal("an outsider lists the chat")
		}
		for _, path := range []string{"/conversations/" + id, "/conversations/" + id + "/messages"} {
			if status, _ := e.call(outsider.user, outsider.org, "GET", path, nil); status != 404 {
				t.Fatalf("an outsider GET %s: status %d", path, status)
			}
		}
		if status, _ := e.call(outsider.user, outsider.org, "POST", "/conversations/"+id+"/messages", map[string]any{"id": newID(), "body": "hi"}); status != 404 {
			t.Fatalf("an outsider sent a message: status %d", status)
		}
		if status, _ := e.call(outsider.user, outsider.org, "PUT", "/messages/"+mid+"/reactions/👍", nil); status != 404 {
			t.Fatalf("an outsider reacted: status %d", status)
		}
	}
	// Dave is not in Alice's workspace at all.
	if status, _ := e.call(dave, org, "GET", "/conversations", nil); status != 403 {
		t.Fatalf("a stranger entered the workspace: status %d", status)
	}
}

func TestRowSecurityHidesOtherPeoplesMessages(t *testing.T) {
	e := newEnv(t)
	org := newID()
	alice, bob, carol := newID(), newID(), newID()
	e.rules.join(org, alice, bob, carol)
	id := e.must(201, alice, org, "POST", "/conversations", map[string]any{"kind": "direct", "member_ids": []string{bob}})["id"].(string)
	e.send(alice, org, id, "between us")

	// Asked directly, with no membership check in the query, the database still shows Carol nothing.
	ctx := context.Background()
	for user, want := range map[string]int{alice: 1, carol: 0} {
		tx, err := e.s.st.begin(ctx, scope{userID: user, orgID: org})
		if err != nil {
			t.Fatal(err)
		}
		var n int
		if err = tx.QueryRow(ctx, `SELECT count(*) FROM messages`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		tx.Rollback(ctx)
		if n != want {
			t.Fatalf("%s sees %d messages, want %d", user[:4], n, want)
		}
	}
	// And nobody sees anything under another workspace's name.
	tx, _ := e.s.st.begin(ctx, scope{userID: alice, orgID: newID()})
	var n int
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM conversations`).Scan(&n)
	tx.Rollback(ctx)
	if n != 0 {
		t.Fatalf("another workspace sees %d conversations", n)
	}
}

func TestGroups(t *testing.T) {
	e := newEnv(t)
	org := newID()
	alice, bob, carol, erin := newID(), newID(), newID(), newID()
	e.rules.join(org, alice, bob, carol, erin)

	if status, _ := e.call(alice, org, "POST", "/conversations", map[string]any{"kind": "group", "member_ids": []string{bob}}); status != 400 {
		t.Fatalf("a group without a name: status %d", status)
	}
	if status, _ := e.call(alice, org, "POST", "/conversations", map[string]any{"kind": "group", "title": "Just me"}); status != 400 {
		t.Fatalf("a group of one: status %d", status)
	}
	group := e.must(201, alice, org, "POST", "/conversations", map[string]any{"kind": "group", "title": "Closers", "member_ids": []string{bob, bob, alice}})
	id := group["id"].(string)
	if members := group["members"].([]any); len(members) != 2 || group["title"] != "Closers" {
		t.Fatalf("group: %v", group)
	}
	e.send(alice, org, id, "one")
	e.send(bob, org, id, "two")

	// Only the owner renames and adds people.
	if status, _ := e.call(bob, org, "PATCH", "/conversations/"+id, map[string]any{"title": "Bob's"}); status != 403 {
		t.Fatalf("a member renamed the group: status %d", status)
	}
	if status, _ := e.call(bob, org, "POST", "/conversations/"+id+"/members", map[string]any{"add": []string{carol}}); status != 403 {
		t.Fatalf("a member added someone: status %d", status)
	}
	e.must(200, alice, org, "PATCH", "/conversations/"+id, map[string]any{"title": "Closing team"})
	e.must(200, alice, org, "POST", "/conversations/"+id+"/members", map[string]any{"add": []string{carol}})

	// Carol joins with nothing unread, can read what came before, and the conversation says she was added.
	c := e.conversation(carol, org, id)
	if c == nil || c["unread"] != float64(0) || c["title"] != "Closing team" {
		t.Fatalf("carol sees %v", c)
	}
	list := e.must(200, carol, org, "GET", "/conversations/"+id+"/messages", nil)["messages"].([]any)
	if last := list[len(list)-1].(map[string]any); len(list) != 3 || last["kind"] != "system" || last["body"] != "added" || last["mentions"].([]any)[0] != carol {
		t.Fatalf("after adding carol: %v", list)
	}

	// Archiving and muting are each person's own.
	e.must(200, bob, org, "PATCH", "/conversations/"+id, map[string]any{"archived": true, "muted": true})
	if c := e.conversation(bob, org, id); c["archived"] != true || c["muted"] != true {
		t.Fatalf("bob's settings: %v", c)
	}
	if c := e.conversation(alice, org, id); c["archived"] != false {
		t.Fatalf("bob's archive reached alice: %v", c)
	}

	// The owner removes Bob: he loses the conversation at once.
	e.must(200, alice, org, "POST", "/conversations/"+id+"/members", map[string]any{"remove": []string{bob}})
	if e.conversation(bob, org, id) != nil {
		t.Fatal("a removed member still lists the group")
	}
	if status, _ := e.call(bob, org, "GET", "/conversations/"+id+"/messages", nil); status != 404 {
		t.Fatalf("a removed member reads the group: status %d", status)
	}
	// The owner leaves: the longest-standing member takes over, and can add people.
	e.must(200, alice, org, "POST", "/conversations/"+id+"/members", map[string]any{"remove": []string{alice}})
	c = e.conversation(carol, org, id)
	if members := c["members"].([]any); len(members) != 1 || members[0].(map[string]any)["role"] != "owner" {
		t.Fatalf("after the owner left: %v", c["members"])
	}
	e.must(200, carol, org, "POST", "/conversations/"+id+"/members", map[string]any{"add": []string{erin, bob}})
	if c = e.conversation(bob, org, id); c == nil || c["unread"] != float64(0) {
		t.Fatalf("bob, added again, sees %v", c)
	}
}

func TestReactionsEditsDeletesAndPolls(t *testing.T) {
	e := newEnv(t)
	org := newID()
	alice, bob := newID(), newID()
	e.rules.join(org, alice, bob)
	id := e.must(201, alice, org, "POST", "/conversations", map[string]any{"kind": "direct", "member_ids": []string{bob}})["id"].(string)
	msg := e.send(alice, org, id, "Offer sent to @Bob")
	mid := msg["id"].(string)

	// A reply quotes a message of this conversation; a mention must be someone in it.
	reply := e.must(201, bob, org, "POST", "/conversations/"+id+"/messages", map[string]any{"id": newID(), "body": "Thanks", "reply_to": mid, "mentions": []string{alice, newID()}})["message"].(map[string]any)
	if reply["reply_to"] != mid || len(reply["mentions"].([]any)) != 1 {
		t.Fatalf("reply: %v", reply)
	}
	if status, _ := e.call(bob, org, "POST", "/conversations/"+id+"/messages", map[string]any{"id": newID(), "body": "x", "reply_to": newID()}); status != 400 {
		t.Fatalf("a reply to nothing: status %d", status)
	}

	// One reaction per person per emoji; taking it back removes it.
	e.must(200, bob, org, "PUT", "/messages/"+mid+"/reactions/👍", nil)
	e.must(200, bob, org, "PUT", "/messages/"+mid+"/reactions/👍", nil)
	got := e.must(200, alice, org, "PUT", "/messages/"+mid+"/reactions/🎉", nil)["message"].(map[string]any)
	if len(got["reactions"].([]any)) != 2 {
		t.Fatalf("reactions: %v", got["reactions"])
	}
	got = e.must(200, bob, org, "DELETE", "/messages/"+mid+"/reactions/👍", nil)["message"].(map[string]any)
	if len(got["reactions"].([]any)) != 1 {
		t.Fatalf("after taking one back: %v", got["reactions"])
	}

	// Only the sender edits or deletes; a deleted message keeps its place and loses its words.
	if status, _ := e.call(bob, org, "PATCH", "/messages/"+mid, map[string]any{"body": "hacked"}); status != 403 {
		t.Fatalf("someone else's edit: status %d", status)
	}
	edited := e.must(200, alice, org, "PATCH", "/messages/"+mid, map[string]any{"body": "Offer sent"})["message"].(map[string]any)
	if edited["body"] != "Offer sent" || edited["edited_at"] == nil {
		t.Fatalf("edited: %v", edited)
	}
	if status, _ := e.call(bob, org, "DELETE", "/messages/"+mid, nil); status != 403 {
		t.Fatalf("someone else's delete: status %d", status)
	}
	deleted := e.must(200, alice, org, "DELETE", "/messages/"+mid, nil)["message"].(map[string]any)
	if deleted["deleted"] != true || deleted["body"] != "" || deleted["seq"] != float64(1) {
		t.Fatalf("deleted: %v", deleted)
	}
	if status, _ := e.call(alice, org, "PATCH", "/messages/"+mid, map[string]any{"body": "back"}); status != 404 {
		t.Fatalf("editing a deleted message: status %d", status)
	}

	// A poll: one vote per person, voting again moves it.
	poll := e.must(201, alice, org, "POST", "/conversations/"+id+"/messages", map[string]any{"id": newID(), "poll": map[string]any{"question": "When do we call?", "options": []string{"Morning", "Afternoon"}}})["message"].(map[string]any)
	pid := poll["id"].(string)
	if poll["kind"] != "poll" || poll["body"] != "When do we call?" {
		t.Fatalf("poll: %v", poll)
	}
	e.must(200, bob, org, "POST", "/messages/"+pid+"/vote", map[string]any{"option": 0})
	voted := e.must(200, bob, org, "POST", "/messages/"+pid+"/vote", map[string]any{"option": 1})["message"].(map[string]any)
	votes := voted["poll"].(map[string]any)["votes"].([]any)
	if len(votes) != 1 || votes[0].(map[string]any)["option"] != float64(1) {
		t.Fatalf("votes: %v", votes)
	}
	if status, _ := e.call(bob, org, "POST", "/messages/"+pid+"/vote", map[string]any{"option": 5}); status != 400 {
		t.Fatalf("a vote for a choice that is not there: status %d", status)
	}
	if status, _ := e.call(bob, org, "POST", "/messages/"+reply["id"].(string)+"/vote", map[string]any{"option": 0}); status != 400 {
		t.Fatalf("a vote on an ordinary message: status %d", status)
	}
}

func TestOnlyTheTeamUsesConversations(t *testing.T) {
	e := newEnv(t)
	org := newID()
	client, viewer := newID(), newID()
	e.rules.grants[client+"|"+org] = grantReply{Allowed: true, Scopes: []string{"shared"}, Capabilities: []string{"message"}}
	e.rules.grants[viewer+"|"+org] = grantReply{Allowed: true, Scopes: []string{"organization"}, Capabilities: []string{"edit"}}
	for _, user := range []string{client, viewer} {
		if status, _ := e.call(user, org, "GET", "/conversations", nil); status != 403 {
			t.Fatalf("status %d for someone who may not use conversations", status)
		}
	}
	if status, _ := e.call(newID(), "", "GET", "/conversations", nil); status != 400 {
		t.Fatalf("no workspace named: status %d", status)
	}
}

func TestUpdatesReachTheLiveServerOnceAndInOrder(t *testing.T) {
	e := newEnv(t)
	org := newID()
	alice, bob, carol := newID(), newID(), newID()
	e.rules.join(org, alice, bob, carol)
	ctx := context.Background()

	// While the live server is down, everything is saved and waits its turn.
	e.live.setDown(true)
	id := e.must(201, alice, org, "POST", "/conversations", map[string]any{"kind": "direct", "member_ids": []string{bob}})["id"].(string)
	e.send(alice, org, id, "first")
	e.send(bob, org, id, "second")
	if sent, err := e.s.flush(ctx); sent != 0 || err == nil {
		t.Fatalf("flush with the live server down: sent %d, err %v", sent, err)
	}
	var waiting int
	if err := e.admin.QueryRow(ctx, `SELECT count(*) FROM messaging.outbox`).Scan(&waiting); err != nil || waiting != 3 {
		t.Fatalf("%d updates waiting (%v), want 3", waiting, err)
	}

	e.live.setDown(false)
	if sent, err := e.s.flush(ctx); sent != 3 || err != nil {
		t.Fatalf("flush: sent %d, err %v", sent, err)
	}
	got := e.live.seen()
	if len(got) != 3 {
		t.Fatalf("the live server heard %d updates", len(got))
	}
	kinds, keys := []string{}, map[string]bool{}
	for _, update := range got {
		data := update["data"].(map[string]any)
		kinds = append(kinds, data["type"].(string))
		keys[update["idempotency_key"].(string)] = true
		if data["org_id"] != org || data["conversation_id"] != id {
			t.Fatalf("update about the wrong conversation: %v", data)
		}
		// Each update goes to the two people in the chat, on their own channels, and to nobody else.
		channels := update["channels"].([]any)
		if len(channels) != 2 {
			t.Fatalf("channels: %v", channels)
		}
		for _, ch := range channels {
			if ch != channelPrefix+alice && ch != channelPrefix+bob {
				t.Fatalf("an update went to %v", ch)
			}
		}
	}
	if strings.Join(kinds, ",") != "conversation,message,message" || len(keys) != 3 {
		t.Fatalf("order %v, %d distinct keys", kinds, len(keys))
	}
	if got[2]["data"].(map[string]any)["message"].(map[string]any)["body"] != "second" {
		t.Fatalf("the last update is not the last message: %v", got[2])
	}
	if err := e.admin.QueryRow(ctx, `SELECT count(*) FROM messaging.outbox`).Scan(&waiting); err != nil || waiting != 0 {
		t.Fatalf("%d updates still waiting after delivery", waiting)
	}

	// The app is told where to listen: its own channel, with a token for itself.
	status, where := e.call(alice, "", "GET", "/live", nil)
	if status != 200 || where["enabled"] != true || where["channel"] != channelPrefix+alice || where["url"] == "" || len(strings.Split(where["token"].(string), ".")) != 3 {
		t.Fatalf("live: %d %v", status, where)
	}
}
