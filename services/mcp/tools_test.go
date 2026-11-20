package main

import (
	"slices"
	"strings"
	"testing"
)

// Step 24: the tools that read people and ask for changes are listed only for a connection given team:manage, and none of them can
// spend money (D130, D131).
func TestTeamToolsNeedTheirPermission(t *testing.T) {
	names := func(scope string) []string {
		out := []string{}
		for _, tool := range toolList(&who{Scope: scope}) {
			out = append(out, tool.Name)
		}
		return out
	}
	if got := names("account:read"); slices.Contains(got, "list_people") || slices.Contains(got, "request_change") {
		t.Fatalf("team tools without team:manage: %v", got)
	}
	if got := names("account:read team:manage"); !slices.Contains(got, "list_people") || !slices.Contains(got, "request_change") {
		t.Fatalf("team tools with team:manage: %v", got)
	}
	for _, tool := range allTools {
		text := strings.ToLower(tool.Name + " " + tool.Description)
		if tool.Name == "request_change" {
			kinds := tool.InputSchema["properties"].(map[string]any)["kind"].(map[string]any)["enum"].([]string)
			for _, k := range kinds {
				if strings.Contains(k, "pay") || strings.Contains(k, "plan") || strings.Contains(k, "budget") || strings.Contains(k, "seat") {
					t.Fatalf("a change that spends money: %s", k)
				}
			}
		}
		_ = text
	}
}
