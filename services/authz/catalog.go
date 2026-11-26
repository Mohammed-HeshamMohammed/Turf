package main

// The role catalog: every role a person can be given, in one list with nothing twice.
//
//   - Workspace roles (what someone is inside a customer's workspace): the standard roles every workspace starts with, then the
//     workspace's own custom roles. Joined by key, so a role is listed once however it got there.
//   - Platform roles (what Caller Whale's own staff are): kept in their own group with their own labels, because the word "owner"
//     means two different things: the platform owner, and the agency owner who runs one workspace.
//
// A workspace cannot save a custom role under a standard role's name or a platform role's name: that would make two different
// things share one label, or quietly change a standard role for everyone who holds it.

import (
	"net/http"
	"slices"
	"sort"
	"strings"
)

// catalogRole is a workspace role as the dashboards list it.
type catalogRole struct {
	Key          string   `json:"key"`
	Name         string   `json:"name"`
	Source       string   `json:"source"` // preset: every workspace has it; custom: this workspace added it
	Capabilities []string `json:"capabilities"`
	Scope        string   `json:"scope"`
	SecondStep   bool     `json:"second_step"`
	Assignable   bool     `json:"assignable"` // false for the roles that belong to whoever opened the workspace
}

// platformRoleNames are the roles of Caller Whale's own staff, in the order of the ladder, with the words people read.
var platformRoleNames = []struct{ Key, Name string }{
	{"owner", "Platform owner"},
	{"cofounder", "Cofounder"},
	{"system_admin", "System admin"},
	{"tester", "Tester"},
}

// platformRole is true for a key on the staff ladder: never a workspace role, even one stored under that key long ago.
func platformRole(key string) bool {
	return slices.ContainsFunc(platformRoleNames, func(p struct{ Key, Name string }) bool { return p.Key == key })
}

// reservedKeys cannot be used for a custom role: the standard roles, the platform roles, and "admin" (a capability, never a role).
func reserved(key string) bool {
	for _, p := range presets {
		if p.key == key {
			return true
		}
	}
	for _, p := range platformRoleNames {
		if p.Key == key {
			return true
		}
	}
	return key == "admin"
}

// roleTitle turns a custom role's key into words: senior_closer becomes "Senior closer".
func roleTitle(key string) string {
	words := strings.ReplaceAll(key, "_", " ")
	if words == "" {
		return key
	}
	return strings.ToUpper(words[:1]) + words[1:]
}

// buildCatalog lists the standard roles first, in their usual order, then the workspace's own, by key. A stored role with a
// standard role's key (kept from before that was refused) is shown once, as the standard role, with what the workspace stored.
func buildCatalog(stored []role) []catalogRole {
	byKey := map[string]role{}
	for _, r := range stored {
		byKey[r.Key] = r
	}
	out := make([]catalogRole, 0, len(presets)+len(stored))
	seen := map[string]bool{}
	for _, p := range presets {
		if disabledRoles[p.key] {
			continue
		}
		entry := catalogRole{Key: p.key, Name: p.name, Source: "preset", Capabilities: slices.Clone(p.capabilities), Scope: p.scope, SecondStep: p.secondStep}
		if kept, ok := byKey[p.key]; ok {
			entry.Capabilities, entry.Scope, entry.SecondStep = slices.Clone(kept.Capabilities), kept.Scope, kept.SecondStep
		}
		entry.Assignable = !slices.Contains(heldRoles, p.key)
		out = append(out, entry)
		seen[p.key] = true
	}
	custom := []catalogRole{}
	for _, r := range stored {
		if seen[r.Key] || disabledRoles[r.Key] || platformRole(r.Key) {
			continue
		}
		seen[r.Key] = true
		custom = append(custom, catalogRole{Key: r.Key, Name: roleTitle(r.Key), Source: "custom", Capabilities: slices.Clone(r.Capabilities), Scope: r.Scope, SecondStep: r.SecondStep, Assignable: !slices.Contains(heldRoles, r.Key)})
	}
	sort.Slice(custom, func(i, j int) bool { return custom[i].Key < custom[j].Key })
	return append(out, custom...)
}

// catalog answers "which roles exist" with no workspace in mind: the standard roles and the platform roles.
func (s *server) catalog(w http.ResponseWriter, r *http.Request) error {
	platform := make([]map[string]string, 0, len(platformRoleNames))
	for _, p := range platformRoleNames {
		if disabledRoles[p.Key] {
			continue
		}
		platform = append(platform, map[string]string{"key": p.Key, "name": p.Name})
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspace": buildCatalog(nil), "platform": platform})
	return nil
}
