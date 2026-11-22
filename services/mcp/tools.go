package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// The tools an assistant may use. Every tool names the scope it needs; a tool the person did not allow is not even listed. With
// team:manage an assistant reads the agency's people and teams and asks for changes, which wait for the person to
// confirm inside Caller Whale (D130). No tool spends money, and none can (D131).

type tool struct {
	Name        string         `json:"name"`
	Title       string         `json:"title"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations map[string]any `json:"annotations"`
	scope       string
}

var readOnly = map[string]any{"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}

var allTools = []tool{
	{
		Name: "whoami", Title: "Who am I", scope: "account:read",
		Description: "Says whose Caller Whale account this connection is for: name, email, any Caller Whale staff role, and the workspaces they belong to with their role in each.",
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false},
		Annotations: readOnly,
	},
	{
		Name: "plan_and_usage", Title: "Plan and usage", scope: "account:read",
		Description: "Says which plan a workspace is on, whether it is in good standing, when the period ends, and how many call minutes have been used out of those included. Leave workspace_id out to see every workspace.",
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{
			"workspace_id": map[string]any{"type": "string", "description": "A workspace id from whoami. Leave out for all of them."},
		}, "additionalProperties": false},
		Annotations: readOnly,
	},
	{
		Name: "list_people", Title: "People and teams", scope: "team:manage",
		Description: "Lists the people of a workspace with their roles and teams, and its teams with their leads. For the workspace's owner, admins and team leads.",
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{
			"workspace_id": map[string]any{"type": "string", "description": "A workspace id from whoami."},
		}, "required": []string{"workspace_id"}, "additionalProperties": false},
		Annotations: readOnly,
	},
	{
		Name: "request_change", Title: "Ask for a change", scope: "team:manage",
		Description: "Asks for a change to a workspace's people: invite (email, roles, team_ids), remove (user_id, reason), change_roles (user_id, roles, team_ids), delete_team (team_id) or cancel_invitation (invitation_id). Nothing changes until the person confirms it inside Caller Whale. Payments, plans, seats and budgets cannot be asked for.",
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{
			"workspace_id": map[string]any{"type": "string"},
			"kind":         map[string]any{"type": "string", "enum": []string{"invite", "remove", "change_roles", "delete_team", "cancel_invitation"}},
			"args":         map[string]any{"type": "object", "description": "The details of the change, as listed for its kind."},
		}, "required": []string{"workspace_id", "kind", "args"}, "additionalProperties": false},
		Annotations: map[string]any{"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false},
	},
}

func toolList(person *who) []tool {
	list := []tool{}
	for _, t := range allTools {
		if person.allows(t.scope) {
			list = append(list, t)
		}
	}
	return list
}

func toolText(text string, isError bool) map[string]any {
	return map[string]any{"content": []map[string]any{{"type": "text", "text": text}}, "isError": isError}
}

func (s *server) callTool(person *who, token, name string, args json.RawMessage) map[string]any {
	for _, t := range allTools {
		if t.Name != name {
			continue
		}
		if !person.allows(t.scope) {
			return toolText("This connection was not allowed to do that.", true)
		}
		switch name {
		case "whoami":
			return toolText(whoamiText(person), false)
		case "list_people":
			return s.listPeople(token, args)
		case "request_change":
			return s.requestChange(token, args)
		case "plan_and_usage":
			return s.planAndUsage(person, token, args)
		}
	}
	return toolText("There is no tool called "+name+".", true)
}

func whoamiText(p *who) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Name: %s\nEmail: %s\n", p.Name, p.Email)
	if p.PlatformRole != "" {
		fmt.Fprintf(&b, "Caller Whale staff role: %s\n", p.PlatformRole)
	}
	if len(p.Workspaces) == 0 {
		b.WriteString("Workspaces: none yet.\n")
	}
	for _, w := range p.Workspaces {
		roles := strings.Join(w.Roles, ", ")
		if w.BusinessOwner {
			roles = strings.TrimPrefix(roles+", agency owner", ", ")
		}
		if roles == "" {
			roles = "member"
		}
		fmt.Fprintf(&b, "Workspace %s: %s\n", w.OrgID, roles)
	}
	fmt.Fprintf(&b, "Connected through: %s\n", p.ClientName)
	return b.String()
}

type plan struct {
	OrgID           string   `json:"org_id"`
	Plan            string   `json:"plan"`
	PlanName        string   `json:"plan_name"`
	Status          string   `json:"status"`
	PeriodEnd       string   `json:"period_end"`
	Seats           int      `json:"seats"`
	MinutesAllowed  int64    `json:"minutes_allowed"`
	MinutesUsed     int64    `json:"minutes_used"`
	PaymentRequired bool     `json:"payment_required"`
	PercentUsed     *float64 `json:"percent_used"`
}

func (s *server) planAndUsage(person *who, token string, args json.RawMessage) map[string]any {
	var in struct {
		WorkspaceID string `json:"workspace_id"`
	}
	if len(args) > 0 {
		_ = json.Unmarshal(args, &in)
	}
	var orgs []string
	for _, w := range person.Workspaces {
		if in.WorkspaceID == "" || w.OrgID == in.WorkspaceID {
			orgs = append(orgs, w.OrgID)
		}
	}
	if len(orgs) == 0 {
		if in.WorkspaceID != "" {
			return toolText("That is not one of your workspaces. Use whoami to see them.", true)
		}
		return toolText("You are not in a workspace yet, so there is no plan to show.", false)
	}
	var b strings.Builder
	for _, org := range orgs {
		var p plan
		if err := s.askAuth("/v1/connectors/standing", map[string]any{"token": token, "org": org}, &p); err != nil {
			fmt.Fprintf(&b, "Workspace %s: the plan could not be read right now.\n", org)
			continue
		}
		fmt.Fprintf(&b, "Workspace %s: %s plan, %s.", org, p.PlanName, orElse(p.Status, "no status"))
		if p.PeriodEnd != "" {
			fmt.Fprintf(&b, " Period ends %s.", p.PeriodEnd)
		}
		if p.MinutesAllowed > 0 {
			fmt.Fprintf(&b, " Call minutes used: %d of %d", p.MinutesUsed, p.MinutesAllowed)
			if p.PercentUsed != nil {
				fmt.Fprintf(&b, " (%.0f%%)", *p.PercentUsed)
			}
			b.WriteString(".")
		}
		if p.PaymentRequired {
			b.WriteString(" A payment is needed to keep the plan.")
		}
		b.WriteString("\n")
	}
	return toolText(b.String(), false)
}

func orElse(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func (s *server) listPeople(token string, args json.RawMessage) map[string]any {
	var in struct {
		WorkspaceID string `json:"workspace_id"`
	}
	_ = json.Unmarshal(args, &in)
	var out struct {
		People []struct {
			UserID    string   `json:"user_id"`
			Name      string   `json:"name"`
			Roles     []string `json:"roles"`
			TeamIDs   []string `json:"team_ids"`
			Suspended bool     `json:"suspended"`
		} `json:"people"`
		Teams []struct {
			TeamID  string   `json:"team_id"`
			Name    string   `json:"name"`
			LeadIDs []string `json:"lead_ids"`
		} `json:"teams"`
	}
	if err := s.askAuth("/v1/connectors/people", map[string]any{"token": token, "org": in.WorkspaceID}, &out); err != nil {
		return toolText("The people of that workspace cannot be read: only its owner, admins and team leads see them.", true)
	}
	var b strings.Builder
	b.WriteString("People:\n")
	for _, p := range out.People {
		fmt.Fprintf(&b, "- %s (%s): %s", orElse(p.Name, "unnamed"), p.UserID, strings.Join(p.Roles, ", "))
		if len(p.TeamIDs) > 0 {
			fmt.Fprintf(&b, "; teams %s", strings.Join(p.TeamIDs, ", "))
		}
		if p.Suspended {
			b.WriteString("; suspended")
		}
		b.WriteString("\n")
	}
	b.WriteString("Teams:\n")
	for _, t := range out.Teams {
		fmt.Fprintf(&b, "- %s (%s); leads %s\n", t.Name, t.TeamID, strings.Join(t.LeadIDs, ", "))
	}
	return toolText(b.String(), false)
}

func (s *server) requestChange(token string, args json.RawMessage) map[string]any {
	var in struct {
		WorkspaceID string          `json:"workspace_id"`
		Kind        string          `json:"kind"`
		Args        json.RawMessage `json:"args"`
	}
	_ = json.Unmarshal(args, &in)
	var out struct {
		Summary string `json:"summary"`
		Message string `json:"message"`
	}
	if err := s.askAuth("/v1/connectors/requests", map[string]any{"token": token, "org": in.WorkspaceID, "kind": in.Kind, "args": in.Args}, &out); err != nil {
		var ae *authError
		if errors.As(err, &ae) && strings.Contains(ae.body, "error") {
			var refused struct {
				Error string `json:"error"`
			}
			_ = json.Unmarshal([]byte(ae.body), &refused)
			if refused.Error != "" {
				return toolText(refused.Error, true)
			}
		}
		return toolText("The change could not be asked for right now.", true)
	}
	return toolText(out.Summary+": "+out.Message, false)
}
