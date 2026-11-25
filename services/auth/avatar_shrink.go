package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png" // decodes PNG pictures
	"log"
	"strings"

	"golang.org/x/image/draw"
)

// A picture is shown at 150 px at most, and it travels in every /v1/me answer, so what is kept is small: at most avatarSide pixels
// a side, and a picture over avatarKeep characters is written again as a JPEG. A big upload is still accepted (validAvatar), then
// made small here; nobody is refused for the size of their photo.
const (
	avatarSide = 320
	avatarKeep = 60000 // about 45 KB of image
)

// shrinkAvatar is the picture as it is kept: unchanged when it is already small, otherwise at most avatarSide a side as a JPEG.
// A picture it cannot read is returned unchanged (validAvatar has already checked what it is).
func shrinkAvatar(value string) string {
	comma := strings.IndexByte(value, ',')
	if value == "" || comma < 0 {
		return value
	}
	raw, err := base64.StdEncoding.DecodeString(value[comma+1:])
	if err != nil {
		return value
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || (len(value) <= avatarKeep && config.Width <= avatarSide && config.Height <= avatarSide) {
		return value
	}
	// A picture far too big to be a photo of someone is not decoded at all.
	if config.Width*config.Height > 40_000_000 {
		return value
	}
	source, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return value
	}
	bounds := source.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if w > avatarSide || h > avatarSide {
		if w >= h {
			w, h = avatarSide, max(1, h*avatarSide/w)
		} else {
			w, h = max(1, w*avatarSide/h), avatarSide
		}
	}
	// A photo fits at the first try; a very busy picture is written a little softer, then a little smaller, until it fits.
	small := ""
	for _, scale := range []int{100, 80, 60} {
		sw, sh := max(1, w*scale/100), max(1, h*scale/100)
		out := image.NewRGBA(image.Rect(0, 0, sw, sh))
		draw.Draw(out, out.Bounds(), &image.Uniform{C: color.White}, image.Point{}, draw.Src) // JPEG has no transparency
		draw.CatmullRom.Scale(out, out.Bounds(), source, bounds, draw.Over, nil)
		for _, quality := range []int{85, 75, 65} {
			var buf bytes.Buffer
			if err := jpeg.Encode(&buf, out, &jpeg.Options{Quality: quality}); err != nil {
				return value
			}
			small = "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
			if len(small) <= avatarKeep {
				return small
			}
		}
	}
	if len(small) >= len(value) {
		return value
	}
	return small
}

// shrinkStoredAvatars makes the pictures saved before shrinkAvatar small, once, in the background. A picture changed meanwhile is
// left to its new value.
func (s *server) shrinkStoredAvatars(ctx context.Context) {
	rows, err := s.db.Query(ctx, "SELECT id, avatar FROM users WHERE length(avatar) > $1", avatarKeep)
	if err != nil {
		log.Printf("WARN could not list the large profile pictures: %v", err)
		return
	}
	type picture struct{ id, avatar string }
	var large []picture
	for rows.Next() {
		var p picture
		if err := rows.Scan(&p.id, &p.avatar); err == nil {
			large = append(large, p)
		}
	}
	rows.Close()
	done := 0
	for _, p := range large {
		small := shrinkAvatar(p.avatar)
		if small == p.avatar {
			continue
		}
		if _, err := s.db.Exec(ctx, "UPDATE users SET avatar = $1 WHERE id = $2 AND avatar = $3", small, p.id, p.avatar); err != nil {
			log.Printf("WARN could not shrink the profile picture of %s: %v", p.id, err)
			continue
		}
		done++
	}
	if done > 0 {
		log.Printf("made %d profile pictures smaller", done)
	}
}
