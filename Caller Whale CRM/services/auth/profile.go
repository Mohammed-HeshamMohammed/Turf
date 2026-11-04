package main

import (
	"encoding/base64"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"
)

var profilePhone = regexp.MustCompile(`^\+?[0-9][0-9 ()-]{5,24}$`)

func validAvatar(value string) bool {
	if value == "" {
		return true
	}
	var encoded string
	var signature []byte
	switch {
	case strings.HasPrefix(value, "data:image/png;base64,"):
		encoded = strings.TrimPrefix(value, "data:image/png;base64,")
		signature = []byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10}
	case strings.HasPrefix(value, "data:image/jpeg;base64,"):
		encoded = strings.TrimPrefix(value, "data:image/jpeg;base64,")
		signature = []byte{0xff, 0xd8, 0xff}
	default:
		return false
	}
	if len(encoded) > 140000 {
		return false
	}
	image, err := base64.StdEncoding.DecodeString(encoded)
	return err == nil && len(image) <= 100000 && len(image) >= len(signature) && string(image[:len(signature)]) == string(signature)
}

func (s *server) updateProfile(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	var body struct {
		Name   string `json:"name"`
		Phone  string `json:"phone"`
		Avatar string `json:"avatar"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	body.Name = strings.TrimSpace(body.Name)
	body.Phone = strings.TrimSpace(body.Phone)
	if body.Name == "" || utf8.RuneCountInString(body.Name) > 120 {
		return bad("Enter a name up to 120 characters.")
	}
	if body.Phone != "" && !profilePhone.MatchString(body.Phone) {
		return bad("Enter a valid phone number, or leave it blank.")
	}
	if !validAvatar(body.Avatar) {
		return bad("Choose a PNG or JPEG profile picture smaller than 100 KB.")
	}
	var current string
	if err := s.db.QueryRow(r.Context(), "SELECT display_name FROM users WHERE id = $1", c.Sub).Scan(&current); err != nil {
		return err
	}
	if body.Name != current {
		idToken, err := s.sessionIDToken(r.Context(), c.SID)
		if err != nil {
			return err
		}
		if err := s.fb.setName(r.Context(), idToken, body.Name); err != nil {
			return asAPI(err)
		}
	}
	if _, err := s.db.Exec(r.Context(), "UPDATE users SET display_name = $1, phone = $2, avatar = $3 WHERE id = $4", body.Name, body.Phone, body.Avatar, c.Sub); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": body.Name, "phone": body.Phone, "avatar": body.Avatar})
	return nil
}
