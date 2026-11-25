package crm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"
)

const (
	alice   = "11111111-1111-4111-8111-111111111111"
	bob     = "22222222-2222-4222-8222-222222222222"
	carol   = "33333333-3333-4333-8333-333333333333"
	orgA    = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	orgB    = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	missing = "99999999-9999-4999-8999-999999999999"
)

func TestImportMappingAcceptsPropertyAndMailingFields(t *testing.T) {
	for _, field := range []string{"living_area", "bedrooms", "owner_mailing_address", "owner_2_first_name", "status_time"} {
		if !validImportField(field, map[string]any{}) {
			t.Errorf("missing source field %s", field)
		}
	}
	if !validImportField("owner_5_first_name", map[string]any{"source_detail": "Owner 5 first name", "standard_key": "owner_5_first_name"}) {
		t.Fatal("numbered owners from later lists should remain selectable")
	}
	if validImportField("invented_field", map[string]any{}) {
		t.Fatal("unknown import field accepted")
	}
}

func (e *env) seed() {
	e.rules.grants[alice+"|"+orgA] = owner()
	e.rules.grants[bob+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"own"}, Capabilities: []string{"edit", "call", "handoff", "accept"}}
	e.rules.grants[carol+"|"+orgB] = owner()
	e.rules.people_[alice] = peopleReply{UserID: alice, Workspaces: []workspaceRoles{{OrgID: orgA, Roles: []string{"owner"}, BusinessOwner: true}}}
	e.rules.people_[bob] = peopleReply{UserID: bob, Workspaces: []workspaceRoles{{OrgID: orgA, Roles: []string{"caller"}}}}
	e.rules.people_[carol] = peopleReply{UserID: carol, Workspaces: []workspaceRoles{{OrgID: orgB, Roles: []string{"owner"}, BusinessOwner: true}}}
	e.rules.roster[orgA] = []member{{UserID: alice, Roles: []string{"owner"}}, {UserID: bob, Roles: []string{"caller"}}}
}

func TestMeListsWorkspacesAndWhatThePersonMayDo(t *testing.T) {
	e := newEnv(t)
	e.seed()
	status, me := e.call(alice, "", "GET", "/api/v1/me", nil)
	if status != 200 || me["organization_id"] != orgA {
		t.Fatalf("me: %d %v", status, me)
	}
	orgs := me["organizations"].([]any)
	if len(orgs) != 1 || orgs[0].(map[string]any)["name"] != "Person 1111's workspace" {
		t.Fatalf("a workspace is named after the person who opened it: %v", orgs)
	}
	if got := e.rules.nameOf(orgA); got != "Person 1111's workspace" {
		t.Fatalf("authz is told the owner's agency name, so invitations can name it: %q", got)
	}
	if status, _ := e.call(alice, orgA, "PATCH", "/api/v1/organization", map[string]any{"name": "Blue Door Homes"}); status != 200 {
		t.Fatalf("rename: %d", status)
	}
	if got := e.rules.nameOf(orgA); got != "Blue Door Homes" {
		t.Fatalf("a renamed agency is told to authz: %q", got)
	}
	if status, _ := e.call(alice, orgA, "PATCH", "/api/v1/organization", map[string]any{"name": "Two\nlines"}); status != 400 {
		t.Fatalf("a name on two lines is refused: %d", status)
	}
	if caps := me["capabilities"].([]any); len(caps) != len(everything) {
		t.Fatalf("capabilities: %v", caps)
	}
	if me["subscription"].(map[string]any)["usable"] != true {
		t.Fatal("an active workspace is usable")
	}

	// A workspace that needs payment still answers, saying so, so the app can tell the person what to do.
	e.rules.grants[alice+"|"+orgA] = grantReply{Code: "payment_required", Reason: "The trial has ended."}
	_, me = e.call(alice, orgA, "GET", "/api/v1/me", nil)
	if sub := me["subscription"].(map[string]any); sub["usable"] != false || sub["reason"] != "The trial has ended." {
		t.Fatalf("payment required: %v", sub)
	}
	// and refuses the records.
	if status, _ = e.call(alice, orgA, "GET", "/sync/snapshot", nil); status != http.StatusPaymentRequired {
		t.Fatalf("snapshot while unpaid: %d", status)
	}
	// A second step not yet passed is told apart from a refusal.
	e.rules.grants[alice+"|"+orgA] = grantReply{Code: "second_step_required", Reason: "Confirm with your authenticator."}
	_, me = e.call(alice, orgA, "GET", "/api/v1/me", nil)
	if mfa := me["mfa"].(map[string]any); mfa["required"] != true || mfa["passed"] != false {
		t.Fatalf("second step: %v", mfa)
	}
}

func TestMeRemembersSelectedWorkspace(t *testing.T) {
	e := newEnv(t)
	e.seed()
	e.rules.grants[alice+"|"+orgB] = owner()
	e.rules.people_[alice] = peopleReply{UserID: alice, Workspaces: []workspaceRoles{
		{OrgID: orgA, Roles: []string{"owner"}, BusinessOwner: true},
		{OrgID: orgB, Roles: []string{"owner"}, BusinessOwner: true},
	}}
	status, me := e.call(alice, orgB, "GET", "/api/v1/me", nil)
	if status != 200 || me["organization_id"] != orgB || me["last_workspace_at"] == nil {
		t.Fatalf("select second workspace: %d %v", status, me)
	}
	status, me = e.call(alice, "", "GET", "/api/v1/me", nil)
	if status != 200 || me["organization_id"] != orgB {
		t.Fatalf("remember second workspace: %d %v", status, me)
	}
	status, me = e.call(alice, orgA, "GET", "/api/v1/me", nil)
	if status != 200 || me["organization_id"] != orgA {
		t.Fatalf("switch back: %d %v", status, me)
	}
}

func TestNothingWithoutAGoodTokenOrAMembership(t *testing.T) {
	e := newEnv(t)
	e.seed()
	req, _ := http.NewRequest("GET", e.ts.URL+"/api/v1/me", nil)
	if res, _ := http.DefaultClient.Do(req); res.StatusCode != 401 {
		t.Fatalf("no token: %d", res.StatusCode)
	}
	if status, _ := e.call(alice, orgB, "GET", "/sync/snapshot", nil); status != 403 {
		t.Fatalf("someone else's workspace: %d", status)
	}
	if status, _ := e.call(alice, "", "GET", "/sync/snapshot", nil); status != 400 {
		t.Fatalf("no workspace named: %d", status)
	}
	e.rules.down = true
	if status, _ := e.call(alice, orgA, "GET", "/sync/snapshot", nil); status != 503 {
		t.Fatalf("authz down must refuse, not guess: %d", status)
	}
}

func TestALeadsWholeLifeThroughSync(t *testing.T) {
	e := newEnv(t)
	e.seed()
	_, snap := e.call(alice, orgA, "GET", "/sync/snapshot", nil)
	cursor, rev := snap["cursor"].(float64), snap["access_revision"].(float64)

	leadID := newID(t)
	created := e.want(e.opWith(alice, orgA, "lead.create", map[string]any{"id": leadID, "name": "Pat Owner", "phone": "555-0100", "address": "1 Main St", "city": "Austin", "zip": "78701", "latitude": 30.27, "longitude": -97.74}, "d0000000-0000-4000-8000-000000000001"), "applied")
	if created["id"] != leadID || created["assignee_id"] != alice {
		t.Fatalf("created: %v", created)
	}
	// The same operation again is a duplicate with the first answer.
	if dup := e.opWith(alice, orgA, "lead.create", map[string]any{"name": "Pat Owner"}, "d0000000-0000-4000-8000-000000000001"); dup["status"] != "duplicate" || dup["original_status"] != "applied" {
		t.Fatalf("replay: %v", dup)
	}
	// Another person cannot probe an operation id they did not send.
	if other := e.opWith(carol, orgB, "lead.create", map[string]any{"name": "x"}, "d0000000-0000-4000-8000-000000000001"); other["status"] != "rejected" {
		t.Fatalf("foreign id: %v", other)
	}

	// An edit made from a stale value is a conflict, and applies nothing.
	e.want(e.op(alice, orgA, "lead.update", map[string]any{"id": leadID, "changes": map[string]any{"stage": "Contacted"}, "base": map[string]any{"stage": "New"}}), "applied")
	conflict := e.op(alice, orgA, "lead.update", map[string]any{"id": leadID, "changes": map[string]any{"stage": "Interested"}, "base": map[string]any{"stage": "New"}})
	if conflict["status"] != "conflict" || conflict["result"].(map[string]any)["fields"].(map[string]any)["stage"].(map[string]any)["server"] != "Contacted" {
		t.Fatalf("conflict: %v", conflict)
	}
	if bad := e.op(alice, orgA, "lead.update", map[string]any{"id": leadID, "changes": map[string]any{"stage": "Nonsense"}, "base": map[string]any{}}); bad["status"] != "rejected" {
		t.Fatalf("unknown stage: %v", bad)
	}

	e.want(e.op(alice, orgA, "note.add", map[string]any{"lead_id": leadID, "body": "Call after five."}), "applied")
	// A callback outcome moves the lead and leaves exactly one open callback task.
	e.want(e.op(alice, orgA, "call.record", map[string]any{"lead_id": leadID, "outcome": "Callback", "callback_at": "2026-12-01T15:00:00Z"}), "applied")
	e.want(e.op(alice, orgA, "call.record", map[string]any{"lead_id": leadID, "outcome": "Voicemail"}), "applied")
	var open int
	if err := e.admin.QueryRow(context.Background(), `SELECT count(*) FROM crm.tasks WHERE lead_id = $1 AND type = 'Callback' AND done_at IS NULL`, leadID).Scan(&open); err != nil || open != 1 {
		t.Fatalf("open callback tasks: %d %v", open, err)
	}
	if status, _ := e.call(alice, orgA, "GET", "/sync/pull?cursor=0&access_revision="+strconv.FormatInt(int64(rev), 10), nil); status != 200 {
		t.Fatalf("pull: %d", status)
	}

	// Pull brings every change since the cursor, once per record.
	_, pulled := e.call(alice, orgA, "GET", "/sync/pull?cursor="+strconv.FormatInt(int64(cursor), 10)+"&access_revision="+strconv.FormatInt(int64(rev), 10), nil)
	entities := map[string]int{}
	for _, c := range pulled["changes"].([]any) {
		entities[c.(map[string]any)["entity"].(string)]++
	}
	if entities["lead"] != 1 || entities["note"] != 1 || entities["call"] != 2 || entities["task"] < 1 {
		t.Fatalf("pulled: %v", entities)
	}
	// A deal, then removing the lead tells every device to drop it.
	deal := e.want(e.op(alice, orgA, "deal.create", map[string]any{"lead_id": leadID, "amount": 120000, "fee": 8000}), "applied")
	e.want(e.op(alice, orgA, "deal.update", map[string]any{"id": deal["id"], "changes": map[string]any{"stage": "Closed lost"}, "base": map[string]any{"stage": "Qualified"}}), "rejected")
	e.want(e.op(alice, orgA, "lead.delete", map[string]any{"id": leadID}), "applied")
	var stored int
	if err := e.admin.QueryRow(context.Background(), `SELECT count(*) FROM crm.leads WHERE id = $1`, leadID).Scan(&stored); err != nil || stored != 0 {
		t.Fatalf("deleted lead still stored: %d %v", stored, err)
	}
	_, after := e.call(alice, orgA, "GET", "/sync/pull?cursor="+strconv.FormatInt(int64(pulled["cursor"].(float64)), 10)+"&access_revision="+strconv.FormatInt(int64(rev), 10), nil)
	removed := false
	for _, c := range after["changes"].([]any) {
		m := c.(map[string]any)
		removed = removed || (m["entity"] == "lead" && m["id"] == leadID && m["op"] == "remove")
	}
	if !removed {
		t.Fatalf("a deleted lead must arrive as a removal: %v", after)
	}
	// A device holding an old access revision is told to start over.
	_, reset := e.call(alice, orgA, "GET", "/sync/pull?cursor=0&access_revision=1", nil)
	if reset["reset"] != true {
		t.Fatalf("stale revision: %v", reset)
	}
}

func TestEachPersonSeesOnlyTheirWorkspaceAndScope(t *testing.T) {
	e := newEnv(t)
	e.seed()
	mine, theirs, bobs := newID(t), newID(t), newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": mine, "name": "Alice's lead"}), "applied")
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": bobs, "name": "Bob's lead", "assignee_id": bob}), "applied")
	e.want(e.op(carol, orgB, "lead.create", map[string]any{"id": theirs, "name": "Other workspace"}), "applied")

	_, snap := e.call(alice, orgA, "GET", "/sync/snapshot", nil)
	if n := len(snap["leads"].([]any)); n != 2 {
		t.Fatalf("an organization-wide role sees its own workspace's two leads, not %d", n)
	}
	_, snap = e.call(bob, orgA, "GET", "/sync/snapshot", nil)
	leads := snap["leads"].([]any)
	if len(leads) != 1 || leads[0].(map[string]any)["name"] != "Bob's lead" {
		t.Fatalf("a caller sees only what is assigned to them: %v", leads)
	}
	// Bob cannot edit, or even learn of, Alice's lead.
	if res := e.op(bob, orgA, "lead.update", map[string]any{"id": mine, "changes": map[string]any{"stage": "Contacted"}, "base": map[string]any{}}); res["status"] != "rejected" {
		t.Fatalf("outside scope: %v", res)
	}
	// Row security holds even for a query that forgets to name the workspace.
	tx, err := e.s.st.begin(context.Background(), scope{userID: carol, orgID: orgB, scopes: []string{"organization"}})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	var n int
	if err = tx.QueryRow(context.Background(), `SELECT count(*) FROM leads`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("a bare select inside a workspace: %d %v", n, err)
	}
}

func TestAHandoffMovesTheLeadOnlyWhenAccepted(t *testing.T) {
	e := newEnv(t)
	e.seed()
	lead := newID(t)
	e.want(e.op(bob, orgA, "lead.create", map[string]any{"id": lead, "name": "Handoff lead"}), "applied")
	e.rules.grants[carol+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"own"}, Capabilities: []string{"accept", "edit"}}
	e.rules.grants[alice+"|"+orgA] = owner()
	req := e.want(e.op(bob, orgA, "handoff.request", map[string]any{"lead_id": lead, "to_user": alice, "note": "Ready for the closer."}), "applied")
	if again := e.op(bob, orgA, "handoff.request", map[string]any{"lead_id": lead, "to_user": alice, "note": "Again"}); again["status"] != "rejected" {
		t.Fatalf("a second open handoff: %v", again)
	}
	// Bob cannot accept his own handoff.
	if res := e.op(bob, orgA, "handoff.decide", map[string]any{"id": req["id"], "decision": "accept"}); res["status"] != "rejected" {
		t.Fatalf("the requester accepting: %v", res)
	}
	e.want(e.op(alice, orgA, "handoff.decide", map[string]any{"id": req["id"], "decision": "accept"}), "applied")
	var assignee, stage string
	if err := e.admin.QueryRow(context.Background(), `SELECT assignee_id::text, stage FROM crm.leads WHERE id = $1`, lead).Scan(&assignee, &stage); err != nil || assignee != alice || stage != "Qualified" {
		t.Fatalf("after accept: %s %s %v", assignee, stage, err)
	}
	var deals int
	_ = e.admin.QueryRow(context.Background(), `SELECT count(*) FROM crm.deals WHERE lead_id = $1`, lead).Scan(&deals)
	if deals != 1 {
		t.Fatalf("accepting opens the deal: %d", deals)
	}
	// Offline queues may not carry changes that need a connection.
	status, out := e.call(alice, orgA, "POST", "/api/v1/ops", map[string]any{"id": newID(t), "kind": "lead.delete", "queued_offline": true, "payload": map[string]any{"id": lead}})
	if status != 200 || out["status"] != "rejected" {
		t.Fatalf("offline delete: %v", out)
	}
}

func TestDirectoryNamesPeopleAndProjectsAreListed(t *testing.T) {
	e := newEnv(t)
	e.seed()
	e.call(bob, orgA, "GET", "/sync/snapshot", nil) // Bob has used the CRM, so his name is known
	e.call(alice, orgA, "GET", "/sync/snapshot", nil)
	res, raw := e.raw(alice, orgA, "GET", "/api/v1/directory", nil, nil)
	var people []map[string]any
	_ = json.Unmarshal(raw, &people)
	if res != 200 || len(people) != 2 || people[0]["name"] == "Member" || people[0]["tag"] != "K7P2" {
		t.Fatalf("directory: %d %v", res, people)
	}
	status, project := e.call(alice, orgA, "POST", "/api/v1/projects", map[string]any{"name": "Austin owners"})
	if status != 200 || project["name"] != "Austin owners" {
		t.Fatalf("create project: %d %v", status, project)
	}
	if status, _ = e.call(bob, orgA, "POST", "/api/v1/projects", map[string]any{"name": "No"}); status != 403 {
		t.Fatalf("a caller creating a list: %d", status)
	}
}

func TestSourceRowsAreVisibleBeforeLeadMergeOnlyToTheirImporter(t *testing.T) {
	e := newEnv(t)
	e.seed()
	_, job := e.startImport(alice, orgA, map[string]any{"filename": "owners.csv", "size": 100, "name": "Owners"})
	id := job["id"].(string)
	for n, name := range []string{"Mary Randel", "Maricela Moreno"} {
		if _, err := e.admin.Exec(context.Background(), `INSERT INTO importing.rows (job_id, row_no, fp, cells, state)
			VALUES ($1, $2, sha256($3::bytea), ARRAY[$4, '3307 Lily St'], 'loaded')`, id, n+1, []byte(name), name); err != nil {
			t.Fatal(err)
		}
	}
	status, page := e.call(alice, orgA, "GET", "/api/v1/imports/"+id+"/rows?offset=1", nil)
	rows, _ := page["rows"].([]any)
	if status != 200 || page["total"] != float64(2) || len(rows) != 1 || rows[0].(map[string]any)["state"] != "loaded" {
		t.Fatalf("unprocessed source row: %d %v", status, page)
	}
	for _, user := range []string{bob, carol} {
		org := orgA
		if user == carol {
			org = orgB
		}
		if status, _ := e.call(user, org, "GET", "/api/v1/imports/"+id+"/rows", nil); status != 404 {
			t.Fatalf("another person's source rows: %d", status)
		}
	}
}

func TestFailedImportCleanupRemovesEmptyListsButKeepsExistingLeads(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	start := func() (string, string) {
		status, job := e.startImport(alice, orgA, map[string]any{"filename": "owners.csv", "size": 100, "name": "Owners"})
		if status != 200 {
			t.Fatalf("start import: %d %v", status, job)
		}
		return job["id"].(string), job["project_id"].(string)
	}
	first, empty := start()
	if status, _ := e.call(alice, orgA, "DELETE", "/api/v1/imports/"+first, nil); status != 400 {
		t.Fatalf("active import removed: %d", status)
	}
	if _, err := e.admin.Exec(ctx, `UPDATE importing.jobs SET status = 'failed' WHERE id = $1`, first); err != nil {
		t.Fatal(err)
	}
	if status, _ := e.call(bob, orgA, "DELETE", "/api/v1/imports/"+first, nil); status != 403 {
		t.Fatalf("caller removed import: %d", status)
	}
	status, removed := e.call(alice, orgA, "DELETE", "/api/v1/imports/"+first, nil)
	if status != 200 || removed["removed_project"] != empty {
		t.Fatalf("failed import cleanup: %d %v", status, removed)
	}
	var count int
	if err := e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.projects WHERE id = $1`, empty).Scan(&count); err != nil || count != 0 {
		t.Fatalf("empty list remained: %d %v", count, err)
	}
	second, populated := start()
	var leadID string
	if err := e.admin.QueryRow(ctx, `INSERT INTO crm.leads (org_id, project_id, name) VALUES ($1, $2, 'Remove me') RETURNING id::text`, orgA, populated).Scan(&leadID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admin.Exec(ctx, `INSERT INTO crm.notes (org_id, lead_id, body) VALUES ($1, $2, 'Related note')`, orgA, leadID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admin.Exec(ctx, `UPDATE importing.jobs SET status = 'failed' WHERE id = $1`, second); err != nil {
		t.Fatal(err)
	}
	status, removed = e.call(alice, orgA, "DELETE", "/api/v1/imports/"+second, nil)
	if status != 200 || removed["removed_project"] != "" {
		t.Fatalf("populated list removed with import: %d %v", status, removed)
	}
	status, removed = e.call(alice, orgA, "DELETE", "/api/v1/projects/"+populated, nil)
	if status != 200 || removed["deleted_leads"] != float64(1) {
		t.Fatalf("populated list deletion: %d %v", status, removed)
	}
	if err := e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.leads WHERE id = $1`, leadID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("lead remained after source list deletion: %d %v", count, err)
	}
	if err := e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.notes WHERE lead_id = $1`, leadID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("related note remained after source list deletion: %d %v", count, err)
	}
	if err := e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.change_log WHERE entity = 'lead' AND entity_id = $1 AND op = 'delete'`, leadID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("other devices cannot learn of the deletion: %d %v", count, err)
	}
	third, emptyAgain := start()
	if status, _ := e.call(bob, orgA, "DELETE", "/api/v1/projects/"+emptyAgain, nil); status != 403 {
		t.Fatalf("caller deleted list: %d", status)
	}
	// Deleting a list stops an import still running into it, and goes ahead.
	if status, _ := e.call(alice, orgA, "DELETE", "/api/v1/projects/"+emptyAgain, nil); status != 200 {
		t.Fatalf("a list with an import still running was not removed: %d", status)
	}
	if err := e.admin.QueryRow(ctx, `SELECT count(*) FROM importing.jobs WHERE id = $1`, third).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed import remained after list deletion: %d %v", count, err)
	}
}

func TestLiveEventsReachOnlyTheSameWorkspace(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	dial := func(user, org string) *websocket.Conn {
		conn, _, err := websocket.Dial(ctx, "ws"+e.ts.URL[4:]+"/events", &websocket.DialOptions{Subprotocols: []string{"callerwhale.v1", "bearer." + e.token(user), "org." + org}})
		if err != nil {
			t.Fatal(err)
		}
		_, hello, err := conn.Read(ctx)
		if err != nil || string(hello) != `{"kind":"hello"}` {
			t.Fatalf("hello: %s %v", hello, err)
		}
		return conn
	}
	a, c := dial(alice, orgA), dial(carol, orgB)
	defer a.CloseNow()
	defer c.CloseNow()
	time.Sleep(300 * time.Millisecond) // the database listener is already running; give it a moment
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"name": "Live"}), "applied")
	_, msg, err := a.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	_ = json.Unmarshal(msg, &event)
	if event["kind"] != "lead.created" || event["entity"] != "lead" {
		t.Fatalf("event: %s", msg)
	}
	quiet, stop := context.WithTimeout(ctx, 700*time.Millisecond)
	defer stop()
	if _, got, err := c.Read(quiet); err == nil {
		t.Fatalf("another workspace heard: %s", got)
	}
	// A socket without a good token never opens.
	if _, res, err := websocket.Dial(ctx, "ws"+e.ts.URL[4:]+"/events", &websocket.DialOptions{Subprotocols: []string{"callerwhale.v1", "bearer.junk", "org." + orgA}}); err == nil || res == nil || res.StatusCode != 401 {
		t.Fatalf("junk token: %v %v", res, err)
	}
}

func TestUploadEndpointsBelongToWorker(t *testing.T) {
	e := newEnv(t)
	e.seed()
	for _, test := range []struct{ method, path string }{{"POST", "/api/v1/imports"}, {"PUT", "/api/v1/imports/11111111-1111-4111-8111-111111111111/chunks/0"}, {"POST", "/api/v1/imports/11111111-1111-4111-8111-111111111111/complete"}} {
		if status, _ := e.call(alice, orgA, test.method, test.path, nil); status != 404 && status != 405 {
			t.Fatalf("core handled %s %s: %d", test.method, test.path, status)
		}
	}
}

// The worker is a separate program; here the test plays it, writing the holding tables as its login would.
func TestAConfirmedListIsMergedIntoLeadsInBatches(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	_, job := e.startImport(alice, orgA, map[string]any{"filename": "owners.csv", "size": 100, "name": "Austin"})
	id := job["id"].(string)
	columns := `[{"idx":0,"header":"Owner","suggested":"name"},{"idx":1,"header":"Cell","suggested":"phone"},{"idx":2,"header":"Bathroom style","suggested":null}]`
	if _, err := e.admin.Exec(ctx, `UPDATE importing.jobs SET status = 'mapping', columns = $2::jsonb WHERE id = $1`, id, columns); err != nil {
		t.Fatal(err)
	}
	// Unused columns are only dropped after the person says so.
	if status, _ := e.call(alice, orgA, "PUT", "/api/v1/imports/"+id+"/mapping", map[string]any{"columns": []any{map[string]any{"idx": 0, "field": "name", "use": true}}}); status != 400 {
		t.Fatalf("an unanswered column: %d", status)
	}
	if status, _ := e.call(alice, orgA, "PUT", "/api/v1/imports/"+id+"/mapping", map[string]any{"columns": []any{
		map[string]any{"idx": 0, "field": "name", "use": true}, map[string]any{"idx": 1, "field": "phone", "use": true}, map[string]any{"idx": 2, "use": false}}}); status != 200 {
		t.Fatalf("mapping: %d", status)
	}
	for _, row := range []struct {
		no                 int
		name, phone, state string
		group              *int
		match              *string
	}{
		{1, "Pat Owner", "5550100", "clean", nil, nil}, {2, "Sam Seller", "5550101", "clean", nil, nil},
		{3, "Pat O.", "5550100", "near_duplicate", ptr(7), nil}, {4, "Pat Owner", "5550100", "near_duplicate", ptr(7), nil},
	} {
		if _, err := e.admin.Exec(ctx, `INSERT INTO importing.rows (job_id, row_no, fp, cells, name, phone, state, group_id) VALUES ($1, $2, sha256($3::bytea), ARRAY[$4], $4, $5, $6, $7)`,
			id, row.no, []byte(strconv.Itoa(row.no)), row.name, row.phone, row.state, row.group); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.admin.Exec(ctx, `UPDATE importing.rows SET address = '1 Main St', zip = '78701',
		source_data = '{"county":"Travis","living_area":"1,234","bedrooms":"3","bathrooms":"2","year_built":"1980"}'::jsonb
		WHERE job_id = $1 AND row_no = 1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admin.Exec(ctx, `UPDATE importing.jobs SET status = 'reviewing' WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/imports/"+id+"/merge", nil); status != 400 {
		t.Fatalf("merging before the repeats are decided: %d", status)
	}
	_, dups := e.call(alice, orgA, "GET", "/api/v1/imports/"+id+"/duplicates", nil)
	if dups["total"] != float64(2) {
		t.Fatalf("repeats listed: %v", dups)
	}
	_, decided := e.call(alice, orgA, "POST", "/api/v1/imports/"+id+"/duplicates", map[string]any{"decisions": []any{map[string]any{"group_id": 7, "action": "merge"}}})
	if decided["status"] != "ready" {
		t.Fatalf("after deciding: %v", decided)
	}
	e.call(alice, orgA, "POST", "/api/v1/imports/"+id+"/merge", nil)
	deadline := time.Now().Add(15 * time.Second)
	var state string
	for time.Now().Before(deadline) {
		_ = e.admin.QueryRow(ctx, `SELECT status FROM importing.jobs WHERE id = $1`, id).Scan(&state)
		if state == "done" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if state != "done" {
		t.Fatalf("merge finished as %q", state)
	}
	if status, _ := e.call(alice, orgA, "DELETE", "/api/v1/imports/"+id, nil); status != 400 {
		t.Fatalf("completed source rows were removable without deleting the list: %d", status)
	}
	// Three leads: two clean rows and one of the repeat pair; and the project holds them, visible through sync.
	_, snap := e.call(alice, orgA, "GET", "/sync/snapshot", nil)
	if n := len(snap["leads"].([]any)); n != 3 {
		t.Fatalf("leads after import: %d", n)
	}
	var feed int
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.change_log WHERE entity = 'lead'`).Scan(&feed)
	if feed != 3 {
		t.Fatalf("every new lead reaches the pull feed: %d", feed)
	}
	var linked int
	if err := e.admin.QueryRow(ctx, `SELECT count(*) FROM importing.rows WHERE job_id = $1 AND state = 'merged' AND lead_id IS NOT NULL`, id).Scan(&linked); err != nil || linked != 3 {
		t.Fatalf("completed source rows must link to leads: %d %v", linked, err)
	}
	var importedLead string
	if err := e.admin.QueryRow(ctx, `SELECT lead_id::text FROM importing.rows WHERE job_id = $1 AND row_no = 1`, id).Scan(&importedLead); err != nil {
		t.Fatal(err)
	}
	var details map[string]any
	if err := e.admin.QueryRow(ctx, `SELECT p.details FROM crm.leads l JOIN crm.properties p ON p.id = l.property_id WHERE l.id = $1`, importedLead).Scan(&details); err != nil {
		t.Fatal(err)
	}
	if details["county"] != "Travis" || details["year_built"] != "1980" || details["area"] == nil || details["beds"] == nil || details["baths"] == nil {
		t.Fatalf("recognized source details did not reach the property: %v", details)
	}
	e.want(e.op(alice, orgA, "lead.delete", map[string]any{"id": importedLead}), "applied")
	if err := e.admin.QueryRow(ctx, `SELECT count(*) FROM importing.rows WHERE job_id = $1 AND row_no = 1`, id).Scan(&linked); err != nil || linked != 0 {
		t.Fatalf("deleted lead retained its source row: %d %v", linked, err)
	}
}

func ptr[T any](v T) *T { return &v }

func TestFailedMergeCanResumeStoredRows(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	_, job := e.startImport(alice, orgA, map[string]any{"filename": "owners.csv", "size": 100})
	id := job["id"].(string)
	if _, err := e.admin.Exec(ctx, `INSERT INTO importing.rows (job_id, row_no, fp, cells, name, state)
		VALUES ($1, 1, sha256('owner'::bytea), ARRAY['Owner'], 'Owner', 'clean')`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admin.Exec(ctx, `UPDATE importing.jobs SET status = 'failed', progress = '{"phase":"merging","done":0}', error = 'Merge failed' WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	if status, _ := e.call(bob, orgA, "POST", "/api/v1/imports/"+id+"/retry", nil); status != 403 {
		t.Fatalf("another member could retry this upload: %d", status)
	}
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/imports/"+id+"/retry", nil); status != 200 {
		t.Fatalf("retry failed merge: %d", status)
	}
	deadline := time.Now().Add(15 * time.Second)
	var state string
	for time.Now().Before(deadline) {
		_ = e.admin.QueryRow(ctx, `SELECT status FROM importing.jobs WHERE id = $1`, id).Scan(&state)
		if state == "done" || state == "failed" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if state != "done" {
		t.Fatalf("retried merge finished as %q", state)
	}
	var linked int
	if err := e.admin.QueryRow(ctx, `SELECT count(*) FROM importing.rows WHERE job_id = $1 AND state = 'merged' AND lead_id IS NOT NULL`, id).Scan(&linked); err != nil || linked != 1 {
		t.Fatalf("stored row did not become a lead: %d %v", linked, err)
	}
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/imports/"+id+"/retry", nil); status != 400 {
		t.Fatalf("completed import could be retried: %d", status)
	}
}

func TestReadyModeHistoryLinksCallsAndPreservesDoNotCall(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	var id string
	err := e.admin.QueryRow(ctx, `INSERT INTO importing.jobs
		(org_id,user_id,name,filename,size,chunk_size,total_chunks,kind,source_timezone,status,report,progress)
		VALUES ($1,$2,'ReadyMode history','calls.csv',100,100,1,'readymode_calls','America/Chicago','call_ready',
		'{"valid_calls":2}'::jsonb,'{"phase":"call_ready","done":2}'::jsonb) RETURNING id::text`, orgA, alice).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	for i, outcome := range []string{"Voicemail", "Do not call"} {
		meaning := "voicemail"
		if i == 1 {
			meaning = "do_not_call"
		}
		data, _ := json.Marshal(map[string]any{"source_record_id": strconv.Itoa(i + 1), "agent": "Previous agent", "phone": "5125550100",
			"name": "Pat Owner", "address": "1 Main St", "city": "Austin", "region": "TX", "zip": "78701",
			"outcome": outcome, "code": "VM", "meaning": meaning, "occurred_at": "2026-10-15T20:00:00Z", "notes": "Historical note"})
		if _, err = e.admin.Exec(ctx, `INSERT INTO importing.rows (job_id,row_no,fp,cells,call_data)
			VALUES ($1,$2,sha256($3::bytea),ARRAY['source row'],$4::jsonb)`, id, i+1, []byte(strconv.Itoa(i)), data); err != nil {
			t.Fatal(err)
		}
	}
	if status, _ := e.call(bob, orgA, "POST", "/api/v1/imports/"+id+"/apply-calls", nil); status != 403 {
		t.Fatalf("caller imported another member's history: %d", status)
	}
	if status, reply := e.call(alice, orgA, "POST", "/api/v1/imports/"+id+"/apply-calls", nil); status != 200 {
		t.Fatalf("apply calls: %d %v", status, reply)
	}
	deadline := time.Now().Add(15 * time.Second)
	var state string
	for time.Now().Before(deadline) {
		_ = e.admin.QueryRow(ctx, `SELECT status FROM importing.jobs WHERE id = $1`, id).Scan(&state)
		if state == "done" || state == "failed" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if state != "done" {
		t.Fatalf("call import finished as %q", state)
	}
	var leads, calls, linked, blocked int
	_ = e.admin.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE do_not_call) FROM crm.leads WHERE source = 'ReadyMode'`).Scan(&leads, &blocked)
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.call_events WHERE import_job_id = $1`, id).Scan(&calls)
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM importing.rows WHERE job_id = $1 AND state = 'merged' AND lead_id IS NOT NULL`, id).Scan(&linked)
	if leads != 1 || calls != 2 || linked != 2 || blocked != 1 {
		t.Fatalf("history not linked safely: leads=%d calls=%d rows=%d dnc=%d", leads, calls, linked, blocked)
	}
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/imports/"+id+"/apply-calls", nil); status != 400 {
		t.Fatalf("completed history imported again: %d", status)
	}
	var again string
	err = e.admin.QueryRow(ctx, `INSERT INTO importing.jobs
		(org_id,user_id,name,filename,size,chunk_size,total_chunks,kind,status,report)
		VALUES ($1,$2,'Same export','calls.csv',100,100,1,'readymode_calls','call_ready','{"valid_calls":1}'::jsonb)
		RETURNING id::text`, orgA, alice).Scan(&again)
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.admin.Exec(ctx, `INSERT INTO importing.rows (job_id,row_no,fp,cells,call_data)
		SELECT $2,1,sha256('repeat'::bytea),ARRAY['source row'],call_data FROM importing.rows WHERE job_id = $1 AND row_no = 1`, id, again)
	if err != nil {
		t.Fatal(err)
	}
	e.call(alice, orgA, "POST", "/api/v1/imports/"+again+"/apply-calls", nil)
	deadline = time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		_ = e.admin.QueryRow(ctx, `SELECT status FROM importing.jobs WHERE id = $1`, again).Scan(&state)
		if state == "done" || state == "failed" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.call_events WHERE source = 'readymode'`).Scan(&calls)
	if state != "done" || calls != 2 {
		t.Fatalf("reimport duplicated history: status=%s calls=%d", state, calls)
	}
}

func TestCompletedSourceRowsStayWhileFailedHoldingRowsExpire(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	_, a := e.startImport(alice, orgA, map[string]any{"filename": "old.csv", "size": 100})
	_, b := e.startImport(alice, orgA, map[string]any{"filename": "fresh.csv", "size": 100})
	for i, job := range []map[string]any{a, b} {
		id := job["id"].(string)
		if _, err := e.admin.Exec(ctx, `INSERT INTO importing.rows (job_id, row_no, fp, cells) VALUES ($1, 1, sha256('x'::bytea), ARRAY['x'])`, id); err != nil {
			t.Fatal(err)
		}
		status := []string{"failed", "done"}[i]
		if _, err := e.admin.Exec(ctx, `UPDATE importing.jobs SET status = $2, updated_at = now() - interval '20 days' WHERE id = $1`, id, status); err != nil {
			t.Fatal(err)
		}
	}
	n, err := e.s.sweepRows(ctx)
	if err != nil || n != 1 {
		t.Fatalf("only a failed import's old row should go: %d %v", n, err)
	}
	var rows, jobs int
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM importing.rows`).Scan(&rows)
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM importing.jobs`).Scan(&jobs)
	if rows != 1 || jobs != 2 {
		t.Fatalf("completed source rows and both records must stay: rows=%d jobs=%d", rows, jobs)
	}
}

// The worker's own login, as it will be in production: an ordinary role given its rights by crm-core at start.
func TestTheWorkersLoginCanDoItsJobAndNothingElse(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	const role = "importer_test"
	if _, err := e.admin.Exec(ctx, `DROP ROLE IF EXISTS `+role); err != nil {
		// the role may own nothing in this database yet; a leftover from a failed run is removed below
		t.Log(err)
	}
	if _, err := e.admin.Exec(ctx, `CREATE ROLE `+role+` LOGIN PASSWORD 'worker-test'`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = e.admin.Exec(ctx, `REASSIGN OWNED BY `+role+` TO CURRENT_USER`)
		_, _ = e.admin.Exec(ctx, `DROP OWNED BY `+role)
		_, _ = e.admin.Exec(ctx, `DROP ROLE IF EXISTS `+role)
	})
	if err := e.s.st.grantImporter(ctx, role); err != nil {
		t.Fatal(err)
	}
	cfg, _ := pgx.ParseConfig(os.Getenv("CRM_TEST_DATABASE_URL"))
	cfg.User, cfg.Password = role, "worker-test"
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	// What the worker does: temp staging, rows in the holding table, the job's progress, matching against the lead view.
	steps := []string{
		`CREATE TEMP TABLE _stage (row_no bigint, cells text[], fp bytea)`,
		`INSERT INTO _stage VALUES (1, ARRAY['Pat'], sha256('a'::bytea))`,
		`SET cw.matching = 'on'`,
		`SELECT id, org_id, name, phone, email, addr_key FROM importing.lead_match LIMIT 1`,
		`SELECT importing.norm_phone('(512) 555-0100'), importing.addr_key('1 Main St', '78701')`,
		`SELECT count(*) FROM importing.jobs`,
		`UPDATE importing.jobs SET heartbeat_at = now() WHERE false`,
		`DELETE FROM importing.rows WHERE false`,
	}
	for _, sql := range steps {
		if _, err := conn.Exec(ctx, sql); err != nil {
			t.Fatalf("the worker must be able to run %q: %v", sql, err)
		}
	}
	// What it must never do: read or change the leads themselves, or the rest of the CRM, or change structure.
	for _, sql := range []string{
		`SELECT * FROM crm.leads`, `UPDATE crm.leads SET name = 'x'`, `DELETE FROM crm.leads`, `SELECT * FROM crm.people`,
		`SELECT * FROM crm.operations`, `INSERT INTO crm.leads (org_id, name) VALUES (gen_random_uuid(), 'x')`,
		`CREATE TABLE importing.evil (x int)`, `CREATE TABLE crm.evil (x int)`, `DROP TABLE importing.rows`,
	} {
		if _, err := conn.Exec(ctx, sql); err == nil {
			t.Fatalf("the worker must not be able to run %q", sql)
		}
	}
}

func TestPlatformStaffGetTheirOwnWorkspaceOnceAndOnlyAfterTheSecondStep(t *testing.T) {
	e := newEnv(t)
	e.seed()
	const staff, plain = "66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"
	e.rules.people_[staff] = peopleReply{UserID: staff, PlatformRole: "owner"}
	e.rules.people_[plain] = peopleReply{UserID: plain}
	// e.token signs with the second step passed, so a staff member without it is tested through the claims directly.
	_, me := e.call(staff, "", "GET", "/api/v1/me", nil)
	if me["organization_id"] != staffWorkspaceID(staff) || len(e.rules.opened) != 1 {
		t.Fatalf("the platform owner gets a workspace: %v opened=%v", me, e.rules.opened)
	}
	if len(me["capabilities"].([]any)) == 0 {
		t.Fatalf("and may work in it: %v", me)
	}
	e.call(staff, "", "GET", "/api/v1/me", nil)
	if len(e.rules.opened) != 1 {
		t.Fatalf("asking again opens nothing more: %v", e.rules.opened)
	}
	// Without the second step nothing is opened, even for the owner.
	const later = "88888888-8888-4888-8888-888888888888"
	e.rules.people_[later] = peopleReply{UserID: later, PlatformRole: "cofounder"}
	noSecondStep := e.fx.Sign("k1", "EdDSA", func(m map[string]any) {
		m["sub"] = later
		m["mfa"] = false
		m["name"] = "Later"
		m["email"] = "later@example.com"
	})
	req, _ := http.NewRequest("GET", e.ts.URL+"/api/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+noSecondStep)
	if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != 200 || len(e.rules.opened) != 1 {
		t.Fatalf("a staff member without the second step: %v %v opened=%v", res, err, e.rules.opened)
	}
	// An ordinary person without an invitation still gets nothing.
	_, me = e.call(plain, "", "GET", "/api/v1/me", nil)
	if me["organization_id"] != nil || len(e.rules.opened) != 1 {
		t.Fatalf("an uninvited person: %v opened=%v", me, e.rules.opened)
	}
	if id := staffWorkspaceID(staff); !validID(id) || id != staffWorkspaceID(staff) || id == staffWorkspaceID(plain) {
		t.Fatalf("the workspace id is a stable, valid id of its own: %s", id)
	}
}

// authz holds the team tree; the CRM's team list is its copy, with each team's manager, and a new team is made in authz first.
func TestTeamsComeFromTheAuthorizationService(t *testing.T) {
	e := newEnv(t)
	e.seed()
	const teamA, maya = "aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-0000000000aa"
	e.rules.mu.Lock()
	e.rules.teamList = map[string][]authzTeam{orgA: {{TeamID: teamA, Name: "Closers", ManagerID: maya}}}
	e.rules.mu.Unlock()
	res, raw := e.raw(alice, orgA, "GET", "/api/v1/admin/teams", nil, nil)
	var teams []map[string]any
	_ = json.Unmarshal(raw, &teams)
	if res != 200 || len(teams) != 1 || teams[0]["id"] != teamA || teams[0]["name"] != "Closers" || teams[0]["manager_id"] != maya {
		t.Fatalf("teams: %d %s", res, raw)
	}
	status, made := e.call(alice, orgA, "POST", "/api/v1/admin/teams", map[string]any{"name": "Callers"})
	if status != 200 || made["name"] != "Callers" {
		t.Fatalf("new team: %d %v", status, made)
	}
	e.rules.mu.Lock()
	inAuthz := len(e.rules.teamList[orgA]) == 2 && e.rules.teamList[orgA][1].TeamID == made["id"]
	e.rules.mu.Unlock()
	if !inAuthz {
		t.Error("a team made in the CRM is made in authz under the same id")
	}
	if res, raw = e.raw(carol, orgB, "GET", "/api/v1/admin/teams", nil, nil); strings.Contains(string(raw), "Closers") {
		t.Errorf("another workspace never sees these teams: %s", raw)
	}
}

// Each person's numbers come from what they did, and who sees whom follows the team tree: the owner sees everyone, a team
// manager the callers of the teams they run, a caller only themself.
func TestTeamMonitoringCountsWorkAndFollowsTheTree(t *testing.T) {
	e := newEnv(t)
	e.seed()
	const teamA, dave = "aaaaaaaa-0000-4000-8000-000000000001", "44444444-4444-4444-8444-444444444444"
	e.rules.mu.Lock()
	e.rules.roster[orgA] = []member{{UserID: alice, Roles: []string{"owner"}}, {UserID: bob, Roles: []string{"caller"}, TeamIDs: []string{teamA}},
		{UserID: dave, Roles: []string{"manager"}}, {UserID: missing, Roles: []string{"client"}}}
	e.rules.teamList = map[string][]authzTeam{orgA: {{TeamID: teamA, Name: "Tampa", ManagerID: dave}}}
	e.rules.grants[dave+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"team"}, TeamIDs: []string{teamA}, ManagedTeamIDs: []string{teamA}, Capabilities: []string{"edit", "call"}, Roles: []string{"manager"}}
	e.rules.people_[dave] = peopleReply{UserID: dave, Workspaces: []workspaceRoles{{OrgID: orgA, Roles: []string{"manager"}}}}
	e.rules.mu.Unlock()

	lead := newID(t)
	e.want(e.opWith(bob, orgA, "lead.create", map[string]any{"id": lead, "name": "Sam Seller", "phone": "555-0101"}, newID(t)), "applied")
	e.want(e.op(bob, orgA, "call.record", map[string]any{"lead_id": lead, "outcome": "Voicemail"}), "applied")
	e.want(e.op(bob, orgA, "call.record", map[string]any{"lead_id": lead, "outcome": "Callback", "callback_at": "2027-01-05T15:00:00Z"}), "applied")
	e.want(e.op(bob, orgA, "call.record", map[string]any{"lead_id": lead, "outcome": "Wrong number"}), "applied")
	e.want(e.op(bob, orgA, "lead.update", map[string]any{"id": lead, "changes": map[string]any{"stage": "Qualified"}, "base": map[string]any{}}), "applied")
	e.want(e.op(bob, orgA, "note.add", map[string]any{"lead_id": lead, "body": "Wants an offer."}), "applied")

	stats := func(user string) (int, map[string]any) {
		return e.call(user, orgA, "GET", "/api/v1/stats/members", nil)
	}
	totalsFor := func(out map[string]any, user string) map[string]any {
		for _, row := range out["totals"].([]any) {
			if r := row.(map[string]any); r["user_id"] == user {
				return r
			}
		}
		return nil
	}
	status, out := stats(alice)
	if status != 200 || len(out["people"].([]any)) != 3 {
		t.Fatalf("the owner sees everyone but clients: %d %v", status, out)
	}
	b := totalsFor(out, bob)
	if b == nil || b["dials"] != 3.0 || b["connects"] != 1.0 || b["callbacks"] != 1.0 || b["bad_numbers"] != 1.0 || b["qualified"] != 1.0 || b["notes"] != 1.0 || b["leads_held"] != 1.0 || b["last_active"] == nil {
		t.Fatalf("bob's numbers: %v", b)
	}
	if len(out["daily"].([]any)) != 1 {
		t.Errorf("one day of calls: %v", out["daily"])
	}
	_, out = stats(dave)
	if people := out["people"].([]any); len(people) != 2 || totalsFor(out, alice) != nil || totalsFor(out, bob) == nil {
		t.Errorf("a manager sees themself and their team's caller: %v", people)
	}
	_, out = stats(bob)
	if people := out["people"].([]any); len(people) != 1 || people[0].(map[string]any)["user_id"] != bob {
		t.Errorf("a caller sees only themself: %v", people)
	}
	if status, act := e.call(dave, orgA, "GET", "/api/v1/stats/members/"+bob+"/activity", nil); status != 200 || len(act["events"].([]any)) < 5 {
		t.Errorf("the manager follows their caller's activity: %d %v", status, act)
	}
	if status, _ := e.call(bob, orgA, "GET", "/api/v1/stats/members/"+alice+"/activity", nil); status != 403 {
		t.Errorf("a caller cannot follow the owner: %d", status)
	}
	if status, _ := e.call(alice, orgA, "GET", "/api/v1/stats/members?from=2026-01-01&to=2026-12-31", nil); status != 400 {
		t.Errorf("at most 93 days: %d", status)
	}
}

func TestStatsRangeDefaultsToTheLastSevenDays(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/v1/stats/members", nil)
	from, to, err := statsRange(r, time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC))
	if err != nil || from != "2026-11-09" || to != "2026-11-15" {
		t.Fatalf("%s %s %v", from, to, err)
	}
	for _, q := range []string{"from=2026-11-10&to=2026-11-01", "from=nope", "from=2026-01-01&to=2026-06-01"} {
		if _, _, err := statsRange(httptest.NewRequest("GET", "/x?"+q, nil), time.Now()); err == nil {
			t.Errorf("%s was accepted", q)
		}
	}
}

// The owner gives leads to a manager, the manager shares them with a caller of their team, and nobody gives leads outside
// their part of the tree.
func TestLeadsAreGivenDownTheTeamTree(t *testing.T) {
	e := newEnv(t)
	e.seed()
	const teamT, teamU = "aaaaaaaa-0000-4000-8000-0000000000a1", "aaaaaaaa-0000-4000-8000-0000000000a2"
	const dave, erin = "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"
	e.rules.mu.Lock()
	e.rules.roster[orgA] = []member{{UserID: alice, Roles: []string{"owner"}}, {UserID: bob, Roles: []string{"caller"}, TeamIDs: []string{teamT}},
		{UserID: dave, Roles: []string{"manager"}}, {UserID: erin, Roles: []string{"caller"}, TeamIDs: []string{teamU}}}
	e.rules.teamList = map[string][]authzTeam{orgA: {{TeamID: teamT, Name: "T", ManagerID: dave}, {TeamID: teamU, Name: "U"}}}
	e.rules.grants[dave+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"team", "own"}, TeamIDs: []string{teamT}, ManagedTeamIDs: []string{teamT}, Capabilities: []string{"edit", "assign", "call", "import"}, Roles: []string{"manager"}}
	e.rules.people_[dave] = peopleReply{UserID: dave, Workspaces: []workspaceRoles{{OrgID: orgA, Roles: []string{"manager"}}}}
	e.rules.mu.Unlock()
	for i := 0; i < 5; i++ {
		e.want(e.opWith(alice, orgA, "lead.create", map[string]any{"id": newID(t), "name": "Owner " + strconv.Itoa(i), "phone": "555-010" + strconv.Itoa(i)}, newID(t)), "applied")
	}
	if _, err := e.admin.Exec(context.Background(), `UPDATE crm.leads SET assignee_id = NULL`); err != nil {
		t.Fatal(err)
	}
	finish := func(user string, body map[string]any) map[string]any {
		t.Helper()
		status, run := e.call(user, orgA, "POST", "/api/v1/assignments", body)
		if status != 200 {
			t.Fatalf("start: %d %v", status, run)
		}
		for i := 0; i < 100 && run["status"] == "running"; i++ {
			time.Sleep(50 * time.Millisecond)
			_, run = e.call(user, orgA, "GET", "/api/v1/assignments/"+run["id"].(string), nil)
		}
		return run
	}
	count := func(where string) int {
		var n int
		if err := e.admin.QueryRow(context.Background(), `SELECT count(*) FROM crm.leads WHERE `+where).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	// Everyone sees who is in the agency (D54); emails only to the owner, admins and the person's own team leads (D371).
	if _, raw := e.raw(dave, orgA, "GET", "/api/v1/directory", nil, nil); !strings.Contains(string(raw), erin) || !strings.Contains(string(raw), bob) || !strings.Contains(string(raw), alice) {
		t.Errorf("the directory lists the whole agency: %s", raw)
	}
	var listed []map[string]any
	_, raw := e.raw(dave, orgA, "GET", "/api/v1/directory", nil, nil)
	_ = json.Unmarshal(raw, &listed)
	for _, p := range listed {
		_, shown := p["email"]
		if want := p["id"] == bob || p["id"] == dave; shown != want {
			t.Errorf("email of %v shown to a team lead: %v", p["id"], shown)
		}
	}
	// The owner sees who they can give leads to: everyone working, not clients.
	_, targets := e.call(alice, orgA, "GET", "/api/v1/assignments/targets", nil)
	if len(targets["targets"].([]any)) != 4 {
		t.Errorf("the owner can give leads to the 4 working people: %v", targets)
	}
	if run := finish(alice, map[string]any{"selection": map[string]any{"assignee": "unassigned"}, "to": []string{dave}}); run["status"] != "done" || run["assigned"] != 5.0 {
		t.Fatalf("owner to manager: %v", run)
	}
	if n := count(`assignee_id = '` + dave + `' AND team_id = '` + teamT + `'`); n != 5 {
		t.Fatalf("the manager holds the 5 leads, in the team they run: %d", n)
	}
	// The manager gives the first 2 to their caller.
	if run := finish(dave, map[string]any{"selection": map[string]any{"assignee": dave}, "to": []string{bob}, "limit": 2}); run["assigned"] != 2.0 {
		t.Fatalf("manager to caller: %v", run)
	}
	if n := count(`assignee_id = '` + bob + `' AND team_id = '` + teamT + `'`); n != 2 {
		t.Fatalf("the caller holds 2 leads in the team: %d", n)
	}
	// Not outside the tree: another team's caller, and a caller has no right to give leads at all.
	if status, _ := e.call(dave, orgA, "POST", "/api/v1/assignments", map[string]any{"selection": map[string]any{}, "to": []string{erin}}); status != 403 {
		t.Errorf("a manager cannot give leads to another team's caller: %d", status)
	}
	if status, _ := e.call(bob, orgA, "POST", "/api/v1/assignments", map[string]any{"selection": map[string]any{}, "to": []string{bob}}); status != 403 {
		t.Errorf("a caller cannot give leads: %d", status)
	}
	var one string
	_ = e.admin.QueryRow(context.Background(), `SELECT id::text FROM crm.leads WHERE assignee_id = $1 LIMIT 1`, dave).Scan(&one)
	if out := e.op(dave, orgA, "lead.assign", map[string]any{"ids": []string{one}, "assignee_id": erin}); out["status"] != "rejected" {
		t.Errorf("one lead to another team's caller is refused too: %v", out)
	}
	// Split evenly between two people.
	if run := finish(alice, map[string]any{"selection": map[string]any{}, "to": []string{dave, bob}}); run["assigned"] != 5.0 {
		t.Fatalf("split: %v", run)
	}
	if a, b := count(`assignee_id = '`+dave+`'`), count(`assignee_id = '`+bob+`'`); a+b != 5 || a < 2 || b < 2 {
		t.Errorf("shared in turn: %d and %d", a, b)
	}
}

// Search finds a lead by any part of its name, email or address, by its phone whatever the format, by city and ZIP from their start;
// a lead's details bring the lead back too.
func TestLeadSearchFindsByEveryWayPeopleType(t *testing.T) {
	e := newEnv(t)
	e.seed()
	id := newID(t)
	e.want(e.opWith(alice, orgA, "lead.create", map[string]any{"id": id, "name": "Patricia Flores", "phone": "(813) 555-0142", "email": "pat.flores@example.com",
		"address": "905 Baywood Drive", "city": "Tampa", "zip": "33610"}, newID(t)), "applied")
	e.want(e.opWith(alice, orgA, "lead.create", map[string]any{"id": newID(t), "name": "Someone Else", "phone": "727-555-9999", "address": "1 Main St", "city": "Austin", "zip": "78701"}, newID(t)), "applied")
	found := func(term string) []any {
		t.Helper()
		status, out := e.call(alice, orgA, "GET", "/api/v1/leads/search?q="+url.QueryEscape(term)+"&limit=20", nil)
		if status != 200 {
			t.Fatalf("%q: %d %v", term, status, out)
		}
		return out["leads"].([]any)
	}
	for _, term := range []string{"tricia", "FLORES", "8135550142", "813-555-0142", "555 0142", "baywood", "pat.flores", "Tam", "336"} {
		leads := found(term)
		if len(leads) != 1 || leads[0].(map[string]any)["id"] != id {
			t.Errorf("%q found %d leads", term, len(leads))
		}
	}
	if leads := found("555"); len(leads) != 2 {
		t.Errorf("digits common to both phones find both: %d", len(leads))
	}
	if leads := found("100%"); len(leads) != 0 {
		t.Errorf("a percent sign is a character, not a wildcard: %d", len(leads))
	}
	status, details := e.call(alice, orgA, "GET", "/api/v1/leads/"+id+"/details", nil)
	if status != 200 || len(details["leads"].([]any)) != 1 {
		t.Fatalf("details carry the lead: %d %v", status, details["leads"])
	}
}

// A person's account picture, sent by their CRM, reaches everyone's team list; anything but a small image or an https address is refused.
func TestAPersonsPictureReachesTheTeam(t *testing.T) {
	e := newEnv(t)
	e.seed()
	pic := "data:image/png;base64,iVBORw0KGgo="
	if status, out := e.call(bob, orgA, "PUT", "/api/v1/me/picture", map[string]any{"avatar": pic}); status != 200 {
		t.Fatalf("set picture: %d %v", status, out)
	}
	if status, _ := e.call(bob, orgA, "PUT", "/api/v1/me/picture", map[string]any{"avatar": "javascript:alert(1)"}); status != 400 {
		t.Errorf("a script address is not a picture: %d", status)
	}
	_, raw := e.raw(alice, orgA, "GET", "/api/v1/directory", nil, nil)
	var people []map[string]any
	_ = json.Unmarshal(raw, &people)
	for _, person := range people {
		if person["id"] == bob && person["avatar"] != pic {
			t.Errorf("the team sees bob's picture: %v", person)
		}
	}
}

// TestWorkCannotBeGivenPastTheTree: an operation sent by hand (the browser console) cannot give a task or a lead to someone the sender
// does not manage, nor put a lead in a team that is not theirs.
func TestWorkCannotBeGivenPastTheTree(t *testing.T) {
	e := newEnv(t)
	e.seed()
	const teamT, teamU = "aaaaaaaa-0000-4000-8000-0000000000b1", "aaaaaaaa-0000-4000-8000-0000000000b2"
	const dave, erin = "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"
	e.rules.mu.Lock()
	e.rules.roster[orgA] = []member{{UserID: alice, Roles: []string{"owner"}}, {UserID: bob, Roles: []string{"caller"}, TeamIDs: []string{teamT}},
		{UserID: dave, Roles: []string{"manager"}}, {UserID: erin, Roles: []string{"caller"}, TeamIDs: []string{teamU}}}
	e.rules.teamList = map[string][]authzTeam{orgA: {{TeamID: teamT, Name: "T", ManagerID: dave}, {TeamID: teamU, Name: "U"}}}
	e.rules.grants[dave+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"team", "own"}, TeamIDs: []string{teamT}, ManagedTeamIDs: []string{teamT}, Capabilities: []string{"edit", "assign", "call", "import"}, Roles: []string{"manager"}}
	e.rules.mu.Unlock()
	if status, _ := e.call(alice, orgA, "GET", "/api/v1/admin/teams", nil); status != 200 {
		t.Fatalf("teams: %d", status)
	}
	// A caller gives a task only to themself.
	e.want(e.opWith(bob, orgA, "task.create", map[string]any{"title": "Mine"}, ""), "applied")
	e.want(e.opWith(bob, orgA, "task.create", map[string]any{"title": "Yours", "assignee_id": erin}, ""), "rejected")
	task := e.want(e.opWith(bob, orgA, "task.create", map[string]any{"title": "Moved later"}, ""), "applied")
	e.want(e.opWith(bob, orgA, "task.update", map[string]any{"id": task["id"], "changes": map[string]any{"assignee_id": alice}, "base": map[string]any{"assignee_id": bob}}, ""), "rejected")
	// A manager gives a task to their own caller, not to another team's.
	e.want(e.opWith(dave, orgA, "task.create", map[string]any{"title": "For Bob", "assignee_id": bob}, ""), "applied")
	e.want(e.opWith(dave, orgA, "task.create", map[string]any{"title": "For Erin", "assignee_id": erin}, ""), "rejected")
	// A lead is made for someone in the tree only, and only in a team the maker may use.
	e.want(e.opWith(dave, orgA, "lead.create", map[string]any{"id": newID(t), "name": "For Erin", "assignee_id": erin}, ""), "rejected")
	e.want(e.opWith(bob, orgA, "lead.create", map[string]any{"id": newID(t), "name": "Into U", "team_id": teamU}, ""), "rejected")
	lead := newID(t)
	e.want(e.opWith(dave, orgA, "lead.create", map[string]any{"id": lead, "name": "For Bob", "assignee_id": bob}, ""), "applied")
	var team string
	if err := e.admin.QueryRow(context.Background(), `SELECT coalesce(team_id::text, '') FROM crm.leads WHERE id = $1`, lead).Scan(&team); err != nil || team != teamT {
		t.Fatalf("a lead made for Bob is in his team: %q %v", team, err)
	}
	// Giving leads cannot move them into a team the giver does not run.
	e.want(e.opWith(dave, orgA, "lead.assign", map[string]any{"ids": []string{lead}, "assignee_id": bob, "team_id": teamU}, ""), "rejected")
	e.want(e.opWith(alice, orgA, "lead.assign", map[string]any{"ids": []string{lead}, "assignee_id": erin}, ""), "applied")
}

func TestListsArePickedByWhoseLeadsTheyHold(t *testing.T) {
	e := newEnv(t)
	e.seed()
	const teamA, dave = "aaaaaaaa-0000-4000-8000-000000000201", "44444444-4444-4444-8444-444444444444"
	e.rules.mu.Lock()
	e.rules.grants[dave+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"team"}, TeamIDs: []string{teamA}, TeamScopeIDs: []string{teamA}, ManagedTeamIDs: []string{teamA}, Capabilities: []string{"edit", "call"}, Roles: []string{"manager"}}
	e.rules.people_[dave] = peopleReply{UserID: dave, Workspaces: []workspaceRoles{{OrgID: orgA, Roles: []string{"manager"}}}}
	e.rules.mu.Unlock()
	if _, err := e.admin.Exec(context.Background(), `INSERT INTO crm.teams (id, org_id, name) VALUES ($1, $2, 'Tampa')`, teamA, orgA); err != nil {
		t.Fatal(err)
	}
	ids := map[string]string{}
	for _, name := range []string{"Bob's", "Team's", "Nobody's"} {
		_, p := e.call(alice, orgA, "POST", "/api/v1/projects", map[string]any{"name": name})
		ids[name] = p["id"].(string)
	}
	for _, l := range []struct{ project, team, assignee any }{{ids["Bob's"], nil, bob}, {ids["Team's"], teamA, nil}, {ids["Nobody's"], nil, nil}} {
		if _, err := e.admin.Exec(context.Background(), `INSERT INTO crm.leads (org_id, name, project_id, team_id, assignee_id) VALUES ($1, 'Lead', $2, $3, $4)`,
			orgA, l.project, l.team, l.assignee); err != nil {
			t.Fatal(err)
		}
	}
	names := func(user string) []string {
		status, raw := e.raw(user, orgA, "GET", "/api/v1/projects", nil, nil)
		var rows []map[string]any
		if err := json.Unmarshal(raw, &rows); status != 200 || err != nil {
			t.Fatalf("lists for %s: %d %s", user, status, raw)
		}
		out := []string{}
		for _, r := range rows {
			out = append(out, r["name"].(string))
		}
		return out
	}
	if got := strings.Join(names(alice), ","); got != "Bob's,Nobody's,Team's" {
		t.Fatalf("the owner sees every list: %s", got)
	}
	if got := strings.Join(names(bob), ","); got != "Bob's" {
		t.Fatalf("a caller sees the lists holding their leads: %s", got)
	}
	if got := strings.Join(names(dave), ","); got != "Team's" {
		t.Fatalf("a team leader sees the lists holding the team's leads: %s", got)
	}
}
