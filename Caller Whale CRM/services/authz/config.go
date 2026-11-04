package main

import (
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
)

// callerRights are the requests each calling service may make. Workers and the gateway only ask questions; only the core
// API changes who belongs where, and only billing and the core API set a workspace's standing.
var callerRights = map[string][]string{
	"core-api": {"grant", "check", "read", "manage", "manage_staff", "open", "standing"},
	"auth":     {"read", "manage_staff"},
	"billing":  {"grant", "check", "standing"},
	"gateway":  {"check"},
	"worker":   {"check"},
}

type config struct {
	port              string
	databaseURL       string
	signingKey        string
	tokens            map[string]string // machine token -> calling service
	grantSeconds      int
	requireSecondStep bool   // roles that need the second step (owner, solo) must have passed it
	staffSecondStep   bool   // Caller Whale's staff must have passed it
	platformOwner     string // who is the Caller Whale owner; set once at start, never changed
	platformCofounder string // the cofounder is also permanent
}

func loadConfig(getenv func(string) string) (config, error) {
	get := func(name, fallback string) string {
		if v := strings.TrimSpace(getenv(name)); v != "" {
			return v
		}
		return fallback
	}
	c := config{
		port:              get("PORT", "8104"),
		databaseURL:       get("DATABASE_URL", ""),
		signingKey:        get("AUTHZ_SIGNING_KEY", ""),
		requireSecondStep: get("AUTHZ_REQUIRE_SECOND_STEP", "true") != "false",
		staffSecondStep:   get("AUTHZ_STAFF_SECOND_STEP", "true") != "false",
		platformOwner:     strings.ToLower(get("AUTHZ_PLATFORM_OWNER", "")),
		platformCofounder: strings.ToLower(get("AUTHZ_PLATFORM_COFOUNDER", "")),
	}
	if _, err := strconv.Atoi(c.port); err != nil {
		return c, errors.New("PORT is not a number")
	}
	if c.databaseURL == "" {
		return c, errors.New("set DATABASE_URL to the authorization PostgreSQL database")
	}
	seconds, err := strconv.Atoi(get("AUTHZ_GRANT_SECONDS", "60"))
	if err != nil || seconds < 5 || seconds > 600 {
		return c, errors.New("AUTHZ_GRANT_SECONDS is a number from 5 to 600")
	}
	c.grantSeconds = seconds
	if c.platformOwner != "" && !validID(c.platformOwner) {
		return c, errors.New("AUTHZ_PLATFORM_OWNER is a person's id (a UUID, the sub of their sign-in token)")
	}
	if c.platformCofounder != "" && !validID(c.platformCofounder) {
		return c, errors.New("AUTHZ_PLATFORM_COFOUNDER is a person's id (a UUID, the sub of their sign-in token)")
	}
	if c.platformOwner != "" && c.platformOwner == c.platformCofounder {
		return c, errors.New("the owner and cofounder must be different people")
	}
	if c.tokens, err = parseTokens(get("AUTHZ_TOKENS", "")); err != nil {
		return c, err
	}
	return c, nil
}

// parseTokens reads AUTHZ_TOKENS: "core-api=<token>,billing=<token>,gateway=<token>,worker=<token>".
func parseTokens(text string) (map[string]string, error) {
	tokens := map[string]string{}
	seen := map[string]bool{}
	for _, part := range strings.Split(text, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, token, ok := strings.Cut(part, "=")
		name, token = strings.TrimSpace(name), strings.TrimSpace(token)
		if !ok || callerRights[name] == nil {
			return nil, fmt.Errorf("AUTHZ_TOKENS: %q is not one of the calling services (%s)", name, strings.Join(callerNames(), ", "))
		}
		if len(token) < 32 {
			return nil, fmt.Errorf("AUTHZ_TOKENS: the token for %s is shorter than 32 characters", name)
		}
		if seen[name] || tokens[token] != "" {
			return nil, fmt.Errorf("AUTHZ_TOKENS: %s is listed twice, or shares a token", name)
		}
		seen[name] = true
		tokens[token] = name
	}
	if len(tokens) == 0 {
		return nil, errors.New("set AUTHZ_TOKENS, one token per calling service, like core-api=<token>,billing=<token>")
	}
	return tokens, nil
}

func callerNames() []string {
	names := make([]string, 0, len(callerRights))
	for name := range callerRights {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}
