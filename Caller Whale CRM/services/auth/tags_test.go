package main

import (
	"regexp"
	"testing"
)

var newTag = regexp.MustCompile(`^[A-HJ-NP-Z2-9]{4}$`)

func (w *world) tagOf(email string) string {
	w.t.Helper()
	var tag string
	if err := w.s.db.QueryRow(w.t.Context(), "SELECT tag FROM users WHERE email=$1", email).Scan(&tag); err != nil {
		w.t.Fatal(err)
	}
	return tag
}

// Step 4: every name has a #tag, unique with the name and safe from look-alikes; the person changes it (twice in 30 days, the old
// one held 90 days); the three settings; search by name in one's agencies, or by exact Name#tag anywhere (D5, D14, D29, D30, D186).
func TestNameTagsSettingsAndSearch(t *testing.T) {
	w, fake, owner := lifecycleWorld(t)
	me := w.call("GET", "/v1/me", nil, owner)
	if !newTag.MatchString(me.str("tag")) || me.body["tag_note"] != false || me.str("phone_visible") != "nobody" || me.str("find_me") != "exact" || me.str("message_me") != "requests" {
		t.Fatalf("a new account: %v", me.body)
	}
	// Someone who was here before tags existed is told about theirs once (D106).
	w.exec("UPDATE users SET tag_note_seen = false WHERE email = 'owner@example.com'")
	if a := w.call("GET", "/v1/me", nil, owner); a.body["tag_note"] != true {
		t.Fatalf("the note: %v", a.body)
	}
	w.call("POST", "/v1/me/tag-note", nil, owner)
	if a := w.call("GET", "/v1/me", nil, owner); a.body["tag_note"] != false {
		t.Fatalf("the note after reading it: %v", a.body)
	}

	// Two people both named Sami: their tags differ, and one cannot take the other's.
	sami := w.confirmed("sami@example.com").access()
	if w.tagOf("sami@example.com") == w.tagOf("owner@example.com") {
		t.Fatal("two Samis share a tag")
	}
	if a := w.call("POST", "/v1/me/tag", map[string]any{"tag": w.tagOf("owner@example.com")}, sami); a.status != 409 {
		t.Fatalf("taking another Sami's tag: %d %v", a.status, a.body)
	}
	for _, bad := range []string{"O0", "AB1C", "TOOLONGTAG", "ab"} {
		if a := w.call("POST", "/v1/me/tag", map[string]any{"tag": bad}, sami); a.status != 400 {
			t.Fatalf("tag %q: %d", bad, a.status)
		}
	}

	// Past the first day, two changes in 30 days; the tag given up is held for 90 days.
	w.exec("UPDATE users SET created_at = created_at - 2*86400")
	first := w.tagOf("sami@example.com")
	if a := w.call("POST", "/v1/me/tag", map[string]any{"tag": "#k7p2"}, sami); a.status != 200 || a.str("tag") != "K7P2" {
		t.Fatalf("change the tag: %d %v", a.status, a.body)
	}
	if a := w.call("POST", "/v1/me/tag", map[string]any{"tag": first}, owner); a.status != 409 {
		t.Fatalf("taking a tag just given up: %d %v", a.status, a.body)
	}
	if a := w.call("POST", "/v1/me/tag", map[string]any{"tag": "WHALE"}, sami); a.status != 200 {
		t.Fatalf("second change: %d %v", a.status, a.body)
	}
	if a := w.call("POST", "/v1/me/tag", map[string]any{"tag": "WHALE2"}, sami); a.status != 429 || a.str("code") != "change_limit" {
		t.Fatalf("third change in 30 days: %d %v", a.status, a.body)
	}

	// A new name that would make the full name someone else's keeps the name and gets a free tag; the name limit counts too.
	dana := w.confirmed("dana@example.com").access()
	w.exec("UPDATE users SET display_name = 'Dana', tag = 'WHALE' WHERE email = 'dana@example.com'")
	w.exec("UPDATE users SET created_at = created_at - 2*86400 WHERE email = 'dana@example.com'")
	renamed := w.call("POST", "/v1/me/profile", map[string]any{"name": "Sami", "phone": "", "avatar": ""}, dana)
	if renamed.status != 200 || renamed.str("tag") == "WHALE" || !newTag.MatchString(renamed.str("tag")) {
		t.Fatalf("renamed into a taken full name: %d %v", renamed.status, renamed.body)
	}
	w.call("POST", "/v1/me/profile", map[string]any{"name": "Dana", "phone": "", "avatar": ""}, dana)
	if a := w.call("POST", "/v1/me/profile", map[string]any{"name": "Dana Two", "phone": "", "avatar": ""}, dana); a.status != 429 {
		t.Fatalf("third name change in 30 days: %d %v", a.status, a.body)
	}

	// Settings.
	if a := w.call("PUT", "/v1/me/privacy", map[string]any{"phone_visible": "everyone"}, sami); a.status != 400 {
		t.Fatalf("an unknown setting: %d", a.status)
	}
	if a := w.call("PUT", "/v1/me/privacy", map[string]any{"phone_visible": "leads", "message_me": "agencies"}, sami); a.status != 200 || a.str("find_me") != "exact" {
		t.Fatalf("settings: %d %v", a.status, a.body)
	}

	// Sami joins the agency. The owner finds them by part of the name and sees their phone (shown to leads); Dana, outside, does not.
	samiID := w.idOf("sami@example.com")
	fake.mu.Lock()
	fake.joined[samiID] = true
	fake.mu.Unlock()
	w.exec("UPDATE users SET phone = '+1 555 0100' WHERE email = 'sami@example.com'")
	found := w.call("GET", "/v1/people/search?q=sa", nil, owner)
	people, _ := found.body["people"].([]any)
	if found.status != 200 || len(people) != 1 || people[0].(map[string]any)["id"] != samiID || people[0].(map[string]any)["tag"] != "WHALE" {
		t.Fatalf("search in my agency: %d %v", found.status, found.body)
	}
	if a := w.call("GET", "/v1/people/search?q=sa", nil, dana); len(a.body["people"].([]any)) != 0 {
		t.Fatalf("a stranger finds by part of a name: %v", a.body)
	}
	members := w.call("GET", "/v1/orgs/"+flowOrg+"/members", nil, owner)
	for _, m := range members.body["members"].([]any) {
		if m := m.(map[string]any); m["user_id"] == samiID && (m["phone"] != "+1 555 0100" || m["tag"] != "WHALE") {
			t.Fatalf("the owner sees Sami: %v", m)
		}
	}
	w.call("PUT", "/v1/me/privacy", map[string]any{"phone_visible": "nobody"}, sami)
	members = w.call("GET", "/v1/orgs/"+flowOrg+"/members", nil, owner)
	for _, m := range members.body["members"].([]any) {
		if m := m.(map[string]any); m["user_id"] == samiID && m["phone"] != nil {
			t.Fatalf("a hidden phone shown: %v", m)
		}
	}

	// The exact Name#tag finds them from outside, and says whether a request can be sent; unless they chose agencies only.
	exact := w.call("GET", "/v1/people/search?q=Sami%23whale", nil, dana)
	people, _ = exact.body["people"].([]any)
	if len(people) != 1 || people[0].(map[string]any)["can_request"] != false || people[0].(map[string]any)["in_my_agencies"] != false {
		t.Fatalf("exact look-up: %v", exact.body)
	}
	// Look-alike characters count as the same: "5ami" is not "Sami", but "Sam1" is.
	if a := w.call("GET", "/v1/people/search?q=SAM1%23WHALE", nil, dana); len(a.body["people"].([]any)) != 1 {
		t.Fatalf("a look-alike name: %v", a.body)
	}
	w.call("PUT", "/v1/me/privacy", map[string]any{"find_me": "agencies"}, sami)
	if a := w.call("GET", "/v1/people/search?q=Sami%23WHALE", nil, dana); len(a.body["people"].([]any)) != 0 {
		t.Fatalf("found from outside after choosing agencies only: %v", a.body)
	}
	w.exec("INSERT INTO people_lookups (user_id, at) SELECT id, $1 FROM users, generate_series(1, 30) WHERE email = 'dana@example.com'", now())
	if a := w.call("GET", "/v1/people/search?q=Sami%23WHALE", nil, dana); a.status != 429 {
		t.Fatalf("look-ups past the limit: %d", a.status)
	}
}
