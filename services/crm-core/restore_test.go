package crm

import (
	"context"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Step 41: staff ask to restore one agency from a backup; its owner confirms with the second step; the run replaces that agency's rows
// with the copy's and nothing of another agency; blocks made since the backup stay; leads deleted on request go again; devices start
// over (D297, D370).
func TestRestoreOneAgencyFromACopy(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	// The restore copy: a second database with the same tables, as pg_restore would leave it.
	appURL, adminURL := os.Getenv("CRM_TEST_DATABASE_URL"), os.Getenv("CRM_TEST_ADMIN_URL")
	withDB := func(raw, db string) string {
		u, _ := url.Parse(raw)
		u.Path = "/" + db
		return u.String()
	}
	var exists bool
	_ = e.admin.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'crm_core_copy')`).Scan(&exists)
	if !exists {
		// The app's role name, without the password the address may carry (postgres://crm_app:pass@host/db).
		app, err := url.Parse(appURL)
		if err != nil || app.User == nil {
			t.Fatalf("CRM_TEST_DATABASE_URL has no user: %v", err)
		}
		if _, err := e.admin.Exec(ctx, `CREATE DATABASE crm_core_copy OWNER `+pgx.Identifier{app.User.Username()}.Sanitize()); err != nil {
			t.Fatal(err)
		}
	}
	copyAdmin, err := pgx.Connect(ctx, withDB(adminURL, "crm_core_copy"))
	if err != nil {
		t.Fatal(err)
	}
	defer copyAdmin.Close(ctx)
	if _, err := copyAdmin.Exec(ctx, `DROP SCHEMA IF EXISTS crm CASCADE; DROP SCHEMA IF EXISTS importing CASCADE`); err != nil {
		t.Fatal(err)
	}
	copyStore, err := openStore(ctx, withDB(appURL, "crm_core_copy"))
	if err != nil {
		t.Fatal(err)
	}
	copyStore.close()
	e.s.cfg.restoreCopyURL = withDB(appURL, "crm_core_copy")

	const kept, gone, forgotten, other = "aaaaaaaa-0000-4000-8000-000000004101", "aaaaaaaa-0000-4000-8000-000000004102", "aaaaaaaa-0000-4000-8000-000000004103", "bbbbbbbb-0000-4000-8000-000000004104"
	// The backup: two of agency A's leads and a note.
	if _, err := copyAdmin.Exec(ctx, `INSERT INTO crm.orgs (id, name) VALUES ($1, 'A') ON CONFLICT DO NOTHING`, orgA); err != nil {
		t.Fatal(err)
	}
	if _, err := copyAdmin.Exec(ctx, `INSERT INTO crm.leads (id, org_id, name, phone) VALUES ($1, $3, 'Pat Before', '512-555-4101'), ($2, $3, 'Asked To Go', '512-555-4103')`, kept, forgotten, orgA); err != nil {
		t.Fatal(err)
	}
	if _, err := copyAdmin.Exec(ctx, `INSERT INTO crm.notes (org_id, lead_id, body) VALUES ($1, $2, 'From the backup')`, orgA, kept); err != nil {
		t.Fatal(err)
	}
	// Today: the lead renamed, a new lead, one deleted on request, a new block, and another agency's lead.
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": kept, "name": "Pat After", "phone": "512-555-4101"}), "applied")
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": gone, "name": "Since The Backup", "phone": "512-555-4102"}), "applied")
	if _, err := e.admin.Exec(ctx, `INSERT INTO crm.number_blocks (org_id, phone_key, calls, texts, reason) VALUES ($1, '5125554103', true, true, 'deleted_on_request')`, orgA); err != nil {
		t.Fatal(err)
	}
	e.call(alice, orgA, "POST", "/api/v1/blocks", map[string]any{"phone": "512-555-4199"})
	e.rules.grants[carol+"|"+orgB] = owner()
	e.want(e.op(carol, orgB, "lead.create", map[string]any{"id": other, "name": "Other Agency", "phone": "512-555-4104"}), "applied")

	// Staff ask; only the owner confirms, with the second step; then staff run it.
	const boss = "66666666-6666-4666-8666-666666666666"
	e.rules.people_[boss] = peopleReply{UserID: boss, PlatformRole: "owner"}
	if code, _ := e.call(alice, orgA, "POST", "/api/v1/platform/restores", map[string]any{"org_id": orgA, "backup_date": "2026-11-17", "reason": "Leads lost"}); code != 403 {
		t.Fatalf("an agency owner asks as staff: %d", code)
	}
	code, asked := e.call(boss, "", "POST", "/api/v1/platform/restores", map[string]any{"org_id": orgA, "backup_date": "2026-11-17", "reason": "A bad import overwrote names"})
	if code != 201 {
		t.Fatalf("ask: %d %v", code, asked)
	}
	id := asked["id"].(string)
	if code, _ := e.call(boss, "", "POST", "/api/v1/platform/restores/"+id+"/run", nil); code != 409 {
		t.Fatalf("run before the owner confirmed: %d", code)
	}
	g := owner()
	g.Roles = []string{"owner"}
	e.rules.grants[alice+"|"+orgA] = g
	if code, _ := e.call(bob, orgA, "POST", "/api/v1/restores/"+id+"/confirm", nil); code != 403 {
		t.Fatalf("a caller confirms: %d", code)
	}
	if code, _ := e.call(alice, orgA, "POST", "/api/v1/restores/"+id+"/confirm", nil); code != 200 {
		t.Fatalf("confirm: %d", code)
	}
	code, ran := e.call(boss, "", "POST", "/api/v1/platform/restores/"+id+"/run", nil)
	if code != 200 || ran["status"] != "done" {
		t.Fatalf("run: %d %v", code, ran)
	}

	names := map[string]string{}
	rows, _ := e.admin.Query(ctx, `SELECT id::text, name FROM crm.leads`)
	for rows.Next() {
		var id, name string
		_ = rows.Scan(&id, &name)
		names[id] = name
	}
	rows.Close()
	if names[kept] != "Pat Before" || names[gone] != "" || names[forgotten] != "" || names[other] != "Other Agency" {
		t.Fatalf("leads after the restore: %v", names)
	}
	var notes, blocks int
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.notes WHERE lead_id = $1 AND body = 'From the backup'`, kept).Scan(&notes)
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.number_blocks WHERE org_id = $1 AND lifted_at IS NULL`, orgA).Scan(&blocks)
	if notes != 1 || blocks != 2 {
		t.Fatalf("notes %d, blocks %d", notes, blocks)
	}
	// A device that synced before the restore starts over.
	if _, pulled := e.call(alice, orgA, "GET", "/sync/pull?cursor=1&access_revision="+strings.TrimSpace(revisionOf(e, alice, orgA)), nil); pulled["reset"] != true {
		t.Fatalf("a device after the restore: %v", pulled)
	}
	var status string
	_ = e.admin.QueryRow(ctx, `SELECT status FROM crm.agency_restores WHERE id = $1`, id).Scan(&status)
	if status != "done" {
		t.Fatalf("the record: %s", status)
	}
}

func revisionOf(e *env, user, org string) string {
	_, me := e.call(user, org, "GET", "/api/v1/me", nil)
	v, _ := me["access_revision"].(float64)
	return strconv.FormatInt(int64(v), 10)
}
