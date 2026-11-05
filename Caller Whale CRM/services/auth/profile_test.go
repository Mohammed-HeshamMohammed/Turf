package main

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestProfilePictureAcceptsOnlySmallPNGOrJPEG(t *testing.T) {
	png := "data:image/png;base64," + base64.StdEncoding.EncodeToString(append([]byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10}, []byte("image")...))
	if !validAvatar("") || !validAvatar(png) {
		t.Fatal("a PNG or an empty picture should be accepted")
	}
	if validAvatar("data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte("<svg/>"))) {
		t.Fatal("SVG must be rejected")
	}
	if validAvatar("data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("not a PNG"))) {
		t.Fatal("a false PNG must be rejected")
	}
	if validAvatar("data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(append([]byte{0xff, 0xd8, 0xff}, []byte(strings.Repeat("a", 500001))...))) {
		t.Fatal("oversize picture must be rejected")
	}
}

func TestProfileChangesAppearInMyAccount(t *testing.T) {
	w := newWorld(t)
	account := w.signUp("profile@example.com")
	png := "data:image/png;base64," + base64.StdEncoding.EncodeToString(append([]byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10}, []byte("picture")...))
	changed := w.call("POST", "/v1/me/profile", map[string]any{"name": "New Name", "phone": "+1 555 123 4567", "avatar": png}, account.access())
	if changed.status != 200 {
		t.Fatalf("save profile: %d %v", changed.status, changed.body)
	}
	me := w.call("GET", "/v1/me", nil, account.access())
	if me.body["name"] != "New Name" || me.body["phone"] != "+1 555 123 4567" || me.body["avatar"] != png {
		t.Fatalf("profile not saved: %v", me.body)
	}
	if bad := w.call("POST", "/v1/me/profile", map[string]any{"name": "", "phone": "bad", "avatar": png}, account.access()); bad.status != 400 {
		t.Fatalf("invalid profile: %d", bad.status)
	}
	if anonymous := w.call("POST", "/v1/me/profile", map[string]any{"name": "Bad"}, ""); anonymous.status != 401 {
		t.Fatalf("anonymous update: %d", anonymous.status)
	}
}

func TestAvatarSizeLimit(t *testing.T) {
	png := func(size int) string {
		data := append([]byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10}, make([]byte, size-8)...)
		return "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
	}
	if !validAvatar(png(400000)) {
		t.Fatal("a 400 KB picture should be accepted")
	}
	if validAvatar(png(500001)) {
		t.Fatal("a picture over 500 KB should be refused")
	}
	if validAvatar("data:image/gif;base64,R0lGODlhAQABAAAAACw=") {
		t.Fatal("only PNG and JPEG are accepted")
	}
}

func TestProfileNameInParts(t *testing.T) {
	w := newWorld(t)
	account := w.signUp("parts@example.com")
	saved := w.call("POST", "/v1/me/profile", map[string]any{"name": "ignored", "phone": "", "avatar": "", "first_name": " Mohammed ", "middle_name": "", "last_name": "Hesham"}, account.access())
	if saved.status != 200 {
		t.Fatalf("save name parts: %d %v", saved.status, saved.body)
	}
	me := w.call("GET", "/v1/me", nil, account.access())
	if me.body["name"] != "Mohammed Hesham" || me.body["first_name"] != "Mohammed" || me.body["last_name"] != "Hesham" {
		t.Fatalf("name parts not saved: %v", me.body)
	}
	// A picture saved on its own leaves the parts as they are.
	w.call("POST", "/v1/me/profile", map[string]any{"name": "Mohammed Hesham", "phone": "", "avatar": ""}, account.access())
	if again := w.call("GET", "/v1/me", nil, account.access()); again.body["last_name"] != "Hesham" {
		t.Fatalf("parts changed by a save without them: %v", again.body)
	}
	if bad := w.call("POST", "/v1/me/profile", map[string]any{"name": "x", "phone": "", "avatar": "", "first_name": "  ", "last_name": "Hesham"}, account.access()); bad.status != 400 {
		t.Fatalf("a missing first name should be refused: %d", bad.status)
	}
}
