package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

// A username is the address of a person's own page: callerwhale.com/their-username. Lower case letters, digits and single hyphens,
// 3 to 30 characters, starting and ending with a letter or digit.
var usernameShape = regexp.MustCompile(`^[a-z0-9](?:-?[a-z0-9]){2,29}$`)

// reservedUsernames are words the website or the services use at the first level of an address. Keep it with database_setup/0019_username.sql.
var reservedUsernames = map[string]bool{
	"account": true, "admin": true, "api": true, "assets": true, "auth": true, "billing": true, "connect": true, "contact": true,
	"dashboard": true, "features": true, "forgot": true, "gate": true, "help": true, "home": true, "login": true, "logout": true,
	"mcp": true, "notifications": true, "pricing": true, "privacy": true, "profile": true, "security": true, "settings": true,
	"signin": true, "signout": true, "signup": true, "support": true, "terms": true, "why-caller-whale": true, "screens": true,
	"healthz": true, "robots": true, "sitemap": true, "favicon": true, "static": true, "app": true, "www": true, "caller-whale": true, "callerwhale": true,
}

var notUsernameCharacters = regexp.MustCompile(`[^a-z0-9]+`)

// usernameFrom makes a username's start from a name: "Mohammed Hesham" becomes "mohammed-hesham".
func usernameFrom(name, email string) string {
	base := strings.Trim(notUsernameCharacters.ReplaceAllString(strings.ToLower(strings.TrimSpace(name)), "-"), "-")
	if base == "" {
		local, _, _ := strings.Cut(email, "@")
		base = strings.Trim(notUsernameCharacters.ReplaceAllString(strings.ToLower(local), "-"), "-")
	}
	if len(base) > 24 {
		base = strings.Trim(base[:24], "-")
	}
	if len(base) < 3 || reservedUsernames[base] {
		base += "-user"
	}
	return base
}


// freeUsername finds the first username from base that nobody has: base, base-2, base-3, ...
func (s *server) freeUsername(ctx context.Context, base string) (string, error) {
	for n := 1; n < 10000; n++ {
		candidate := base
		if n > 1 {
			candidate = fmt.Sprintf("%s-%d", base, n)
		}
		var taken bool
		if err := s.db.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM users WHERE username = $1)", candidate).Scan(&taken); err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
	}
	return "", errors.New("no free username")
}

// updateUsername changes the person's own username (POST /v1/me/username).
func (s *server) updateUsername(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	var body struct {
		Username string `json:"username"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	name := strings.ToLower(strings.TrimSpace(body.Username))
	if !usernameShape.MatchString(name) {
		return bad("Use 3 to 30 letters, numbers or hyphens, starting and ending with a letter or number.")
	}
	if reservedUsernames[name] {
		return conflict("That one is kept for Caller Whale. Choose another.")
	}
	tag, err := s.db.Exec(r.Context(), "UPDATE users SET username = $1 WHERE id = $2 AND NOT EXISTS (SELECT 1 FROM users WHERE username = $1 AND id <> $2)", name, c.Sub)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return conflict("That username is taken. Choose another.")
	}
	writeJSON(w, http.StatusOK, map[string]any{"username": name})
	return nil
}
