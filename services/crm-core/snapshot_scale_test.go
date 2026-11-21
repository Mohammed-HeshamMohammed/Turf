package crm

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"
)

// How long the first load of the records takes in a workspace with many leads. Slow, so it runs only when SNAPSHOT_SCALE=<leads> is set:
//
//	SNAPSHOT_SCALE=500000 go test -run TestSnapshotAtScale -v
func TestSnapshotAtScale(t *testing.T) {
	var leads int
	if _, err := fmt.Sscan(os.Getenv("SNAPSHOT_SCALE"), &leads); err != nil || leads < 1 {
		t.Skip("set SNAPSHOT_SCALE to the number of leads to try")
	}
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	e.call(alice, orgA, "GET", "/sync/snapshot?limit=1", nil) // the workspace is made when it is first used
	if _, err := e.admin.Exec(ctx, fmt.Sprintf(`INSERT INTO crm.projects (id, org_id, name) VALUES ('33333333-3333-4333-8333-333333333333', '%s', 'big')`, orgA)); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if _, err := e.admin.Exec(ctx, fmt.Sprintf(`INSERT INTO crm.leads (org_id, project_id, name, phone, email, updated_at)
		SELECT '%s', '33333333-3333-4333-8333-333333333333', 'Lead ' || g, (2125550000 + g)::text, '', now() - g * interval '1 second' FROM generate_series(1, %d) g`, orgA, leads)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admin.Exec(ctx, `ANALYZE crm.leads`); err != nil {
		t.Fatal(err)
	}
	t.Logf("%d leads inserted in %.1fs", leads, time.Since(started).Seconds())
	for _, path := range []string{"/sync/snapshot?limit=250", "/sync/snapshot?limit=250", "/sync/snapshot"} {
		started = time.Now()
		status, out := e.call(alice, orgA, "GET", path, nil)
		t.Logf("%-28s %d  %.1fs  leads %d  total %v", path, status, time.Since(started).Seconds(), len(out["leads"].([]any)), out["leads_total"])
	}
}
