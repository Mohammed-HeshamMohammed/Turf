package main

import (
	"context"
	"encoding/base64"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// A person who signs in with Google starts with their Google picture, so they do not have to choose one. Only people with no picture yet:
// a picture someone chose themselves is never replaced. Apple sends no picture, so those accounts (and normal sign-ups) choose their own.

// googlePictureHost says whether an address is one Google serves profile pictures from. Only https, only Google's own picture host.
func googlePictureHost(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "googleusercontent.com" || strings.HasSuffix(host, ".googleusercontent.com")
}

// fetchGooglePicture downloads a Google profile picture as a data address the profile accepts, or "" when it cannot (never an error: the
// picture is a nicety and must not stop a sign-in).
func fetchGooglePicture(ctx context.Context, raw string) string {
	if !googlePictureHost(raw) {
		return ""
	}
	// Google's addresses end in a size, like =s96-c; ask for a sharper one.
	if i := strings.LastIndex(raw, "=s"); i > 0 && strings.HasSuffix(raw, "-c") {
		raw = raw[:i] + "=s256-c"
	}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return ""
	}
	client := &http.Client{CheckRedirect: func(next *http.Request, via []*http.Request) error {
		if len(via) > 3 || !googlePictureHost(next.URL.String()) {
			return http.ErrUseLastResponse
		}
		return nil
	}}
	res, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxAvatarBytes+1))
	if err != nil || len(body) > maxAvatarBytes {
		return ""
	}
	kind := "image/jpeg"
	if len(body) > 4 && string(body[1:4]) == "PNG" {
		kind = "image/png"
	}
	value := "data:" + kind + ";base64," + base64.StdEncoding.EncodeToString(body)
	if !validAvatar(value) {
		return ""
	}
	return value
}

// fetchPicture is a variable so a test can answer without the network.
var fetchPicture = fetchGooglePicture

// takeProviderPicture gives a person their Google picture when they have none. Quiet on every failure.
func (s *server) takeProviderPicture(ctx context.Context, userID, picture string) {
	if userID == "" || picture == "" {
		return
	}
	var has bool
	if err := s.db.QueryRow(ctx, "SELECT avatar <> '' FROM users WHERE id = $1", userID).Scan(&has); err != nil || has {
		return
	}
	value := fetchPicture(ctx, picture)
	if value == "" {
		return
	}
	if _, err := s.db.Exec(ctx, "UPDATE users SET avatar = $1 WHERE id = $2 AND avatar = ''", value, userID); err != nil {
		log.Printf("ERROR provider picture: %v", err)
	}
}
