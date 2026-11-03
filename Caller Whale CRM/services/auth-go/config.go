package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// config is everything the service reads from its environment. The names are the ones the Rust service reads, so the same Coolify
// settings serve both while they run side by side.
type config struct {
	databaseURL    string
	port           string
	signingKey     string // base64 of an Ed25519 PKCS#8 key or of a 32-byte secret; empty only on a developer's machine
	accessMinutes  int
	refreshDays    int
	publicSignup   bool   // anyone may create an account; off for a private server
	publicURL      string // this service's public address
	websiteURL     string
	landingURL     string // where a sign-in or a confirmation link started from the public site returns
	appURL         string
	devTokens      bool // development only: return email confirmation tokens in answers
	allowedOrigins []string

	firebaseKey      string
	firebaseIdentity string
	firebaseToken    string

	notifyURL   string
	notifyToken string
}

func loadConfig(getenv func(string) string) (config, error) {
	get := func(name, fallback string) string {
		if v, ok := lookup(getenv, name); ok {
			return v
		}
		return fallback
	}
	number := func(name string, fallback int) (int, error) {
		v := strings.TrimSpace(getenv(name))
		if v == "" {
			return fallback, nil
		}
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return 0, fmt.Errorf("%s is not a positive number", name)
		}
		return n, nil
	}
	trimSlash := func(s string) string { return strings.TrimRight(strings.TrimSpace(s), "/") }

	c := config{
		databaseURL:      strings.TrimSpace(getenv("DATABASE_URL")),
		port:             get("PORT", "8101"),
		signingKey:       strings.TrimSpace(getenv("AUTH_SIGNING_KEY")),
		publicSignup:     get("AUTH_PUBLIC_SIGNUP", "true") != "false",
		publicURL:        trimSlash(get("AUTH_PUBLIC_URL", "http://localhost:8101")),
		websiteURL:       trimSlash(get("AUTH_WEBSITE_URL", "http://localhost:8088")),
		appURL:           trimSlash(get("AUTH_APP_URL", "http://localhost:5190")),
		landingURL:       trimSlash(get("AUTH_LANDING_URL", "http://localhost:5200")),
		devTokens:        get("AUTH_DEV_TOKENS", "false") == "true",
		firebaseKey:      strings.TrimSpace(getenv("AUTH_FIREBASE_API_KEY")),
		firebaseIdentity: trimSlash(get("AUTH_FIREBASE_IDENTITY_URL", "https://identitytoolkit.googleapis.com")),
		firebaseToken:    trimSlash(get("AUTH_FIREBASE_TOKEN_URL", "https://securetoken.googleapis.com")),
		notifyURL:        trimSlash(getenv("AUTH_NOTIFY_URL")),
		notifyToken:      strings.TrimSpace(getenv("AUTH_NOTIFY_TOKEN")),
	}
	if c.databaseURL == "" {
		return c, errors.New("set DATABASE_URL, a PostgreSQL address like postgres://user:password@host:5432/callerwhale_auth")
	}
	if _, err := strconv.Atoi(c.port); err != nil {
		return c, errors.New("PORT is not a number")
	}
	if c.firebaseKey == "" {
		return c, errors.New("set AUTH_FIREBASE_API_KEY: Firebase holds the accounts, passwords and social sign-in; this service keeps none of its own")
	}
	var err error
	if c.accessMinutes, err = number("AUTH_ACCESS_MINUTES", 15); err != nil {
		return c, err
	}
	if c.refreshDays, err = number("AUTH_REFRESH_DAYS", 30); err != nil {
		return c, err
	}
	origins := get("AUTH_ALLOWED_ORIGINS", "http://localhost:5190,http://localhost:8088,tauri://localhost,http://tauri.localhost")
	for _, o := range strings.Split(origins, ",") {
		if o = trimSlash(o); o != "" {
			c.allowedOrigins = append(c.allowedOrigins, o)
		}
	}
	// The human check lives in the gateway. Two checks cannot both pass: Google accepts a token once.
	if strings.TrimSpace(getenv("AUTH_BOT_PROTECTION")) == "true" {
		return c, errors.New("AUTH_BOT_PROTECTION=true: this service does not check reCAPTCHA, the gateway does (HUMAN_CHECK there). Set it to false")
	}
	return c, nil
}

// lookup is a setting's value, and false when it is unset or blank (the default then applies).
func lookup(getenv func(string) string, name string) (string, bool) {
	v := getenv(name)
	if strings.TrimSpace(v) == "" {
		return "", false
	}
	return v, true
}
