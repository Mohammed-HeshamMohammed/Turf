package crm

import (
	"context"
	"testing"
)

// Step 17: a solo workspace becomes an agency in place: a first team named after its operator, led by them, holding all their leads
// (D59, D203). Doing it twice is refused; an agency owner cannot.
func TestASoloWorkspaceUpgradesInPlace(t *testing.T) {
	e := newEnv(t)
	e.seed()
	solo := owner()
	solo.Roles = []string{"solo"}
	e.rules.grants[alice+"|"+orgA] = solo
	for _, name := range []string{"Pat Owner", "Lee Seller"} {
		e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": newID(t), "name": name, "phone": "555-0100"}), "applied")
	}
	status, out := e.call(alice, orgA, "POST", "/api/v1/workspace/upgrade", nil)
	if status != 200 || out["leads_moved"] != float64(2) {
		t.Fatalf("upgrade: %d %v", status, out)
	}
	team := out["team"].(map[string]any)
	if team["name"] != "Person 1111's team" {
		t.Fatalf("the first team is named after them: %v", team)
	}
	var without int
	if err := e.admin.QueryRow(context.Background(), `SELECT count(*) FROM crm.leads WHERE org_id = $1 AND team_id IS DISTINCT FROM $2::uuid`, orgA, team["id"]).Scan(&without); err != nil || without != 0 {
		t.Fatalf("leads outside the first team: %d %v", without, err)
	}
	if status, out := e.call(alice, orgA, "POST", "/api/v1/workspace/upgrade", nil); status != 409 || out["error"].(map[string]any)["code"] != "not_solo" {
		t.Fatalf("upgrading twice: %d %v", status, out)
	}
}
