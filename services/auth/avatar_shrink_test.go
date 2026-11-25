package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"math/rand"
	"strings"
	"testing"
)

// noisyPNG is a picture that does not compress, like a photo: the size a real upload has.
func noisyPNG(t *testing.T, side int) string {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, side, side))
	r := rand.New(rand.NewSource(1))
	for y := 0; y < side; y++ {
		for x := 0; x < side; x++ {
			picture.Set(x, y, color.RGBA{uint8(r.Intn(256)), uint8(r.Intn(256)), uint8(r.Intn(256)), 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, picture); err != nil {
		t.Fatal(err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}

func sideOf(t *testing.T, value string) (int, int) {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(value[strings.IndexByte(value, ',')+1:])
	if err != nil {
		t.Fatal(err)
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	return config.Width, config.Height
}

func TestABigPictureIsKeptSmallAndASmallOneAsItIs(t *testing.T) {
	big := noisyPNG(t, 400)
	if !validAvatar(big) || len(big) <= avatarKeep {
		t.Fatalf("setup: %d characters", len(big))
	}
	small := shrinkAvatar(big)
	if !strings.HasPrefix(small, "data:image/jpeg;base64,") || len(small) > avatarKeep || !validAvatar(small) {
		t.Fatalf("shrunk: %d characters, %q", len(small), small[:30])
	}
	if w, h := sideOf(t, small); w > avatarSide || w != h {
		t.Fatalf("side %dx%d", w, h)
	}
	tiny := noisyPNG(t, 40)
	if shrinkAvatar(tiny) != tiny || shrinkAvatar("") != "" {
		t.Fatal("a small picture, and none, are kept as they are")
	}
}

func TestASavedPictureIsKeptSmallAndOldOnesAreShrunk(t *testing.T) {
	w := newWorld(t)
	account := w.confirmed("sami@example.com")
	big := noisyPNG(t, 400)
	saved := w.call("POST", "/v1/me/profile", map[string]any{"name": "Sami", "phone": "", "avatar": big}, account.access())
	if saved.status != 200 {
		t.Fatalf("%d %v", saved.status, saved.body)
	}
	me := w.call("GET", "/v1/me", nil, account.access())
	kept, _ := me.body["avatar"].(string)
	if len(kept) > avatarKeep || kept != saved.body["avatar"] {
		t.Fatalf("kept %d characters", len(kept))
	}
	// A picture saved before: made small at start.
	if _, err := w.s.db.Exec(context.Background(), "UPDATE users SET avatar = $1 WHERE email = 'sami@example.com'", big); err != nil {
		t.Fatal(err)
	}
	w.s.shrinkStoredAvatars(context.Background())
	me = w.call("GET", "/v1/me", nil, account.access())
	if after, _ := me.body["avatar"].(string); len(after) > avatarKeep || !strings.HasPrefix(after, "data:image/jpeg;base64,") {
		t.Fatalf("after %d characters", len(after))
	}
}
